import { z } from "zod";
import { eq, and, desc, ne, sql, or, ilike, gte } from "drizzle-orm";
import { schema } from "@promo/db";
import { router, guard } from "../trpc.ts";
import { notFound, can, maskPhone } from "@promo/core";
const { submissions, participants, extractions, submissionItems, duplicateCandidates, reviewTasks, entries, canonicalReceipts, outlets, mediaAssets } = schema;
export const submissionsRouter = router({
  list: guard("submission.read").input(z.object({ campaignId: z.string().optional(), status: z.string().optional(), period: z.string().optional(), reference: z.string().optional(), participantId: z.string().optional(), phone: z.string().max(30).optional(), since: z.string().optional(), limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) })).query(async ({ ctx, input }) => {
    const phoneDigits = input.phone?.replace(/\D/g, "") ?? "";
    const normalizedPhone = phoneDigits ? ctx.app.participants.uid(input.phone ?? "") : null;
    const phoneCond = phoneDigits ? (normalizedPhone ? or(eq(participants.channelUid, normalizedPhone), ilike(participants.channelUid, `%${phoneDigits}%`)) : ilike(participants.channelUid, `%${phoneDigits}%`)) : undefined;
    const conds = [input.campaignId ? eq(submissions.campaignId, input.campaignId) : undefined, input.status ? eq(submissions.status, input.status) : undefined, input.period ? eq(submissions.periodCode, input.period) : undefined, input.participantId ? eq(submissions.participantId, input.participantId) : undefined, phoneCond, input.reference ? ilike(submissions.reference, `%${input.reference.replace(/[%_]/g, "")}%`) : undefined, input.since ? gte(submissions.createdAt, input.since) : undefined].filter(Boolean);
    const rows = await ctx.app.db.select({ s: submissions, participantPhone: participants.channelUid, review: { state: reviewTasks.state, assignee: reviewTasks.assignee, slaDueAt: reviewTasks.slaDueAt } }).from(submissions).innerJoin(participants, eq(participants.id, submissions.participantId)).leftJoin(reviewTasks, eq(reviewTasks.submissionId, submissions.id)).where(conds.length ? and(...(conds as never[])) : undefined).orderBy(desc(submissions.createdAt)).limit(input.limit).offset(input.offset);
    return { rows: rows.map((r) => ({ ...r.s, participantPhone: maskPhone(r.participantPhone), review: r.review?.state ? r.review : null })), next: rows.length === input.limit ? input.offset + input.limit : null };
  }),
  queue: guard("submission.read").query(({ ctx }) => ctx.app.pipeline.reviewQueue()),
  get: guard("submission.read").input(z.object({ submissionId: z.string() })).query(async ({ ctx, input }) => {
    const s = await ctx.app.pipeline.get(input.submissionId); if (!s) throw notFound("submission");
    const canMedia = can(ctx.user.roles, "submission.media");
    const xs = await ctx.app.db.select().from(extractions).where(eq(extractions.submissionId, s.id)).orderBy(extractions.attemptNo);
    const dups = await ctx.app.db.select({ d: duplicateCandidates, candRef: submissions.reference, candStatus: submissions.status, candParticipant: submissions.participantId }).from(duplicateCandidates).innerJoin(submissions, eq(submissions.id, duplicateCandidates.candidateSubmissionId)).where(eq(duplicateCandidates.submissionId, s.id));
    const [review] = await ctx.app.db.select().from(reviewTasks).where(eq(reviewTasks.submissionId, s.id));
    const [entry] = await ctx.app.db.select().from(entries).where(eq(entries.submissionId, s.id));
    const [canonical] = s.canonicalReceiptId ? await ctx.app.db.select().from(canonicalReceipts).where(eq(canonicalReceipts.id, s.canonicalReceiptId)) : [null];
    const attempts = await ctx.app.db.select({ id: submissions.id, reference: submissions.reference, status: submissions.status, createdAt: submissions.createdAt }).from(submissions).where(or(eq(submissions.reuploadOf, s.id), eq(submissions.id, s.reuploadOf ?? "-")));
    const media = s.mediaAssetId ? await ctx.app.media.get(s.mediaAssetId) : null;
    if (canMedia) await ctx.app.audit.record(ctx.app.db, { actorType: "staff", actorId: ctx.user.id, action: "submission.viewed", targetType: "submission", targetId: s.id, campaignId: s.campaignId, correlationId: ctx.correlationId });
    const p = await ctx.app.participants.get(s.participantId); const version = await ctx.app.campaigns.version(s.campaignVersionId);
    return { submission: s, participant: ctx.app.participants.mask(p), outlet: s.selectedOutletId ? await ctx.app.campaigns.outlet(s.selectedOutletId) : null, rulesVersion: version ? { versionNo: version.versionNo, configHash: version.configHash } : null,
      media: media ? { id: media.id, width: media.width, height: media.height, mime: media.mime, bytes: media.bytes, quality: media.quality, status: media.status, viewable: canMedia } : null,
      extractions: xs.map((x) => ({ ...x, ocrText: canMedia ? x.ocrText : null, raw: canMedia ? x.raw : null })), items: await ctx.app.db.select().from(submissionItems).where(eq(submissionItems.submissionId, s.id)).orderBy(submissionItems.lineNo),
      duplicates: dups.map((d) => ({ ...d.d, candidateReference: d.candRef, candidateStatus: d.candStatus, sameParticipant: d.candParticipant === s.participantId })), review: review ?? null, entry: entry ?? null, canonical: canonical ?? null, attempts };
  }),
  assign: guard("submission.review").input(z.object({ submissionId: z.string() })).mutation(async ({ ctx, input }) => { await ctx.app.pipeline.assign(input.submissionId, ctx.user.id); return { ok: true }; }),
  release: guard("submission.review").input(z.object({ submissionId: z.string() })).mutation(async ({ ctx, input }) => { await ctx.app.pipeline.release(input.submissionId, ctx.user.id); return { ok: true }; }),
  escalate: guard("submission.review").input(z.object({ submissionId: z.string(), note: z.string().min(3).max(500) })).mutation(async ({ ctx, input }) => { await ctx.app.pipeline.escalate(input.submissionId, ctx.user.id, input.note); return { ok: true }; }),
  review: guard("submission.review").input(z.object({ submissionId: z.string(), decision: z.enum(["qualified", "not_qualified", "duplicate", "reupload"]), reasonCode: z.string().max(60).optional(), note: z.string().max(500).optional(), expectedVersion: z.number().int().optional() })).mutation(({ ctx, input }) => ctx.app.pipeline.review(input.submissionId, { reviewerId: ctx.user.id, decision: input.decision, reasonCode: input.reasonCode ?? null, note: input.note ?? null, expectedVersion: input.expectedVersion ?? null })),
  correctFacts: guard("submission.review").input(z.object({ submissionId: z.string(), date: z.string().nullable().optional(), receiptNo: z.string().nullable().optional(), totalMinor: z.number().int().nullable().optional(), note: z.string().min(3).max(300) })).mutation(({ ctx, input }) => ctx.app.pipeline.correctFacts(input.submissionId, input, ctx.user.id, input.note)),
  resolveDuplicate: guard("submission.review").input(z.object({ candidateId: z.string(), resolution: z.enum(["same_purchase", "different_purchase"]), note: z.string().max(300).optional() })).mutation(async ({ ctx, input }) => { await ctx.app.pipeline.resolveDuplicate(input.candidateId, input.resolution, ctx.user.id, input.note); return { ok: true }; }),
  reprocess: guard("submission.reprocess").input(z.object({ submissionId: z.string(), reason: z.string().min(3).max(200) })).mutation(({ ctx, input }) => ctx.app.pipeline.reprocess(input.submissionId, ctx.user.id, input.reason)),
  resendResult: guard("support.handoff").input(z.object({ submissionId: z.string() })).mutation(async ({ ctx, input }) => {
    const s = await ctx.app.pipeline.get(input.submissionId); if (!s) throw notFound("submission");
    const msgs = await ctx.app.outbox.byKeyPrefix(`submission:${s.id}:outcome`); const last = msgs.at(-1); if (!last) throw notFound("result message");
    const p = await ctx.app.participants.get(s.participantId); if (!p) throw notFound("participant");
    await ctx.app.db.transaction(async (tx) => { await ctx.app.outbox.enqueue(tx, { channelUid: p.channelUid, purpose: "submission_outcome", campaignId: s.campaignId, payload: last.payload, idempotencyKey: `submission:${s.id}:resend:${Date.now()}` }); await ctx.app.audit.record(tx, { actorType: "staff", actorId: ctx.user.id, action: "support.resend_result", targetType: "submission", targetId: s.id, campaignId: s.campaignId }); });
    return { ok: true };
  }),
  sha: guard("submission.read").input(z.object({ submissionId: z.string() })).query(async ({ ctx, input }) => { const s = await ctx.app.pipeline.get(input.submissionId); if (!s?.mediaAssetId) return null; const [m] = await ctx.app.db.select({ sha256: mediaAssets.sha256 }).from(mediaAssets).where(eq(mediaAssets.id, s.mediaAssetId)); return m?.sha256 ?? null; }),
  _unusedOutlets: guard("submission.read").query(({ ctx }) => ctx.app.db.select({ id: outlets.id }).from(outlets).where(ne(outlets.active, true)).limit(1)),
});
export const entriesRouter = router({
  list: guard("entry.read").input(z.object({ campaignId: z.string().optional(), period: z.string().optional(), status: z.string().optional(), participantId: z.string().optional(), phone: z.string().max(30).optional(), limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) })).query(async ({ ctx, input }) => {
    const phoneDigits = input.phone?.replace(/\D/g, "") ?? "";
    const normalizedPhone = phoneDigits ? ctx.app.participants.uid(input.phone ?? "") : null;
    const phoneCond = phoneDigits ? (normalizedPhone ? or(eq(participants.channelUid, normalizedPhone), ilike(participants.channelUid, `%${phoneDigits}%`)) : ilike(participants.channelUid, `%${phoneDigits}%`)) : undefined;
    const conds = [input.campaignId ? eq(entries.campaignId, input.campaignId) : undefined, input.period ? eq(entries.periodCode, input.period) : undefined, input.status ? eq(entries.status, input.status) : undefined, input.participantId ? eq(entries.participantId, input.participantId) : undefined, phoneCond].filter(Boolean);
    const rows = await ctx.app.db.select({ e: entries, reference: submissions.reference, participantPhone: participants.channelUid }).from(entries).innerJoin(submissions, eq(submissions.id, entries.submissionId)).innerJoin(participants, eq(participants.id, entries.participantId)).where(conds.length ? and(...(conds as never[])) : undefined).orderBy(desc(entries.awardedAt)).limit(input.limit).offset(input.offset);
    return { rows: rows.map((r) => ({ ...r.e, reference: r.reference, participantPhone: maskPhone(r.participantPhone) })), next: rows.length === input.limit ? input.offset + input.limit : null };
  }),
  get: guard("entry.read").input(z.object({ entryId: z.string() })).query(async ({ ctx, input }) => {
    const [e] = await ctx.app.db.select().from(entries).where(eq(entries.id, input.entryId)); if (!e) throw notFound("entry");
    const s = await ctx.app.pipeline.get(e.submissionId); const [canonical] = await ctx.app.db.select().from(canonicalReceipts).where(eq(canonicalReceipts.id, e.canonicalReceiptId));
    const xs = await ctx.app.db.select({ attemptNo: extractions.attemptNo, provider: extractions.provider, model: extractions.model, disposition: extractions.disposition, createdAt: extractions.createdAt }).from(extractions).where(eq(extractions.submissionId, e.submissionId)).orderBy(extractions.attemptNo);
    const events = await ctx.app.db.select().from(schema.entryEvents).where(eq(schema.entryEvents.entryId, e.id)).orderBy(schema.entryEvents.createdAt);
    const drawRows = await ctx.app.db.select({ drawId: schema.drawCandidates.drawId, status: schema.draws.status, candidateStatus: schema.drawCandidates.status }).from(schema.drawCandidates).innerJoin(schema.draws, eq(schema.draws.id, schema.drawCandidates.drawId)).where(eq(schema.drawCandidates.entryId, e.id));
    const version = await ctx.app.campaigns.version(e.campaignVersionId);
    const audit = [...(await ctx.app.audit.list({ targetType: "entry", targetId: e.id, limit: 50 })), ...(await ctx.app.audit.list({ targetType: "submission", targetId: e.submissionId, limit: 50 }))].sort((a, b) => a.id - b.id);
    return { entry: e, submission: s ? { id: s.id, reference: s.reference, status: s.status, reasonCode: s.reasonCode, decidedBy: s.decidedBy, decidedAt: s.decidedAt, selectedOutletId: s.selectedOutletId, periodCode: s.periodCode } : null, canonical, extractions: xs, events, draws: drawRows, rulesVersion: version ? { versionNo: version.versionNo, configHash: version.configHash } : null, audit };
  }),
  disqualify: guard("entry.disqualify").input(z.object({ entryId: z.string(), reason: z.string().min(3).max(300), approvedBy: z.string().optional(), note: z.string().max(500).optional() })).mutation(({ ctx, input }) => ctx.app.pipeline.disqualifyEntry(input.entryId, { actorId: ctx.user.id, reason: input.reason, approvedBy: input.approvedBy ?? null, note: input.note ?? null })),
  reinstate: guard("entry.disqualify").input(z.object({ entryId: z.string(), reason: z.string().min(3).max(300), approvedBy: z.string().optional() })).mutation(({ ctx, input }) => ctx.app.pipeline.reinstateEntry(input.entryId, { actorId: ctx.user.id, reason: input.reason, approvedBy: input.approvedBy ?? null })),
});
export { sql };
