import crypto from "node:crypto";
import { eq, and, inArray, desc, asc, sql, lt, notInArray } from "drizzle-orm";
import { schema, type Db, type DbOrTx } from "@promo/db";
import { newId } from "../util/ids.ts";
import { conflict, notFound, invalid } from "../util/errors.ts";
import { sha256, timingEqual } from "../util/crypto.ts";
import { render } from "../conversation/copy.ts";
import type { AuditService } from "../audit.ts";
import type { CampaignService } from "../campaign/service.ts";
import type { ParticipantService } from "../participant/service.ts";
import type { OutboxService } from "../ops/outbox.ts";
import type { CrmEmitter } from "../conversation/engine.ts";
import type { Plan } from "../draw/engine.ts";

const { winners, winnerEvents, draws, entries, participants, campaignPeriods } = schema;
export type Winner = typeof winners.$inferSelect;
/** Lifecycle: selected -> notified -> verified -> accepted -> collected, with explicit side paths. Publication is a separate axis. */
export const TRANSITIONS: Record<string, string[]> = {
  selected: ["notified", "unreachable", "ineligible", "expired", "replaced", "declined"], notified: ["verified", "unreachable", "declined", "ineligible", "expired", "disputed", "replaced"],
  verified: ["accepted", "declined", "ineligible", "expired", "disputed", "replaced"], accepted: ["collected", "expired", "ineligible", "disputed", "replaced"], disputed: ["verified", "ineligible", "replaced"],
  unreachable: ["notified", "expired", "replaced"], collected: [], declined: ["replaced"], ineligible: ["replaced"], expired: ["replaced"], replaced: [],
};
const hashToken = (t: string) => sha256(`claim:${t}`);

export class WinnerService {
  constructor(private db: Db, private deps: { campaigns: CampaignService; participants: ParticipantService; audit: AuditService; outbox: OutboxService; crm?: CrmEmitter | null; claimDays: number }) {}
  private async draw(id: string) { const [d] = await this.db.select({ d: draws, periodCode: campaignPeriods.code, periodLabel: campaignPeriods.label }).from(draws).innerJoin(campaignPeriods, eq(campaignPeriods.id, draws.periodId)).where(eq(draws.id, id)); return d ?? null; }
  async get(id: string) { const [w] = await this.db.select().from(winners).where(eq(winners.id, id)); return w ?? null; }
  private displayName(p: { firstName: string; surname: string } | null) { return p ? `${p.firstName} ${(p.surname || "").slice(0, 1)}${p.surname ? "." : ""}`.trim() : null; }

  /** Materialise winner rows (and alternates as records) from an APPROVED draw's stored output. Idempotent. */
  async materialise(drawId: string, actorId: string) {
    const d = await this.draw(drawId); if (!d) throw notFound("draw"); if (!["approved", "published"].includes(d.d.status)) throw conflict("winners exist only for approved draws");
    const existing = await this.db.select().from(winners).where(eq(winners.drawId, drawId)); if (existing.length) return { created: 0, idempotent: true };
    const out = d.d.output as { winners: Array<{ position: number; entryId: string; participantId: string; prizeCode: string | null }>; alternates: Array<{ position: number; entryId: string; participantId: string }> }; const plan = d.d.prizePlan as Plan;
    const label = (code: string | null) => plan.tiers.find((t) => t.code === code)?.label ?? code ?? "Prize";
    return this.db.transaction(async (tx) => {
      let created = 0;
      for (const w of out.winners) { const p = await this.deps.participants.get(w.participantId); const id = newId("win"); await tx.insert(winners).values({ id, drawId, campaignId: d.d.campaignId, kind: "winner", position: w.position, entryId: w.entryId, participantId: w.participantId, prizeCode: w.prizeCode ?? "P?", prizeLabel: label(w.prizeCode), status: "selected", displayName: this.displayName(p) }); await tx.insert(winnerEvents).values({ id: newId("wev"), winnerId: id, fromStatus: null, toStatus: "selected", actorId }); await this.deps.audit.record(tx, { actorType: "staff", actorId, action: "winner.selected", targetType: "winner", targetId: id, campaignId: d.d.campaignId, payload: { drawId, entryId: w.entryId, prize: w.prizeCode } }); await this.deps.crm?.emit({ entityType: "winner", entityId: id, entityVersion: 1, payload: { participantId: w.participantId, campaignCode: d.d.campaignId, period: d.periodCode, prize: label(w.prizeCode), rank: w.position, status: "selected" } }); created++; }
      for (const a of out.alternates) { const p = await this.deps.participants.get(a.participantId); await tx.insert(winners).values({ id: newId("win"), drawId, campaignId: d.d.campaignId, kind: "alternate", position: a.position, entryId: a.entryId, participantId: a.participantId, prizeCode: "-", prizeLabel: "alternate", status: "selected", displayName: this.displayName(p) }); }
      return { created, idempotent: false };
    });
  }
  /** Queue the approved winner message (only after draw approval). Template eligibility is checked at dispatch by the worker. */
  async notify(winnerId: string, actorId: string) {
    const w = await this.get(winnerId); if (!w) throw notFound("winner"); const d = await this.draw(w.drawId);
    if (!d || !["approved", "published"].includes(d.d.status)) throw conflict("the draw is not approved");
    if (w.kind !== "winner") throw conflict("alternates are contacted only after promotion");
    if (!["selected", "unreachable"].includes(w.status)) throw conflict(`winner is ${w.status}`);
    const p = await this.deps.participants.get(w.participantId); if (!p || p.status !== "active") throw conflict("participant is not active");
    const camp = (await this.deps.campaigns.get(d.d.campaignId))!; const v = await this.deps.campaigns.activeVersion(camp.id); const content = this.deps.campaigns.contentOf(v);
    const token = crypto.randomBytes(6).toString("hex").toUpperCase(); const claimRef = `${token.slice(0, 4)}-${token.slice(4, 8)}-${token.slice(8, 12)}`;
    const deadline = new Date(Date.now() + this.deps.claimDays * 86_400_000).toISOString();
    return this.db.transaction(async (tx) => {
      const attempt = w.contactAttempts + 1;
      await tx.update(winners).set({ claimTokenHash: hashToken(claimRef), claimExpiresAt: deadline, contactAttempts: attempt }).where(eq(winners.id, winnerId));
      const payload = content.winnerTemplateName ? { name: content.winnerTemplateName, language: { code: "en" }, components: [{ type: "body", parameters: [{ type: "text", text: p.firstName }, { type: "text", text: w.prizeLabel }, { type: "text", text: claimRef }] }] } : render(content.messages, "winner_contact", { first_name: p.firstName, campaign: camp.name, period: d.periodLabel, prize: w.prizeLabel, claim_ref: claimRef, deadline: deadline.slice(0, 10) });
      await this.deps.outbox.enqueue(tx, { channelUid: p.channelUid, kind: content.winnerTemplateName ? "template" : "text", purpose: "winner_contact", campaignId: camp.id, payload, idempotencyKey: `winner:${winnerId}:contact:${attempt}` });
      await this.transitionIn(tx, { ...w, contactAttempts: attempt }, "notified", { actorId, note: `contact attempt ${attempt}` });
      return { winnerId, claimRef, deadline };
    });
  }
  async transition(winnerId: string, input: { status: string; actorId: string; note?: string | null; reason?: string | null; expectedVersion?: number | null; collectionOutletId?: string | null; fulfilmentRef?: string | null; evidence?: string | null }) {
    return this.db.transaction(async (tx) => {
      const [w] = await tx.select().from(winners).where(eq(winners.id, winnerId)).for("update"); if (!w) throw notFound("winner");
      if (input.expectedVersion != null && w.version !== input.expectedVersion) throw conflict("the winner changed since you loaded it; reload");
      if (!(TRANSITIONS[w.status] ?? []).includes(input.status)) throw conflict(`cannot move a winner from ${w.status} to ${input.status}`);
      if (input.status === "collected") {
        const outletId = input.collectionOutletId ?? w.collectionOutletId; if (!outletId) throw invalid("a collection outlet is required");
        const o = await this.deps.campaigns.outlet(outletId); const member = (await this.deps.campaigns.campaignOutlets(w.campaignId)).find((m) => m.id === outletId);
        if (!o || !(member?.membership.collectionPoint || o.collectionPoint)) throw invalid("that outlet does not distribute prizes");
        if (w.fulfilledAt) throw conflict("already fulfilled");
        if (!input.fulfilmentRef) throw invalid("a fulfilment reference is required");
      }
      if (input.status === "verified") await this.deps.participants.markIdentityVerified(tx, w.participantId, input.actorId, input.evidence ?? input.note ?? null);
      const out = await this.transitionIn(tx, w, input.status, input);
      if (input.status === "replaced") return { ...out, replacement: await this.promoteAlternate(tx, w, input.actorId, input.reason ?? "replaced") };
      return out;
    });
  }
  private async transitionIn(tx: DbOrTx, w: Winner, to: string, o: { actorId: string; note?: string | null; reason?: string | null; collectionOutletId?: string | null; fulfilmentRef?: string | null; evidence?: string | null }) {
    if (!(TRANSITIONS[w.status] ?? []).includes(to)) throw conflict(`cannot move a winner from ${w.status} to ${to}`);
    const ts = new Date().toISOString(); const set: Partial<Winner> = { status: to, collectionOutletId: o.collectionOutletId ?? w.collectionOutletId };
    if (to === "verified") Object.assign(set, { verifiedAt: ts, verifiedBy: o.actorId }); if (to === "accepted") Object.assign(set, { acceptedAt: ts }); if (to === "collected") Object.assign(set, { fulfilledAt: ts, fulfilledBy: o.actorId, fulfilmentRef: o.fulfilmentRef ?? null });
    if (["replaced", "ineligible", "expired", "declined"].includes(to) && w.publication === "published") set.publication = "withdrawn";
    const r = await tx.update(winners).set({ ...set, version: w.version + 1 }).where(and(eq(winners.id, w.id), eq(winners.version, w.version))).returning({ id: winners.id });
    if (!r.length) throw conflict("concurrent change; reload");
    await tx.insert(winnerEvents).values({ id: newId("wev"), winnerId: w.id, fromStatus: w.status, toStatus: to, actorId: o.actorId, reason: o.reason ?? null, note: o.note ?? null, detail: { collectionOutletId: o.collectionOutletId ?? null, fulfilmentRef: o.fulfilmentRef ?? null, evidence: o.evidence ?? null } });
    await this.deps.audit.record(tx, { actorType: "staff", actorId: o.actorId, action: `winner.${to}`, targetType: "winner", targetId: w.id, campaignId: w.campaignId, reason: o.reason ?? null, payload: { from: w.status, collectionOutletId: o.collectionOutletId ?? null, fulfilmentRef: o.fulfilmentRef ?? null } });
    const d = await this.draw(w.drawId);
    await this.deps.crm?.emit({ entityType: "claim", entityId: w.id, entityVersion: w.version + 1, payload: { winnerId: w.id, state: to, collectionOutlet: (o.collectionOutletId ?? w.collectionOutletId) ? (await this.deps.campaigns.outlet((o.collectionOutletId ?? w.collectionOutletId)!))?.code ?? null : null, fulfilledAt: to === "collected" ? ts : null } });
    await this.deps.crm?.emit({ entityType: "winner", entityId: w.id, entityVersion: w.version + 1, payload: { participantId: w.participantId, campaignCode: w.campaignId, period: d?.periodCode, prize: w.prizeLabel, rank: w.position, status: to } });
    const outletId = o.collectionOutletId ?? w.collectionOutletId;
    if (to === "accepted" && outletId) await this.sendCollectionInstructions(tx, { ...w, status: to }, outletId, o.actorId);
    return { winner: (await tx.select().from(winners).where(eq(winners.id, w.id)))[0] };
  }
  private async sendCollectionInstructions(tx: DbOrTx, w: Winner, outletId: string, actorId: string) {
    const o = await this.deps.campaigns.outlet(outletId); const p = await this.deps.participants.get(w.participantId); if (!o || !p || p.status !== "active") return;
    const v = await this.deps.campaigns.activeVersion(w.campaignId); const M = this.deps.campaigns.contentOf(v).messages;
    await this.deps.outbox.enqueue(tx, { channelUid: p.channelUid, purpose: "winner_collect", campaignId: w.campaignId, payload: render(M, "winner_collect", { prize: w.prizeLabel, outlet: `${o.retailer} — ${o.branch}, ${o.town}`, first_name: p.firstName }), idempotencyKey: `winner:${w.id}:collect:${outletId}` });
    await this.deps.audit.record(tx, { actorType: "staff", actorId, action: "winner.collection_instructions", targetType: "winner", targetId: w.id, campaignId: w.campaignId, payload: { outletId } });
  }
  /** Reassign the collection outlet (verified/accepted only) and re-notify. */
  async reassignCollection(winnerId: string, { actorId, collectionOutletId, reason }: { actorId: string; collectionOutletId: string; reason?: string | null }) {
    return this.db.transaction(async (tx) => {
      const [w] = await tx.select().from(winners).where(eq(winners.id, winnerId)).for("update"); if (!w) throw notFound("winner");
      if (!["verified", "accepted"].includes(w.status)) throw conflict(`the collection outlet can change only while verified or accepted (status=${w.status})`);
      const o = await this.deps.campaigns.outlet(collectionOutletId); const member = (await this.deps.campaigns.campaignOutlets(w.campaignId)).find((m) => m.id === collectionOutletId); if (!o || !(member?.membership.collectionPoint || o.collectionPoint)) throw invalid("that outlet does not distribute prizes");
      await tx.update(winners).set({ collectionOutletId, version: w.version + 1 }).where(eq(winners.id, winnerId));
      await tx.insert(winnerEvents).values({ id: newId("wev"), winnerId, fromStatus: w.status, toStatus: w.status, actorId, reason: reason ?? null, detail: { collectionReassigned: collectionOutletId } });
      await this.deps.audit.record(tx, { actorType: "staff", actorId, action: "winner.collection_reassigned", targetType: "winner", targetId: winnerId, campaignId: w.campaignId, reason: reason ?? null, payload: { collectionOutletId } });
      if (w.status === "accepted") await this.sendCollectionInstructions(tx, w, collectionOutletId, actorId);
      return { winner: (await tx.select().from(winners).where(eq(winners.id, winnerId)))[0] };
    });
  }
  /** Promote the next unused alternate from the draw's stored output — never a fresh random draw. */
  private async promoteAlternate(tx: DbOrTx, replaced: Winner, actorId: string, reason: string) {
    const d = await this.draw(replaced.drawId); const out = d!.d.output as { alternates: Array<{ position: number; entryId: string; participantId: string }>; }; const plan = d!.d.prizePlan as Plan;
    const used = new Set((await tx.select({ e: winners.entryId }).from(winners).where(and(eq(winners.drawId, replaced.drawId), eq(winners.kind, "winner")))).map((r) => r.e));
    const holders = new Set((await tx.select({ p: winners.participantId }).from(winners).where(and(eq(winners.drawId, replaced.drawId), eq(winners.kind, "winner"), notInArray(winners.status, ["replaced", "ineligible", "expired", "declined"])))).map((r) => r.p));
    const alt = out.alternates.find((a) => !used.has(a.entryId) && !(plan.onePrizePerParticipant && holders.has(a.participantId)));
    if (!alt) { await this.deps.audit.record(tx, { actorType: "staff", actorId, action: "winner.no_alternate", targetType: "winner", targetId: replaced.id, campaignId: replaced.campaignId, reason }); return null; }
    const [{ m }] = await tx.select({ m: sql<number>`coalesce(max(${winners.position}), 0)::int` }).from(winners).where(and(eq(winners.drawId, replaced.drawId), eq(winners.kind, "winner")));
    // the alternate's own row becomes the winner row (one row per entry per draw); its prize is the replaced winner's tier
    const [altRow] = await tx.select().from(winners).where(and(eq(winners.drawId, replaced.drawId), eq(winners.kind, "alternate"), eq(winners.entryId, alt.entryId))).for("update");
    const id = altRow?.id ?? newId("win");
    if (altRow) await tx.update(winners).set({ kind: "winner", position: m + 1, prizeCode: replaced.prizeCode, prizeLabel: replaced.prizeLabel, status: "selected", replacesId: replaced.id, version: altRow.version + 1 }).where(eq(winners.id, altRow.id));
    else { const p = await this.deps.participants.get(alt.participantId); await tx.insert(winners).values({ id, drawId: replaced.drawId, campaignId: replaced.campaignId, kind: "winner", position: m + 1, entryId: alt.entryId, participantId: alt.participantId, prizeCode: replaced.prizeCode, prizeLabel: replaced.prizeLabel, status: "selected", displayName: this.displayName(p), replacesId: replaced.id }); }
    await tx.update(winners).set({ replacedById: id }).where(eq(winners.id, replaced.id));
    await tx.insert(winnerEvents).values({ id: newId("wev"), winnerId: id, fromStatus: null, toStatus: "selected", actorId, reason, detail: { replaces: replaced.id, alternatePosition: alt.position } });
    await this.deps.audit.record(tx, { actorType: "staff", actorId, action: "winner.alternate_promoted", targetType: "winner", targetId: id, campaignId: replaced.campaignId, reason, payload: { replaces: replaced.id, alternatePosition: alt.position, entryId: alt.entryId } });
    return (await tx.select().from(winners).where(eq(winners.id, id)))[0];
  }
  verifyClaimToken(w: Winner, claimRef: string) { if (!w.claimTokenHash) return false; if (w.claimExpiresAt && Date.parse(w.claimExpiresAt) < Date.now()) return false; return timingEqual(w.claimTokenHash, hashToken(String(claimRef).toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(.{4})(.{4})(.{4})$/, "$1-$2-$3"))); }
  /** Expire winners past their claim deadline; version checks keep it consistent with concurrent fulfilment. */
  async expireDue() {
    const rows = await this.db.select().from(winners).where(and(lt(winners.claimExpiresAt, new Date().toISOString()), inArray(winners.status, ["notified", "verified", "accepted", "unreachable"]))); let n = 0;
    for (const w of rows) { try { await this.db.transaction((tx) => this.transitionIn(tx, w, "expired", { actorId: "system", reason: "claim deadline passed" })); n++; } catch { /* concurrent fulfilment won */ } }
    return { expired: n };
  }
  async publish(winnerId: string, actorId: string) {
    const w = await this.get(winnerId); if (!w) throw notFound("winner"); const d = await this.draw(w.drawId);
    if (d!.d.status !== "published") throw conflict("the draw results are not published"); if (!["verified", "accepted", "collected"].includes(w.status)) throw conflict(`a winner must be verified before publication (status=${w.status})`);
    await this.db.update(winners).set({ publication: "published", version: w.version + 1 }).where(eq(winners.id, winnerId)); await this.deps.audit.record(this.db, { actorType: "staff", actorId, action: "winner.published", targetType: "winner", targetId: winnerId, campaignId: w.campaignId }); return (await this.get(winnerId))!;
  }
  async unpublish(winnerId: string, actorId: string, reason: string) { const w = await this.get(winnerId); if (!w) throw notFound("winner"); await this.db.update(winners).set({ publication: "withdrawn", version: w.version + 1 }).where(eq(winners.id, winnerId)); await this.deps.audit.record(this.db, { actorType: "staff", actorId, action: "winner.unpublished", targetType: "winner", targetId: winnerId, campaignId: w.campaignId, reason }); return (await this.get(winnerId))!; }
  /** Public projection built server-side: display name, town, prize, period. Never the participant entity. */
  async listPublic(campaignId: string, period?: string | null) {
    const rows = await this.db.select({ rank: winners.position, name: winners.displayName, prize: winners.prizeLabel, location: participants.location, period: campaignPeriods.code }).from(winners).innerJoin(draws, eq(draws.id, winners.drawId)).innerJoin(campaignPeriods, eq(campaignPeriods.id, draws.periodId)).leftJoin(participants, eq(participants.id, winners.participantId)).where(and(eq(draws.campaignId, campaignId), eq(draws.status, "published"), eq(winners.publication, "published"), eq(winners.kind, "winner"), period ? eq(campaignPeriods.code, period) : undefined)).orderBy(asc(campaignPeriods.startsAt), asc(winners.position)).limit(500);
    return rows.map((r) => ({ period: r.period, rank: r.rank, name: r.name ?? "Winner", location: r.location ?? null, prize: r.prize }));
  }
  async publishedPeriods(campaignId: string) { return this.db.selectDistinct({ code: campaignPeriods.code, label: campaignPeriods.label, startsAt: campaignPeriods.startsAt }).from(winners).innerJoin(draws, eq(draws.id, winners.drawId)).innerJoin(campaignPeriods, eq(campaignPeriods.id, draws.periodId)).where(and(eq(draws.campaignId, campaignId), eq(draws.status, "published"), eq(winners.publication, "published"), eq(winners.kind, "winner"))).orderBy(asc(campaignPeriods.startsAt)); }
  async list({ campaignId, drawId, status, kind = "winner" }: { campaignId?: string | null; drawId?: string | null; status?: string | null; kind?: string | null }) {
    const conds = [campaignId ? eq(winners.campaignId, campaignId) : undefined, drawId ? eq(winners.drawId, drawId) : undefined, status ? eq(winners.status, status) : undefined, kind ? eq(winners.kind, kind) : undefined].filter(Boolean);
    return this.db.select({ w: winners, periodCode: campaignPeriods.code, participant: { firstName: participants.firstName, surname: participants.surname, channelUid: participants.channelUid, location: participants.location, status: participants.status } }).from(winners).innerJoin(draws, eq(draws.id, winners.drawId)).innerJoin(campaignPeriods, eq(campaignPeriods.id, draws.periodId)).leftJoin(participants, eq(participants.id, winners.participantId)).where(conds.length ? and(...(conds as never[])) : undefined).orderBy(desc(campaignPeriods.startsAt), asc(winners.kind), asc(winners.position)).limit(300);
  }
  async events(winnerId: string) { return this.db.select().from(winnerEvents).where(eq(winnerEvents.winnerId, winnerId)).orderBy(asc(winnerEvents.createdAt)); }
  async entryOf(w: Winner) { const [e] = await this.db.select().from(entries).where(eq(entries.id, w.entryId)); return e ?? null; }
}
