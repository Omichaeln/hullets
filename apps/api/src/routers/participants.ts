import { z } from "zod";
import { eq, desc, sql } from "drizzle-orm";
import { schema } from "@promo/db";
import { router, guard } from "../trpc.ts";
import { notFound } from "@promo/core";
const { submissions, entries } = schema;
export const participantsRouter = router({
  search: guard("participant.read").input(z.object({ q: z.string().max(60).optional(), campaignId: z.string().nullable().optional(), limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) })).query(({ ctx, input }) => ctx.app.participants.search({ q: input.q ?? "", campaignId: input.campaignId ?? null, limit: input.limit, offset: input.offset })),
  get: guard("participant.read").input(z.object({ participantId: z.string() })).query(async ({ ctx, input }) => {
    const p = await ctx.app.participants.get(input.participantId); if (!p) throw notFound("participant");
    const subs = await ctx.app.db.select({ id: submissions.id, reference: submissions.reference, campaignId: submissions.campaignId, status: submissions.status, reasonCode: submissions.reasonCode, periodCode: submissions.periodCode, createdAt: submissions.createdAt, decidedAt: submissions.decidedAt }).from(submissions).where(eq(submissions.participantId, p.id)).orderBy(desc(submissions.createdAt)).limit(100);
    const ents = await ctx.app.db.select({ id: entries.id, submissionId: entries.submissionId, periodCode: entries.periodCode, status: entries.status, awardedAt: entries.awardedAt }).from(entries).where(eq(entries.participantId, p.id)).orderBy(desc(entries.awardedAt));
    return { participant: ctx.app.participants.mask(p), enrollments: await ctx.app.participants.enrollments(p.id), submissions: subs, entries: ents };
  }),
  correct: guard("participant.correct").input(z.object({ participantId: z.string(), firstName: z.string().max(60).optional(), surname: z.string().max(60).optional(), location: z.string().max(80).optional(), identity: z.string().max(20).optional(), reason: z.string().min(3).max(200) })).mutation(async ({ ctx, input }) => ctx.app.participants.mask(await ctx.app.participants.correct(input.participantId, input, ctx.user.id, input.reason))),
  revealIdentity: guard("participant.identity.reveal").input(z.object({ participantId: z.string(), reason: z.string().min(3).max(200) })).mutation(async ({ ctx, input }) => ({ identity: await ctx.app.participants.revealIdentity(input.participantId, ctx.user.id, input.reason) })),
  withdraw: guard("participant.privacy").input(z.object({ participantId: z.string(), reason: z.string().min(3).max(200) })).mutation(async ({ ctx, input }) => ctx.app.participants.mask(await ctx.app.participants.withdraw(input.participantId, ctx.user.id, input.reason))),
  anonymise: guard("participant.privacy").input(z.object({ participantId: z.string(), reason: z.string().min(3).max(200) })).mutation(async ({ ctx, input }) => ctx.app.participants.mask(await ctx.app.participants.anonymise(input.participantId, ctx.user.id, input.reason))),
  changePhone: guard("participant.privacy").input(z.object({ participantId: z.string(), phone: z.string(), reason: z.string().min(3).max(200) })).mutation(async ({ ctx, input }) => ctx.app.participants.mask(await ctx.app.participants.changePhone(input.participantId, input.phone, ctx.user.id, input.reason))),
  stats: guard("participant.read").query(async ({ ctx }) => { const [{ n }] = await ctx.app.db.select({ n: sql<number>`count(*)::int` }).from(schema.participants); return { participants: n }; }),
});
