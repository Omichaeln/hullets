import { eq, and, sql, desc, asc, ne, inArray } from "drizzle-orm";
import { schema, type Db, type DbOrTx } from "@promo/db";
import { newId, newReference } from "../util/ids.ts";
import { conflict, invalid, notFound, err } from "../util/errors.ts";
import { hamming } from "../media/images.ts";
import { MediaRejected } from "../media/images.ts";
import type { MediaService } from "../media/service.ts";
import type { Extractor, Facts } from "../extraction/types.ts";
import { ExtractorUnavailable } from "../extraction/types.ts";
import { evaluate, type Evaluation, type Disposition } from "../eligibility/rules.ts";
import type { CampaignService } from "../campaign/service.ts";
import type { ParticipantService } from "../participant/service.ts";
import type { AuditService } from "../audit.ts";
import type { OutboxService } from "../ops/outbox.ts";
import type { QueueService } from "../ops/queue.ts";
import type { CrmEmitter } from "../conversation/engine.ts";
import { render, reasonText } from "../conversation/copy.ts";

const { submissions, extractions, submissionItems, canonicalReceipts, duplicateCandidates, reviewTasks, entries, entryEvents, mediaAssets, drawCandidates, draws } = schema;
export type Submission = typeof submissions.$inferSelect;
const TERMINAL = new Set(["qualified", "not_qualified", "duplicate", "review", "reupload"]);
const PROBABLE_VISUAL_DISTANCE = 6;
export const RECEIPT_KEY_VERSION = 1;

/**
 * Receipt identity. A purchase is `outlet|date|receiptNo`; the total is a
 * consistency check, not part of the key (second photographs often lose the
 * total line, and a key that included it would let one purchase earn twice).
 * Credit is enforced by UNIQUE(campaign, key) on canonical_receipts and
 * UNIQUE(canonical_receipt_id) on entries — never by application checks alone.
 */
export const receiptKey = (outletId: string | null, date: string | null, receiptNo: string | null) => (outletId && date && receiptNo ? `${outletId}|${date}|${receiptNo}` : null);

export interface AlertSink { raise(a: { kind: string; severity: "info" | "warning" | "critical"; message: string; runbook?: string; detail?: Record<string, unknown> }): Promise<void>; metric(name: string, value?: number, labels?: Record<string, unknown>): Promise<void>; }

/**
 * Submission lifecycle. submit(): durable intake (validated private media +
 * submission row + job) inside the inbound event's processing. process():
 * extraction -> deterministic rules -> canonical receipt claim -> ONE
 * transaction committing decision, award, audit, participant message and CRM
 * event. review(): reviewer decisions through the same commit path with an
 * optimistic version check. A transient provider problem stays "delayed" and
 * is retried; it never becomes a rejection.
 */
export class ReceiptPipeline {
  constructor(private db: Db, private deps: { media: MediaService; extractor: Extractor; campaigns: CampaignService; participants: ParticipantService; audit: AuditService; outbox: OutboxService; queue: QueueService; crm?: CrmEmitter | null; alerts: AlertSink; reviewSlaHours: number }) {}

  async get(id: string) { const [s] = await this.db.select().from(submissions).where(eq(submissions.id, id)); return s ?? null; }

  async submit(input: { campaignId: string; campaignVersionId: string; participantId: string; conversationId: string; inboundEventId: string; providerMessageId: string; uid: string; imageBytes: Buffer; selectedOutletId: string; correlationId?: string | null; eventAt?: string | null; reuploadOf?: string | null }) {
    const [existing] = await this.db.select().from(submissions).where(eq(submissions.providerMessageId, input.providerMessageId));
    if (existing) return { submissionId: existing.id, reference: existing.reference, replay: true };
    let media; try { media = await this.deps.media.store({ bytes: input.imageBytes, campaignId: input.campaignId }); } catch (e) { if (e instanceof MediaRejected) throw Object.assign(new Error(e.message), { code: "MEDIA_REJECTED" }); throw e; }
    const intakeAt = new Date().toISOString();
    const period = await this.deps.campaigns.periodAt(input.campaignId, intakeAt);
    const id = newId("sub"); const reference = newReference();
    await this.db.transaction(async (tx) => {
      await tx.insert(submissions).values({ id, reference, campaignId: input.campaignId, campaignVersionId: input.campaignVersionId, participantId: input.participantId, conversationId: input.conversationId, inboundEventId: input.inboundEventId, providerMessageId: input.providerMessageId, mediaAssetId: media.id, selectedOutletId: input.selectedOutletId, periodCode: period?.code ?? null, status: "received", eventAt: input.eventAt ?? intakeAt, intakeAt, reuploadOf: input.reuploadOf ?? null, correlationId: input.correlationId ?? null });
      await this.deps.audit.record(tx, { actorType: "participant", actorId: input.participantId, action: "submission.received", targetType: "submission", targetId: id, campaignId: input.campaignId, correlationId: input.correlationId, payload: { mediaAssetId: media.id, selectedOutletId: input.selectedOutletId, periodCode: period?.code ?? null } });
      await this.deps.queue.enqueueJob(tx, "submission.process", { submissionId: id }, { correlationId: input.correlationId, dedupeKey: `process:${id}` });
    });
    await this.deps.alerts.metric("submission.received", 1, { campaignId: input.campaignId });
    return { submissionId: id, reference, replay: false };
  }

  async process(submissionId: string): Promise<{ submissionId: string; decision: string; reason: string | null; entryId?: string | null; alreadyDecided?: boolean }> {
    const s = await this.get(submissionId); if (!s) throw notFound("submission");
    if (TERMINAL.has(s.status)) return { submissionId, decision: s.status, reason: s.reasonCode, alreadyDecided: true };
    const claimed = await this.db.update(submissions).set({ status: "processing", version: sql`${submissions.version} + 1` }).where(and(eq(submissions.id, submissionId), inArray(submissions.status, ["received", "delayed", "processing"]))).returning({ id: submissions.id });
    if (!claimed.length) { const cur = await this.get(submissionId); return { submissionId, decision: cur!.status, reason: cur!.reasonCode, alreadyDecided: true }; }
    const { campaigns, participants, media, extractor } = this.deps;
    const campaign = (await campaigns.get(s.campaignId))!; const version = (await campaigns.version(s.campaignVersionId))!; const rules = campaigns.rulesOf(version);
    const asset = s.mediaAssetId ? await media.get(s.mediaAssetId) : null;
    const original = asset ? await media.bytes(asset) : null; const normalised = asset ? await media.bytes(asset, { normalised: true }) : null;
    if (!asset || !original || !normalised) return this.delay(s, "media_unavailable");
    const outletsList = await campaigns.campaignOutlets(s.campaignId);
    const context = { outlets: outletsList.map((o) => ({ id: o.id, retailer: o.retailer, branch: o.branch, town: o.town, aliases: o.aliases })), products: rules.products, dateOrder: rules.dateOrder, quality: (asset.quality ?? {}) as Record<string, unknown> };
    const [{ n: attemptNo }] = await this.db.select({ n: sql<number>`count(*)::int + 1` }).from(extractions).where(eq(extractions.submissionId, submissionId));

    let facts: Facts;
    try { facts = await extractor.extract({ original, normalised, mime: asset.mime, context }); }
    catch (e) {
      const ex = e as ExtractorUnavailable;
      await this.deps.alerts.raise({ kind: "extraction.failure", severity: "critical", message: `extractor failure: ${ex.message}`, runbook: "docs/runbooks/media-and-extraction.md" });
      await this.db.insert(extractions).values({ id: newId("ext"), submissionId, attemptNo, provider: extractor.name, model: "n/a", schemaVersion: "receipt-facts/1", error: ex.message.slice(0, 400) });
      return this.delay(s, ex.code ?? "extractor_failed");
    }
    const selectedOutlet = s.selectedOutletId ? await campaigns.outlet(s.selectedOutletId) : null;
    const member = outletsList.find((o) => o.id === s.selectedOutletId);
    const controls = await campaigns.controls(s.campaignId);
    const enrollment = await participants.enrollment(s.participantId, s.campaignId); const participant = await participants.get(s.participantId);
    const [{ n: periodCount }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(entries).where(and(eq(entries.participantId, s.participantId), eq(entries.campaignId, s.campaignId), eq(entries.periodCode, s.periodCode ?? ""), eq(entries.status, "active")));
    const [{ n: campaignCount }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(entries).where(and(eq(entries.participantId, s.participantId), eq(entries.campaignId, s.campaignId), eq(entries.status, "active")));
    const evaluation = evaluate(facts, rules, { intakeAt: s.intakeAt, campaignOpen: !!s.periodCode && campaign.status === "active", windowStart: rules.purchaseWindow?.start ?? campaign.startsAt, windowEnd: rules.purchaseWindow?.end ?? campaign.endsAt, selectedOutletId: s.selectedOutletId, selectedOutletParticipating: !!(selectedOutlet && member), enrolled: !!enrollment && !enrollment.withdrawnAt, participantActive: participant?.status === "active", periodEntryCount: periodCount, campaignEntryCount: campaignCount, imageQuality: (asset.quality ?? {}) as Record<string, boolean> });
    let disposition: Disposition | "duplicate" = evaluation.disposition; let reason = evaluation.reason;
    if (controls.pauseAutoQualify && disposition === "qualified") { disposition = "review"; reason = "auto_qualification_paused"; }

    // duplicate evidence: exact bytes, visual candidates (search signal only), canonical purchase identity
    const key = receiptKey(s.selectedOutletId, facts.transaction.date, facts.transaction.receiptNo);
    const exact = await this.db.select({ id: submissions.id, status: submissions.status }).from(submissions).innerJoin(mediaAssets, eq(mediaAssets.id, submissions.mediaAssetId)).where(and(eq(mediaAssets.sha256, asset.sha256), eq(submissions.campaignId, s.campaignId), ne(submissions.id, submissionId))).limit(5);
    const visual = await this.visualCandidates(asset, s);

    const out = await this.db.transaction(async (tx) => {
      for (const c of exact) await tx.insert(duplicateCandidates).values({ id: newId("dup"), submissionId, candidateSubmissionId: c.id, kind: "exact_bytes", score: 1 }).onConflictDoNothing();
      for (const c of visual) await tx.insert(duplicateCandidates).values({ id: newId("dup"), submissionId, candidateSubmissionId: c.id, kind: c.kind, score: c.score }).onConflictDoNothing();
      let canonical = key ? (await tx.select().from(canonicalReceipts).where(and(eq(canonicalReceipts.campaignId, s.campaignId), eq(canonicalReceipts.receiptKey, key))).for("update"))[0] ?? null : null;
      let dupOf: string | null = null;
      if (canonical && canonical.firstSubmissionId !== submissionId) {
        const [first] = await tx.select().from(submissions).where(eq(submissions.id, canonical.firstSubmissionId));
        const tot = facts.transaction.totalMinor;
        if (canonical.totalMinor != null && tot != null && canonical.totalMinor !== tot) { disposition = "review"; reason = "identity_conflict"; await tx.insert(duplicateCandidates).values({ id: newId("dup"), submissionId, candidateSubmissionId: canonical.creditedSubmissionId ?? canonical.firstSubmissionId, kind: "canonical", score: 0.5 }).onConflictDoNothing(); }
        else if (canonical.status === "credited") dupOf = canonical.creditedSubmissionId ?? canonical.firstSubmissionId;
        else if (first && first.participantId !== s.participantId && (["review", "received", "processing", "delayed"].includes(first.status) || disposition === "qualified")) { disposition = "review"; reason = "ownership_dispute"; }
        else if (first && first.participantId === s.participantId && !s.reuploadOf) await tx.update(submissions).set({ reuploadOf: first.id }).where(eq(submissions.id, submissionId));
      }
      if (!dupOf && exact.length) { const credited = exact.find((c) => c.status === "qualified"); if (credited) dupOf = credited.id; }
      if (dupOf) { disposition = "duplicate"; reason = "duplicate_receipt"; await tx.insert(duplicateCandidates).values({ id: newId("dup"), submissionId, candidateSubmissionId: dupOf, kind: "canonical", score: 1, resolution: "same_purchase" }).onConflictDoNothing(); }
      let canonicalId = canonical?.id ?? null;
      if (key && !canonical && disposition !== "duplicate") {
        canonicalId = newId("rcp");
        const ins = await tx.insert(canonicalReceipts).values({ id: canonicalId, campaignId: s.campaignId, receiptKey: key, outletId: s.selectedOutletId, txnDate: facts.transaction.date, receiptNo: facts.transaction.receiptNo, totalMinor: facts.transaction.totalMinor, firstSubmissionId: submissionId, status: disposition === "qualified" ? "credited" : "pending" }).onConflictDoNothing().returning({ id: canonicalReceipts.id });
        if (!ins.length) { // concurrent loser: the row now exists
          const [w] = await tx.select().from(canonicalReceipts).where(and(eq(canonicalReceipts.campaignId, s.campaignId), eq(canonicalReceipts.receiptKey, key))); canonicalId = w.id;
          if (w.status === "credited" || w.firstSubmissionId !== submissionId) { disposition = "duplicate"; reason = "duplicate_receipt"; await tx.insert(duplicateCandidates).values({ id: newId("dup"), submissionId, candidateSubmissionId: w.creditedSubmissionId ?? w.firstSubmissionId, kind: "canonical", score: 1, resolution: "same_purchase" }).onConflictDoNothing(); }
        }
      }
      return this.commit(tx, { s, version: version.configHash, facts, evaluation, disposition, reason, canonicalId, attemptNo, decidedBy: "system", units: evaluation.units || rules.award.unitsPerReceipt });
    });
    await this.deps.alerts.metric("submission.decided", 1, { disposition: out.decision, campaignId: s.campaignId });
    return out;
  }

  private async visualCandidates(asset: typeof mediaAssets.$inferSelect, s: Submission) {
    if (!asset.ahash && !asset.dhash) return [];
    const rows = await this.db.select({ id: submissions.id, ahash: mediaAssets.ahash, dhash: mediaAssets.dhash }).from(submissions).innerJoin(mediaAssets, eq(mediaAssets.id, submissions.mediaAssetId)).where(and(eq(submissions.campaignId, s.campaignId), ne(submissions.id, s.id))).orderBy(desc(submissions.createdAt)).limit(4000);
    const out: Array<{ id: string; kind: string; score: number; distance: number }> = [];
    for (const r of rows) { const da = hamming(asset.ahash, r.ahash), dd = hamming(asset.dhash, r.dhash); const d = Math.min(da, dd); if (d <= PROBABLE_VISUAL_DISTANCE) out.push({ id: r.id, kind: da <= dd ? "visual_ahash" : "visual_dhash", score: Number((1 - d / 64).toFixed(3)), distance: d }); }
    return out.sort((a, b) => a.distance - b.distance).slice(0, 5);
  }

  private async delay(s: Submission, why: string) {
    const [{ n: tries }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(extractions).where(eq(extractions.submissionId, s.id));
    await this.db.transaction(async (tx) => {
      await tx.update(submissions).set({ status: "delayed", reasonCode: why, version: sql`${submissions.version} + 1` }).where(eq(submissions.id, s.id));
      await this.deps.audit.record(tx, { actorType: "system", actorId: "pipeline", action: "submission.delayed", targetType: "submission", targetId: s.id, campaignId: s.campaignId, reason: why });
      const p = await this.deps.participants.get(s.participantId); const content = await this.contentFor(s.campaignId);
      if (p && p.status === "active") await this.deps.outbox.enqueue(tx, { channelUid: p.channelUid, purpose: "submission_outcome", campaignId: s.campaignId, payload: render(content, "delayed", { reference: s.reference }), idempotencyKey: `submission:${s.id}:delayed`, correlationId: s.correlationId });
      if (tries < 6) await this.deps.queue.enqueueJob(tx, "submission.process", { submissionId: s.id }, { runAfter: new Date(Date.now() + Math.min(2 ** tries, 20) * 60_000).toISOString(), correlationId: s.correlationId, dedupeKey: `process:${s.id}:${tries}` });
      else await this.deps.alerts.raise({ kind: "submission.stuck", severity: "critical", message: `submission ${s.reference} delayed after ${tries} attempts`, runbook: "docs/runbooks/media-and-extraction.md" });
    });
    return { submissionId: s.id, decision: "delayed", reason: why };
  }
  private async contentFor(campaignId: string) { const v = await this.deps.campaigns.activeVersion(campaignId); return this.deps.campaigns.contentOf(v).messages; }

  /** Single integrity path for automatic and reviewer decisions (inside a transaction). */
  private async commit(tx: DbOrTx, a: { s: Submission; version: string; facts: Facts | null; evaluation: Evaluation | null; disposition: Disposition | "duplicate"; reason: string; canonicalId: string | null; attemptNo: number; decidedBy: string; note?: string | null; units: number }) {
    const { s, facts, evaluation, disposition, reason, canonicalId } = a; const isReview = a.decidedBy !== "system"; const now = new Date().toISOString();
    if (facts) {
      await tx.insert(extractions).values({ id: newId("ext"), submissionId: s.id, attemptNo: a.attemptNo, provider: facts.provider, model: facts.model, promptVersion: facts.promptVersion, schemaVersion: facts.schema, ocrText: facts.ocrText.slice(0, 20_000), facts: { document: facts.document, merchant: facts.merchant, transaction: facts.transaction, quality: facts.quality }, ruleResults: evaluation?.rules ?? [], disposition, confidence: facts.quality.confidence, latencyMs: facts.latencyMs, raw: facts.raw });
      await tx.delete(submissionItems).where(eq(submissionItems.submissionId, s.id));
      if (facts.lines.length) await tx.insert(submissionItems).values(facts.lines.map((l) => ({ id: newId("itm"), submissionId: s.id, lineNo: l.n, rawText: l.raw.slice(0, 200), description: l.description.slice(0, 160), quantity: l.quantity, packGrams: l.packGrams, amountMinor: l.amountMinor, voided: l.voided, productCode: l.product?.code ?? null, evidence: { unitMinor: l.unitMinor, basis: l.product?.basis ?? null } })));
    }
    await tx.update(submissions).set({ status: disposition, reasonCode: reason, decidedBy: a.decidedBy, decidedAt: now, canonicalReceiptId: canonicalId ?? s.canonicalReceiptId, version: sql`${submissions.version} + 1` }).where(eq(submissions.id, s.id));
    let entryId: string | null = null;
    if (disposition === "qualified") {
      if (!canonicalId) throw err("INTEGRITY", "a qualified receipt must carry a canonical identity");
      const [existing] = await tx.select({ id: entries.id }).from(entries).where(and(eq(entries.canonicalReceiptId, canonicalId), eq(entries.status, "active")));
      if (existing) throw err("INTEGRITY", "canonical receipt already credited", { entryId: existing.id });
      entryId = newId("ent");
      await tx.insert(entries).values({ id: entryId, campaignId: s.campaignId, campaignVersionId: s.campaignVersionId, participantId: s.participantId, submissionId: s.id, canonicalReceiptId: canonicalId, periodCode: s.periodCode, units: Math.max(1, a.units), status: "active", awardedBy: a.decidedBy });
      await tx.update(canonicalReceipts).set({ status: "credited", creditedSubmissionId: s.id, creditedEntryId: entryId }).where(eq(canonicalReceipts.id, canonicalId));
      await this.deps.audit.record(tx, { actorType: isReview ? "staff" : "system", actorId: a.decidedBy, action: "entry.awarded", targetType: "entry", targetId: entryId, campaignId: s.campaignId, correlationId: s.correlationId, payload: { submissionId: s.id, canonicalId, periodCode: s.periodCode, rulesVersion: a.version, units: a.units } });
      const outlet = s.selectedOutletId ? await this.deps.campaigns.outlet(s.selectedOutletId) : null; const camp = await this.deps.campaigns.get(s.campaignId);
      await this.deps.crm?.emit({ entityType: "entry", entityId: entryId, entityVersion: 1, payload: { participantId: s.participantId, campaignCode: camp?.code, period: s.periodCode, outletCode: outlet?.code, reference: s.reference, status: "active", awardedAt: now }, correlationId: s.correlationId });
    } else if (disposition === "review") {
      await tx.insert(reviewTasks).values({ id: newId("rvw"), submissionId: s.id, state: "open", reasonCode: reason, slaDueAt: new Date(Date.now() + this.deps.reviewSlaHours * 3_600_000).toISOString() }).onConflictDoNothing();
    }
    await this.deps.audit.record(tx, { actorType: isReview ? "staff" : "system", actorId: a.decidedBy, action: `submission.${disposition}`, targetType: "submission", targetId: s.id, campaignId: s.campaignId, correlationId: s.correlationId, reason, payload: { entryId, canonicalId, note: a.note ?? null, failed: evaluation?.rules.filter((r) => r.outcome !== "pass").map((r) => `${r.rule}:${r.outcome}`) ?? null } });
    const camp2 = await this.deps.campaigns.get(s.campaignId); const outlet2 = s.selectedOutletId ? await this.deps.campaigns.outlet(s.selectedOutletId) : null;
    await this.deps.crm?.emit({ entityType: "submission", entityId: s.id, entityVersion: a.attemptNo + (isReview ? 100 : 0), payload: { participantId: s.participantId, campaignCode: camp2?.code, reference: s.reference, outletCode: outlet2?.code, status: disposition, reason, intakeAt: s.intakeAt }, correlationId: s.correlationId });
    const p = await this.deps.participants.get(s.participantId);
    if (p && p.status === "active") await this.deps.outbox.enqueue(tx, { channelUid: p.channelUid, purpose: "submission_outcome", campaignId: s.campaignId, payload: await this.outcomeMessage(tx, s, disposition, reason, isReview), idempotencyKey: `submission:${s.id}:outcome:${a.attemptNo}:${isReview ? "review" : "auto"}`, correlationId: s.correlationId });
    return { submissionId: s.id, decision: disposition, reason, entryId };
  }
  private async outcomeMessage(tx: DbOrTx, s: Submission, disposition: string, reason: string, isReview: boolean) {
    const v = await this.deps.campaigns.activeVersion(s.campaignId); const M = this.deps.campaigns.contentOf(v).messages; const flags = this.deps.campaigns.flagsOf(v); const rules = this.deps.campaigns.rulesOf(v); const camp = await this.deps.campaigns.get(s.campaignId);
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(entries).where(and(eq(entries.participantId, s.participantId), eq(entries.campaignId, s.campaignId), eq(entries.status, "active")));
    const countLine = flags.participantStatus && disposition === "qualified" ? render(M, "qualified_count", { count: n, entries_word: n === 1 ? "entry" : "entries" }) : "";
    const vars = { reference: s.reference, campaign: camp?.name ?? "the promotion", reason: reasonText(M, reason, { min_packs: rules.qualification.minPacks, pack_label: `${rules.qualification.packGrams / 1000}kg pack` }), count_line: countLine };
    const key = ({ qualified: isReview ? "review_qualified" : "qualified", not_qualified: isReview ? "review_not_qualified" : "not_qualified", duplicate: isReview ? "review_duplicate" : "duplicate", review: "under_review", reupload: isReview ? "review_reupload" : "reupload" } as Record<string, string>)[disposition] ?? "under_review";
    return render(M, key, vars);
  }

  /** Reviewer decision: same commit path; optimistic version check; a reviewer cannot bypass the unique award. */
  async review(submissionId: string, { reviewerId, decision, reasonCode, note, expectedVersion }: { reviewerId: string; decision: "qualified" | "not_qualified" | "duplicate" | "reupload"; reasonCode?: string | null; note?: string | null; expectedVersion?: number | null }) {
    if (!["qualified", "not_qualified", "duplicate", "reupload"].includes(decision)) throw invalid("invalid decision");
    return this.db.transaction(async (tx) => {
      const [s] = await tx.select().from(submissions).where(eq(submissions.id, submissionId)).for("update"); if (!s) throw notFound("submission");
      if (expectedVersion != null && s.version !== expectedVersion) throw conflict("the submission changed since you loaded it; reload");
      const [task] = await tx.select().from(reviewTasks).where(eq(reviewTasks.submissionId, submissionId)).for("update");
      if (task?.state === "decided") throw conflict("already decided");
      if (s.status === "qualified") throw conflict("already credited; use disqualification");
      if (decision !== "qualified" && !reasonCode) throw invalid("a reason code is required for a non-qualifying decision");
      const version = (await this.deps.campaigns.version(s.campaignVersionId))!; const rules = this.deps.campaigns.rulesOf(version);
      const [last] = await tx.select().from(extractions).where(eq(extractions.submissionId, submissionId)).orderBy(desc(extractions.attemptNo)).limit(1);
      const facts = (last?.facts ?? {}) as { transaction?: { date?: string | null; receiptNo?: string | null; totalMinor?: number | null } };
      let canonicalId = s.canonicalReceiptId; let disposition: Disposition | "duplicate" = decision; let reason = reasonCode ?? "ok";
      if (decision === "qualified") {
        const key = receiptKey(s.selectedOutletId, facts.transaction?.date ?? null, facts.transaction?.receiptNo ?? null);
        if (!key) throw err("IDENTITY_INCOMPLETE", "cannot credit: outlet, date and receipt number must all be readable — correct the facts first");
        const [can] = await tx.select().from(canonicalReceipts).where(and(eq(canonicalReceipts.campaignId, s.campaignId), eq(canonicalReceipts.receiptKey, key))).for("update");
        if (can && can.status === "credited" && can.creditedSubmissionId !== submissionId) { disposition = "duplicate"; reason = "duplicate_receipt"; canonicalId = can.id; }
        else if (!can) { canonicalId = newId("rcp"); await tx.insert(canonicalReceipts).values({ id: canonicalId, campaignId: s.campaignId, receiptKey: key, outletId: s.selectedOutletId, txnDate: facts.transaction?.date ?? null, receiptNo: facts.transaction?.receiptNo ?? null, totalMinor: facts.transaction?.totalMinor ?? null, firstSubmissionId: submissionId, status: "pending" }); }
        else canonicalId = can.id;
      }
      await tx.update(reviewTasks).set({ state: "decided", decision: disposition, decisionReason: reason, note: note ?? null, decidedBy: reviewerId, decidedAt: new Date().toISOString(), version: sql`${reviewTasks.version} + 1` }).where(eq(reviewTasks.submissionId, submissionId));
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(extractions).where(eq(extractions.submissionId, submissionId));
      return this.commit(tx, { s, version: version.configHash, facts: null, evaluation: null, disposition, reason, canonicalId, attemptNo: n, decidedBy: reviewerId, note, units: rules.award.unitsPerReceipt });
    });
  }
  /** Reviewer corrects readable facts (date, receipt number, total) with a note; recorded as a new extraction attempt by the reviewer. */
  async correctFacts(submissionId: string, patch: { date?: string | null; receiptNo?: string | null; totalMinor?: number | null }, reviewerId: string, note: string) {
    if (!note) throw invalid("a note is required");
    const s = await this.get(submissionId); if (!s) throw notFound("submission"); if (TERMINAL.has(s.status) && s.status !== "review") throw conflict("only submissions under review can be corrected");
    const [last] = await this.db.select().from(extractions).where(eq(extractions.submissionId, submissionId)).orderBy(desc(extractions.attemptNo)).limit(1);
    const facts = { ...(last?.facts as Record<string, unknown> ?? {}) } as { transaction?: Record<string, unknown> };
    const tx0 = { ...(facts.transaction ?? {}) } as Record<string, unknown>;
    if (patch.date !== undefined) { if (patch.date && !/^\d{4}-\d{2}-\d{2}$/.test(patch.date)) throw invalid("date must be YYYY-MM-DD"); tx0.date = patch.date; tx0.dateAmbiguous = false; }
    if (patch.receiptNo !== undefined) tx0.receiptNo = patch.receiptNo ? patch.receiptNo.toUpperCase().replace(/[^A-Z0-9]/g, "") : null;
    if (patch.totalMinor !== undefined) tx0.totalMinor = patch.totalMinor;
    await this.db.insert(extractions).values({ id: newId("ext"), submissionId, attemptNo: (last?.attemptNo ?? 0) + 1, provider: `reviewer:${reviewerId}`, model: "manual-correction", schemaVersion: "receipt-facts/1", ocrText: last?.ocrText ?? null, facts: { ...facts, transaction: tx0 }, ruleResults: [], disposition: null, raw: { correctedFrom: last?.id ?? null, note } });
    await this.deps.audit.record(this.db, { actorType: "staff", actorId: reviewerId, action: "submission.facts_corrected", targetType: "submission", targetId: submissionId, campaignId: s.campaignId, reason: note, payload: patch as Record<string, unknown> });
    return { ok: true };
  }
  async assign(submissionId: string, reviewerId: string) { const [t] = await this.db.select().from(reviewTasks).where(eq(reviewTasks.submissionId, submissionId)); if (!t) throw notFound("review task"); if (t.state === "decided") throw conflict("already decided"); if (t.assignee && t.assignee !== reviewerId) throw conflict("assigned to another reviewer"); await this.db.update(reviewTasks).set({ state: "assigned", assignee: reviewerId, assignedAt: new Date().toISOString() }).where(eq(reviewTasks.id, t.id)); }
  async release(submissionId: string, reviewerId: string) { await this.db.update(reviewTasks).set({ state: "open", assignee: null, assignedAt: null }).where(and(eq(reviewTasks.submissionId, submissionId), eq(reviewTasks.assignee, reviewerId), eq(reviewTasks.state, "assigned"))); }
  async escalate(submissionId: string, reviewerId: string, note: string) { await this.db.update(reviewTasks).set({ state: "escalated", note }).where(and(eq(reviewTasks.submissionId, submissionId), ne(reviewTasks.state, "decided"))); await this.deps.audit.record(this.db, { actorType: "staff", actorId: reviewerId, action: "review.escalated", targetType: "submission", targetId: submissionId, reason: note }); }
  async resolveDuplicate(candidateId: string, resolution: "same_purchase" | "different_purchase", reviewerId: string, note?: string | null) {
    const [c] = await this.db.select().from(duplicateCandidates).where(eq(duplicateCandidates.id, candidateId)); if (!c) throw notFound("candidate");
    await this.db.update(duplicateCandidates).set({ resolution, resolvedBy: reviewerId, resolvedAt: new Date().toISOString(), note: note ?? null }).where(eq(duplicateCandidates.id, candidateId));
    await this.deps.audit.record(this.db, { actorType: "staff", actorId: reviewerId, action: "duplicate.resolved", targetType: "submission", targetId: c.submissionId, reason: resolution, payload: { candidate: c.candidateSubmissionId, note } });
  }
  /** Safe reprocessing of a non-credited submission: new extraction attempt through the normal path. */
  async reprocess(submissionId: string, actorId: string, reason: string) {
    const s = await this.get(submissionId); if (!s) throw notFound("submission"); if (s.status === "qualified") throw conflict("credited submissions are not reprocessed; use disqualification");
    await this.db.transaction(async (tx) => { await tx.update(submissions).set({ status: "received", version: sql`${submissions.version} + 1` }).where(eq(submissions.id, submissionId)); await tx.update(reviewTasks).set({ state: "decided", decision: "reprocessed", decidedBy: actorId, decidedAt: new Date().toISOString() }).where(and(eq(reviewTasks.submissionId, submissionId), ne(reviewTasks.state, "decided"))); await this.deps.queue.enqueueJob(tx, "submission.process", { submissionId }, { dedupeKey: `reprocess:${submissionId}:${Date.now()}` }); await this.deps.audit.record(tx, { actorType: "staff", actorId, action: "submission.reprocess", targetType: "submission", targetId: submissionId, campaignId: s.campaignId, reason }); });
    return { queued: true };
  }
  /** Authorised disqualification: the award stays; current eligibility derives from events. Frozen/executed draws need an independent approver. */
  async disqualifyEntry(entryId: string, { actorId, reason, approvedBy, note }: { actorId: string; reason: string; approvedBy?: string | null; note?: string | null }) {
    if (!reason) throw invalid("reason required");
    return this.db.transaction(async (tx) => {
      const [e] = await tx.select().from(entries).where(eq(entries.id, entryId)).for("update"); if (!e) throw notFound("entry"); if (e.status !== "active") throw conflict(`entry is ${e.status}`);
      const frozen = await tx.select({ id: draws.id, status: draws.status }).from(drawCandidates).innerJoin(draws, eq(draws.id, drawCandidates.drawId)).where(and(eq(drawCandidates.entryId, entryId), inArray(draws.status, ["frozen", "executing", "executed", "approved", "published"])));
      if (frozen.length && !approvedBy) throw err("APPROVAL_REQUIRED", "the entry is in a frozen or executed draw: an independent approver is required");
      if (approvedBy && approvedBy === actorId) throw err("SOD", "the approver must differ from the actor");
      await tx.update(entries).set({ status: "excluded" }).where(eq(entries.id, entryId));
      await tx.insert(entryEvents).values({ id: newId("eev"), entryId, type: "disqualified", reason, actorId, approvedBy: approvedBy ?? null, note: note ?? null });
      await this.deps.audit.record(tx, { actorType: "staff", actorId, action: "entry.disqualified", targetType: "entry", targetId: entryId, campaignId: e.campaignId, reason, payload: { approvedBy, affectedDraws: frozen.map((d) => d.id) } });
      const camp = await this.deps.campaigns.get(e.campaignId);
      await this.deps.crm?.emit({ entityType: "entry", entityId: entryId, entityVersion: 2, payload: { participantId: e.participantId, campaignCode: camp?.code, period: e.periodCode, status: "excluded" } });
      return { entryId, affectedDraws: frozen };
    });
  }
  async reinstateEntry(entryId: string, { actorId, reason, approvedBy }: { actorId: string; reason: string; approvedBy?: string | null }) {
    return this.db.transaction(async (tx) => {
      const [e] = await tx.select().from(entries).where(eq(entries.id, entryId)).for("update"); if (!e || e.status !== "excluded") throw conflict("entry is not excluded");
      await tx.update(entries).set({ status: "active" }).where(eq(entries.id, entryId));
      await tx.insert(entryEvents).values({ id: newId("eev"), entryId, type: "reinstated", reason, actorId, approvedBy: approvedBy ?? null });
      await this.deps.audit.record(tx, { actorType: "staff", actorId, action: "entry.reinstated", targetType: "entry", targetId: entryId, campaignId: e.campaignId, reason });
      return { entryId };
    });
  }
  async reviewQueue() {
    const open = await this.db.select({ t: reviewTasks, s: submissions }).from(reviewTasks).innerJoin(submissions, eq(submissions.id, reviewTasks.submissionId)).where(ne(reviewTasks.state, "decided")).orderBy(asc(reviewTasks.createdAt));
    const byReason: Record<string, number> = {}; for (const r of open) byReason[r.t.reasonCode ?? "unknown"] = (byReason[r.t.reasonCode ?? "unknown"] || 0) + 1;
    return { count: open.length, oldest: open[0]?.t.createdAt ?? null, overdue: open.filter((r) => Date.parse(r.t.slaDueAt) < Date.now()).length, byReason, items: open.map((r) => ({ submissionId: r.s.id, reference: r.s.reference, reason: r.t.reasonCode, state: r.t.state, assignee: r.t.assignee, slaDueAt: r.t.slaDueAt, ageMinutes: Math.round((Date.now() - Date.parse(r.t.createdAt)) / 60000), period: r.s.periodCode, campaignId: r.s.campaignId })) };
  }
}
