/**
 * The promotion desk — the CLIENT's console, as opposed to the platform team's.
 *
 * These procedures are deliberately separate from the technical routers rather
 * than extra filters bolted onto `entries.list` and `submissions.list`. The desk
 * asks different questions ("which shop, which town, how many packs, how many
 * receipts has this person sent?") and answers them in the promotion's language,
 * not the pipeline's. Overloading the technical list procedures would have made
 * both worse.
 *
 * Queries (the fourth screen) is NOT here: the existing `support.*` procedures
 * already own the handoff queue, the transcript, claim/release and send, and
 * they are guarded by `support.read` / `support.handoff`, which both promotion
 * roles now hold. Duplicating them would have meant two handoff implementations
 * that could disagree.
 *
 * Deciding an entry is likewise the existing `entries.disqualify` /
 * `entries.reinstate`, so the desk goes through the same dual-control,
 * audit-writing path the technical console does. Only `promotion_admin` holds
 * `entry.disqualify`; an assistant's button simply is not rendered, and the
 * procedure would refuse them anyway.
 */
import { z } from "zod";
import { router, guard } from "../trpc.ts";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import * as schema from "@promo/db/schema";

const { entries, submissions, participants, outlets, canonicalReceipts, campaignPeriods, conversations } = schema;

/**
 * Packs the RULES counted, not what was printed on the paper.
 *
 * It comes from the decision the participant was actually given: the
 * `qualifying_product` rule result on the most recent extraction, which records
 * `primaryPacks` as its evidence. There is no column for it — storing a second
 * copy would let the two drift, and the rule result is the thing that was
 * actually acted on.
 *
 * It is NULL in two different situations that must not be conflated:
 * the photo could not be read at all (no extraction), and no qualifying product
 * was found on a receipt that was read (the rule fires with no `primaryPacks`).
 * Both mean "we cannot say", which is not the same statement as "they bought
 * none" — so a filter of "at least 1 pack" excludes both, and the desk shows
 * "not read" rather than 0.
 */
const packsExpr = sql<number | null>`(
  select (elem->'evidence'->>'primaryPacks')::int
  from ${schema.extractions} x
  cross join lateral jsonb_array_elements(x.rule_results) elem
  where x.submission_id = ${submissions.id} and elem->>'rule' = 'qualifying_product'
  order by x.attempt_no desc
  limit 1
)`;

/**
 * Every receipt this person has sent to this campaign, whatever happened to it
 * — not just the ones that earned an entry. It is the number you want when a
 * name keeps appearing: a high count with few entries is worth a look.
 */
const receiptsByPersonExpr = sql<number>`(
  select count(*)::int from ${submissions} s2
  where s2.participant_id = ${submissions.participantId} and s2.campaign_id = ${submissions.campaignId}
)`;

/** The categories the desk shows, in the promotion's language rather than the pipeline's. */
const OUTCOME = {
  qualified: "Earned an entry",
  review: "Needs a look",
  not_qualified: "Did not qualify",
  duplicate: "Already claimed",
  reupload: "Photo unreadable",
  received: "Still being read",
  processing: "Still being read",
  delayed: "Still being read",
} as const;

const filters = z.object({
  campaignId: z.string().optional(),
  period: z.string().optional(),
  retailer: z.string().optional(),
  outletId: z.string().optional(),
  town: z.string().optional(),
  region: z.string().optional(),
  packsMin: z.number().int().min(0).optional(),
  packsMax: z.number().int().min(0).optional(),
  receiptsMin: z.number().int().min(0).optional(),
  receiptsMax: z.number().int().min(0).optional(),
  search: z.string().max(80).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
type Filters = z.infer<typeof filters>;

/** Resolve the campaign the desk is looking at: the one asked for, else the current one. */
async function campaignOf(ctx: { app: { campaigns: { get(id: string): Promise<{ id: string } | null | undefined>; current(): Promise<{ id: string } | null | undefined> } } }, id?: string) {
  const c = id ? await ctx.app.campaigns.get(id) : await ctx.app.campaigns.current();
  return c?.id ?? null;
}

/** Conditions shared by both lists. `outlet` is the outlet the purchase was made at. */
function whereFrom(f: Filters, campaignId: string) {
  const c = [eq(submissions.campaignId, campaignId)];
  if (f.period) c.push(eq(submissions.periodCode, f.period));
  if (f.retailer) c.push(eq(outlets.retailer, f.retailer));
  if (f.outletId) c.push(eq(outlets.id, f.outletId));
  if (f.town) c.push(eq(outlets.town, f.town));
  if (f.region) c.push(eq(outlets.region, f.region));
  if (f.packsMin != null) c.push(sql`${packsExpr} >= ${f.packsMin}`);
  if (f.packsMax != null) c.push(sql`${packsExpr} <= ${f.packsMax}`);
  if (f.receiptsMin != null) c.push(sql`${receiptsByPersonExpr} >= ${f.receiptsMin}`);
  if (f.receiptsMax != null) c.push(sql`${receiptsByPersonExpr} <= ${f.receiptsMax}`);
  if (f.search) {
    // Name or number. The stored channel uid is a full phone number, so a search
    // for the last four digits finds the person a masked list showed you.
    const like = `%${f.search.trim().toLowerCase()}%`;
    c.push(sql`(lower(${participants.firstName}) like ${like} or lower(${participants.surname}) like ${like}
      or lower(${participants.firstName} || ' ' || ${participants.surname}) like ${like} or ${participants.channelUid} like ${like})`);
  }
  return and(...c);
}

const person = {
  participantId: participants.id,
  name: sql<string>`trim(${participants.firstName} || ' ' || ${participants.surname})`,
  phone: sql<string>`'***' || right(${participants.channelUid}, 4)`,
};
const place = { retailer: outlets.retailer, branch: outlets.branch, town: outlets.town, region: outlets.region };

export const promotionRouter = router({
  /** Who the person at the desk is, and the one thing that differs between the two roles. */
  me: guard("entry.read").query(({ ctx }) => ({
    name: ctx.user.name,
    email: ctx.user.email,
    canDecideEntries: ctx.user.roles.includes("promotion_admin"),
    isAssistant: ctx.user.roles.includes("promotion_assistant") && !ctx.user.roles.includes("promotion_admin"),
  })),

  /** Today: is anything waiting? Two of these are jobs, the rest are the shape of the week. */
  today: guard("report.read").input(z.object({ campaignId: z.string().optional() }).default({})).query(async ({ ctx, input }) => {
    const campaignId = await campaignOf(ctx, input.campaignId);
    if (!campaignId) return { campaignId: null, entries: 0, byOutcome: {}, waitingReview: 0, waitingQueries: 0, participants: 0 };
    const byStatus = await ctx.app.db.select({ status: submissions.status, n: sql<number>`count(*)::int` })
      .from(submissions).where(eq(submissions.campaignId, campaignId)).groupBy(submissions.status);
    const [{ n: entriesActive } = { n: 0 }] = await ctx.app.db.select({ n: sql<number>`count(*)::int` })
      .from(entries).where(and(eq(entries.campaignId, campaignId), eq(entries.status, "active")));
    const [{ n: people } = { n: 0 }] = await ctx.app.db.select({ n: sql<number>`count(distinct ${submissions.participantId})::int` })
      .from(submissions).where(eq(submissions.campaignId, campaignId));
    const queries = await ctx.app.db.select({ n: sql<number>`count(*)::int` }).from(conversations)
      .where(and(eq(conversations.campaignId, campaignId), sql`${conversations.handoffOwner} is not null`));
    return {
      campaignId,
      entries: entriesActive,
      participants: people,
      byOutcome: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
      waitingReview: byStatus.find((r) => r.status === "review")?.n ?? 0,
      waitingQueries: queries[0]?.n ?? 0,
    };
  }),

  /** The options for each filter, taken from what this campaign actually has. */
  filters: guard("entry.read").input(z.object({ campaignId: z.string().optional() }).default({})).query(async ({ ctx, input }) => {
    const campaignId = await campaignOf(ctx, input.campaignId);
    if (!campaignId) return { campaignId: null, periods: [], retailers: [], outlets: [], towns: [], regions: [], outcomes: OUTCOME };
    const periods = await ctx.app.db.select({ code: campaignPeriods.code, label: campaignPeriods.label })
      .from(campaignPeriods).where(eq(campaignPeriods.campaignId, campaignId)).orderBy(campaignPeriods.startsAt);
    const shops = await ctx.app.db.selectDistinct({ id: outlets.id, code: outlets.code, retailer: outlets.retailer, branch: outlets.branch, town: outlets.town, region: outlets.region })
      .from(outlets).innerJoin(schema.campaignOutlets, eq(schema.campaignOutlets.outletId, outlets.id))
      .where(eq(schema.campaignOutlets.campaignId, campaignId)).orderBy(outlets.retailer, outlets.branch);
    const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort();
    return {
      campaignId,
      periods: periods.map((p) => ({ code: p.code, label: p.label ?? p.code })),
      retailers: uniq(shops.map((s) => s.retailer)),
      outlets: shops.map((s) => ({ id: s.id, retailer: s.retailer, branch: s.branch, town: s.town, region: s.region })),
      towns: uniq(shops.map((s) => s.town)),
      regions: uniq(shops.map((s) => s.region)),
      outcomes: OUTCOME,
    };
  }),

  /**
   * Entries: every entry that has been earned. One entry is one purchase that
   * met the rules. The outlet is joined through the CANONICAL receipt where one
   * exists — that is the outlet the purchase was actually identified at, rather
   * than the one the participant picked from a menu.
   */
  entries: guard("entry.read").input(filters).query(async ({ ctx, input }) => {
    const campaignId = await campaignOf(ctx, input.campaignId);
    if (!campaignId) return { rows: [], next: null };
    const rows = await ctx.app.db.select({
      entryId: entries.id, status: entries.status, units: entries.units, period: entries.periodCode, awardedAt: entries.awardedAt,
      submissionId: submissions.id, reference: submissions.reference,
      packs: packsExpr, receiptsByPerson: receiptsByPersonExpr, ...person, ...place,
    }).from(entries)
      .innerJoin(submissions, eq(submissions.id, entries.submissionId))
      .innerJoin(participants, eq(participants.id, entries.participantId))
      .leftJoin(canonicalReceipts, eq(canonicalReceipts.id, entries.canonicalReceiptId))
      .leftJoin(outlets, sql`${outlets.id} = coalesce(${canonicalReceipts.outletId}, ${submissions.selectedOutletId})`)
      .where(whereFrom(input, campaignId))
      .orderBy(desc(entries.awardedAt)).limit(input.limit).offset(input.offset);
    return { rows, next: rows.length === input.limit ? input.offset + input.limit : null };
  }),

  /**
   * Submissions: every receipt that was sent in, whatever happened to it. This is
   * the screen that answers "why did this one not count?" — an entry only exists
   * for the receipts that qualified, so a list of entries can never explain the
   * rest.
   */
  submissions: guard("submission.read").input(filters.extend({ outcome: z.string().optional() })).query(async ({ ctx, input }) => {
    const campaignId = await campaignOf(ctx, input.campaignId);
    if (!campaignId) return { rows: [], next: null };
    const where = input.outcome
      ? and(whereFrom(input, campaignId), input.outcome === "pending"
        ? inArray(submissions.status, ["received", "processing", "delayed"])
        : eq(submissions.status, input.outcome))
      : whereFrom(input, campaignId);
    const rows = await ctx.app.db.select({
      submissionId: submissions.id, reference: submissions.reference, status: submissions.status, reason: submissions.reasonCode,
      period: submissions.periodCode, sentAt: submissions.intakeAt, decidedAt: submissions.decidedAt,
      entryId: entries.id, entryStatus: entries.status,
      packs: packsExpr, receiptsByPerson: receiptsByPersonExpr, ...person, ...place,
    }).from(submissions)
      .innerJoin(participants, eq(participants.id, submissions.participantId))
      .leftJoin(canonicalReceipts, eq(canonicalReceipts.id, submissions.canonicalReceiptId))
      .leftJoin(outlets, sql`${outlets.id} = coalesce(${canonicalReceipts.outletId}, ${submissions.selectedOutletId})`)
      .leftJoin(entries, eq(entries.submissionId, submissions.id))
      .where(where)
      .orderBy(desc(submissions.intakeAt)).limit(input.limit).offset(input.offset);
    return { rows, next: rows.length === input.limit ? input.offset + input.limit : null };
  }),
});
