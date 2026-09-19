import { eq, and, sql, desc, asc, ne, lt, inArray } from "drizzle-orm";
import { schema, type Db, type DbOrTx } from "@promo/db";
import { newId, newReference } from "../util/ids.ts";
import { conflict, invalid, notFound, err } from "../util/errors.ts";
import { MediaRejected } from "../media/images.ts";
import type { MediaService } from "../media/service.ts";
import type { Extractor, Facts, FiscalEvidence } from "../extraction/types.ts";
import { ExtractorUnavailable, emptyFacts } from "../extraction/types.ts";
import { evaluate, type Evaluation, type Disposition } from "../eligibility/rules.ts";
import type { CampaignService } from "../campaign/service.ts";
import type { ParticipantService } from "../participant/service.ts";
import type { AuditService } from "../audit.ts";
import type { OutboxService } from "../ops/outbox.ts";
import type { QueueService } from "../ops/queue.ts";
import type { CrmEmitter } from "../conversation/engine.ts";
import { render, reasonText } from "../conversation/copy.ts";
import { maskPhone } from "../util/phone.ts";
import type { AiVerificationService } from "../verification/service.ts";
import type { FiscalService } from "../fiscal/service.ts";
import { isAuthoritative, type FiscalVerification } from "../fiscal/types.ts";
import { reconcile, REQUIRED_FIELDS, type UserEvidence } from "../fiscal/reconcile.ts";
import { decideTier, verificationReport, type DuplicateSignal, type TierDecision } from "../fiscal/tiers.ts";
import type { EvidenceField } from "../fiscal/evidence.ts";

const { submissions, participants, extractions, submissionItems, canonicalReceipts, duplicateCandidates, reviewTasks, entries, entryEvents, mediaAssets, drawCandidates, draws, verificationOutcomes } = schema;
export type Submission = typeof submissions.$inferSelect;
const TERMINAL = new Set(["qualified", "not_qualified", "duplicate", "review", "reupload"]);
/**
 * A submission that has not reached an outcome yet.
 *
 * `awaiting_participant` belongs here: a receipt waiting on someone to say
 * which shop it came from is every bit as unresolved as one waiting on a
 * reviewer, and a draw must not close over it.
 */
export const UNRESOLVED_STATUSES = ["received", "processing", "delayed", "review", "awaiting_participant"] as const;
/** What the participant sees when we ask for one specific thing. */
const formatMinor = (m: number) => `${(m / 100).toFixed(2)}`;
export const FIELD_LABELS: Record<string, string> = { outletId: "the shop where you bought", date: "the purchase date", receiptNo: "the receipt number", total: "the total amount", merchant: "the shop name", branch: "the branch" };
/** Reads resolved before the audit chain's lock is taken. See commitContext(). */
export type CommitContext = Awaited<ReturnType<ReceiptPipeline["commitContext"]>>;
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

/**
 * Fiscal provenance for the extraction record: what was decoded, what the
 * authority said, and nothing that could be replayed as a request. The decoded
 * URL is deliberately absent — only its hash is kept — so a receipt's code
 * cannot be lifted out of the evidence trail and followed later.
 */
export function fiscalEvidence(v: FiscalVerification): FiscalEvidence {
  return {
    attempted: v.status !== "not_attempted",
    status: v.status,
    decoder: v.contractVersion,
    format: v.reference?.format ?? null,
    codeSha256: v.reference?.sha256 ?? null,
    qrHost: v.reference?.host ?? null,
    deviceId: v.record?.deviceId ?? v.reference?.deviceId ?? null,
    receiptGlobalNo: v.record?.receiptGlobalNo ?? v.reference?.receiptGlobalNo ?? null,
    fiscalDayNo: v.record?.fiscalDayNo ?? v.reference?.fiscalDayNo ?? null,
    verificationCodePresent: Boolean(v.record?.verificationCode ?? v.reference?.verificationCode),
    validated: v.record?.validated === true,
    fetchedAt: v.fetchedAt,
    warnings: v.warnings,
    errorCode: v.errorCode,
  };
}

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
  constructor(private db: Db, private deps: { media: MediaService; extractor: Extractor; campaigns: CampaignService; participants: ParticipantService; audit: AuditService; outbox: OutboxService; queue: QueueService; crm?: CrmEmitter | null; alerts: AlertSink; reviewSlaHours: number; verifier?: AiVerificationService; fiscal?: FiscalService }) {}

  async get(id: string) { const [s] = await this.db.select().from(submissions).where(eq(submissions.id, id)); return s ?? null; }
  async statusOf(id: string) { const [s] = await this.db.select({ status: submissions.status }).from(submissions).where(eq(submissions.id, id)); return s?.status ?? null; }

  /**
   * What the system established about a submission, ready to be put to the
   * participant, plus whatever it could not.
   *
   * Only fields with real evidence are shown, and each carries the source that
   * established it — a branch the revenue authority confirmed and a branch OCR
   * guessed at are not the same claim, and the reviewer sees the difference
   * even when the participant does not.
   */
  async confirmationFor(submissionId: string): Promise<{ submissionId: string; reference: string; details: Array<{ field: string; label: string; value: string; source: string }>; pendingFields: string[] } | null> {
    const s = await this.get(submissionId); if (!s) return null;
    const [last] = await this.db.select().from(extractions).where(eq(extractions.submissionId, submissionId)).orderBy(desc(extractions.attemptNo)).limit(1);
    const ledger = ((last?.facts as { ledger?: { fields?: Record<string, { value: unknown; source: string | null; status: string }> } } | null)?.ledger?.fields) ?? {};
    const outletIds = Object.entries(ledger).filter(([f]) => f === "outletId").map(([, v]) => String(v.value ?? ""));
    const outlet = outletIds[0] ? await this.deps.campaigns.outlet(outletIds[0]) : null;
    const order: Array<[string, string]> = [["outletId", "Shop"], ["date", "Purchase date"], ["total", "Amount"], ["receiptNo", "Receipt number"], ["qualifyingUnits", "Qualifying packs"]];
    const details = order.flatMap(([field, label]) => {
      const e = ledger[field]; if (!e || e.value == null || e.status === "absent") return [];
      const value = field === "outletId" ? (outlet ? `${outlet.retailer} — ${outlet.branch}, ${outlet.town}` : String(e.value))
        : field === "total" ? formatMinor(Number(e.value))
        : String(e.value);
      return [{ field, label, value, source: e.source ?? "unknown" }];
    });
    return { submissionId, reference: s.reference, details, pendingFields: s.pendingFields ?? [] };
  }

  /**
   * Record what the participant said and re-run verification.
   *
   * Their answer is stored as evidence at the lowest authority and merged into
   * the ledger on the next pass, where it is reconciled against the receipt and
   * the fiscal record. It is never written over a stronger source: if they say
   * Borrowdale and the authority says Avondale, the ledger keeps both and the
   * submission goes to a reviewer.
   *
   * A confirmation settles the submission; a rejection is a referral, because
   * a participant contradicting an authoritative record is precisely the case
   * that should not be resolved by letting them retype it.
   */
  async applyUserEvidence(submissionId: string, evidence: Record<string, unknown>, opts: { confirmed?: boolean; rejected?: boolean } = {}) {
    const s = await this.get(submissionId); if (!s) throw notFound("submission");
    const merged = { ...((s.userEvidence ?? {}) as Record<string, unknown>), ...evidence };
    await this.db.transaction(async (tx) => {
      // A dispute is sticky. Re-running verification must not quietly qualify a
      // submission the participant has told us is wrong — that is precisely the
      // case a human should see.
      if (opts.rejected) merged.__disputed = true;
      await tx.update(submissions).set({ userEvidence: merged, pendingFields: [], status: "received", version: sql`${submissions.version} + 1` }).where(eq(submissions.id, submissionId));
      await this.deps.audit.record(tx, {
        actorType: "participant", actorId: s.participantId,
        action: opts.rejected ? "submission.participant_disputed" : opts.confirmed ? "submission.participant_confirmed" : "submission.participant_supplied",
        targetType: "submission", targetId: submissionId, campaignId: s.campaignId, correlationId: s.correlationId,
        payload: { fields: Object.keys(evidence), disputed: !!opts.rejected },
      });
      if (opts.rejected) await tx.insert(reviewTasks).values({ id: newId("rvw"), submissionId, state: "open", reasonCode: "participant_disputed", slaDueAt: new Date(Date.now() + this.deps.reviewSlaHours * 3_600_000).toISOString() }).onConflictDoNothing();
      await this.deps.queue.enqueueJob(tx, "submission.process", { submissionId }, { dedupeKey: `confirm:${submissionId}:${Date.now()}`, correlationId: s.correlationId });
    });
    return { queued: true };
  }

  /**
   * Durable intake. The outlet is optional now: the receipt is the primary
   * input, and where it was bought is something the system works out from the
   * fiscal record or the image, asking the participant only if neither can say.
   */
  async submit(input: { campaignId: string; campaignVersionId: string; participantId: string; conversationId: string; inboundEventId: string; providerMessageId: string; uid: string; imageBytes: Buffer; selectedOutletId?: string | null; correlationId?: string | null; eventAt?: string | null; reuploadOf?: string | null }) {
    const [existing] = await this.db.select().from(submissions).where(eq(submissions.providerMessageId, input.providerMessageId));
    if (existing) return { submissionId: existing.id, reference: existing.reference, replay: true };
    let media; try { media = await this.deps.media.store({ bytes: input.imageBytes, campaignId: input.campaignId }); } catch (e) { if (e instanceof MediaRejected) throw Object.assign(new Error(e.message), { code: "MEDIA_REJECTED" }); throw e; }
    const intakeAt = new Date().toISOString();
    const period = await this.deps.campaigns.periodAt(input.campaignId, intakeAt);
    const id = newId("sub"); const reference = newReference();
    await this.db.transaction(async (tx) => {
      await tx.insert(submissions).values({ id, reference, campaignId: input.campaignId, campaignVersionId: input.campaignVersionId, participantId: input.participantId, conversationId: input.conversationId, inboundEventId: input.inboundEventId, providerMessageId: input.providerMessageId, mediaAssetId: media.id, selectedOutletId: input.selectedOutletId ?? null, periodCode: period?.code ?? null, status: "received", eventAt: input.eventAt ?? intakeAt, intakeAt, reuploadOf: input.reuploadOf ?? null, correlationId: input.correlationId ?? null });
      await this.deps.audit.record(tx, { actorType: "participant", actorId: input.participantId, action: "submission.received", targetType: "submission", targetId: id, campaignId: input.campaignId, correlationId: input.correlationId, payload: { mediaAssetId: media.id, selectedOutletId: input.selectedOutletId ?? null, periodCode: period?.code ?? null } });
      await this.deps.queue.enqueueJob(tx, "submission.process", { submissionId: id }, { correlationId: input.correlationId, dedupeKey: `process:${id}` });
    });
    await this.deps.alerts.metric("submission.received", 1, { campaignId: input.campaignId });
    return { submissionId: id, reference, replay: false };
  }

  /**
   * Decide one submission from the strongest evidence available.
   *
   * The order is the point. The fiscal authority is asked first, because when
   * it answers it is describing what the till transmitted rather than what a
   * camera could read. OCR and the model still run either way — not as a
   * fallback for the facts, but because the image is what proves the document
   * the participant photographed is the transaction the authority confirmed.
   * The participant's own answers come last and are reconciled, never assumed.
   *
   * Nothing here decides anything on a self-reported confidence score. The
   * ledger records what each source asserted, the deterministic rules judge the
   * resolved values, and decideTier() turns those facts plus the duplicate and
   * anomaly signals into a disposition.
   */
  async process(submissionId: string): Promise<{ submissionId: string; decision: string; reason: string | null; entryId?: string | null; alreadyDecided?: boolean; tier?: string; pendingFields?: string[] }> {
    const s = await this.get(submissionId); if (!s) throw notFound("submission");
    if (TERMINAL.has(s.status)) return { submissionId, decision: s.status, reason: s.reasonCode, alreadyDecided: true };
    const claimed = await this.db.update(submissions).set({ status: "processing", version: sql`${submissions.version} + 1` }).where(and(eq(submissions.id, submissionId), inArray(submissions.status, ["received", "delayed", "processing", "awaiting_participant"]))).returning({ id: submissions.id });
    if (!claimed.length) { const cur = await this.get(submissionId); return { submissionId, decision: cur!.status, reason: cur!.reasonCode, alreadyDecided: true }; }
    const { campaigns, participants, media, extractor } = this.deps;
    const campaign = (await campaigns.get(s.campaignId))!; const version = (await campaigns.version(s.campaignVersionId))!; const rules = campaigns.rulesOf(version);
    const asset = s.mediaAssetId ? await media.get(s.mediaAssetId) : null;
    const original = asset ? await media.bytes(asset) : null; const normalised = asset ? await media.bytes(asset, { normalised: true }) : null;
    if (!asset || !original || !normalised) return this.delay(s, "media_unavailable");
    const outletsList = await campaigns.campaignOutlets(s.campaignId);
    const context = { outlets: outletsList.map((o) => ({ id: o.id, retailer: o.retailer, branch: o.branch, town: o.town, aliases: o.aliases })), products: rules.products, dateOrder: rules.dateOrder, quality: (asset.quality ?? {}) as Record<string, unknown> };
    const [{ n: attemptNo }] = await this.db.select({ n: sql<number>`count(*)::int + 1` }).from(extractions).where(eq(extractions.submissionId, submissionId));

    // 1. The authority, first. A failure here is never fatal: it downgrades the
    //    submission to the image-evidence path rather than rejecting it.
    const fiscal: FiscalVerification = this.deps.fiscal ? await this.deps.fiscal.verify(original) : { status: "not_attempted", adapter: "none", contractVersion: "n/a", errorCode: null, warnings: [], latencyMs: 0, fetchedAt: null, reference: null, record: null };
    const authoritative = isAuthoritative(fiscal);

    // 2. The image. Still read even when the authority answered, because the
    //    match between paper and record is itself a control.
    let facts: Facts;
    try { facts = await extractor.extract({ original, normalised, mime: asset.mime, context }); }
    catch (e) {
      const ex = e as ExtractorUnavailable;
      await this.db.insert(extractions).values({ id: newId("ext"), submissionId, attemptNo, provider: extractor.name, model: "n/a", schemaVersion: "receipt-facts/1", error: ex.message.slice(0, 400) });
      // With an authoritative record in hand an OCR outage is a degraded
      // corroboration, not an unreadable receipt: carry on with empty facts and
      // let the missing image evidence show up in the ledger.
      if (!authoritative) {
        await this.deps.alerts.raise({ kind: "extraction.failure", severity: "critical", message: `extractor failure: ${ex.message}`, runbook: "docs/runbooks/media-and-extraction.md" });
        return this.delay(s, ex.code ?? "extractor_failed");
      }
      facts = emptyFacts(extractor.name, "unavailable", { quality: { missing: ["ocr"], warnings: ["ocr_unavailable"], confidence: null, injectionSuspected: false } });
    }
    facts = { ...facts, evidence: { fiscal: fiscalEvidence(fiscal) } };

    // 3. Reconcile every source into one ledger.
    const { __disputed: _disputed, ...userEvidence } = (s.userEvidence ?? {}) as UserEvidence & { __disputed?: boolean };
    const rec = reconcile({ fiscal, facts, user: userEvidence, context, packGrams: rules.qualification.packGrams, selectedOutletId: s.selectedOutletId });
    const resolvedOutletId = rec.ledger.value<string>("outletId");
    const resolvedDate = rec.ledger.value<string>("date");
    const resolvedReceiptNo = rec.ledger.value<string>("receiptNo");
    const resolvedTotal = rec.ledger.value<number>("total");

    // 4. Judge the RESOLVED transaction, not whatever OCR happened to read.
    const selectedOutlet = resolvedOutletId ? await campaigns.outlet(resolvedOutletId) : null;
    const member = outletsList.find((o) => o.id === resolvedOutletId);
    const controls = await campaigns.controls(s.campaignId);
    const enrollment = await participants.enrollment(s.participantId, s.campaignId); const participant = await participants.get(s.participantId);
    const [{ n: periodCount }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(entries).where(and(eq(entries.participantId, s.participantId), eq(entries.campaignId, s.campaignId), eq(entries.periodCode, s.periodCode ?? ""), eq(entries.status, "active")));
    const [{ n: campaignCount }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(entries).where(and(eq(entries.participantId, s.participantId), eq(entries.campaignId, s.campaignId), eq(entries.status, "active")));
    // The outlet_match rule asks whether the DOCUMENT says it came from this
    // shop. Only evidence about the document can answer that, so a resolved
    // outlet is offered as a candidate when it came from the fiscal record or
    // the receipt header — never when the participant simply told us. Letting a
    // participant-supplied outlet satisfy the header check would make the rule
    // self-confirming: they name a shop, and naming it proves it.
    const outletEvidence = rec.ledger.resolve("outletId");
    const outletFromDocument = outletEvidence.source === "zimra_fdms" || outletEvidence.source === "ocr" ? resolvedOutletId : null;
    const judged: Facts = { ...facts, transaction: { ...facts.transaction, date: resolvedDate ?? facts.transaction.date, receiptNo: resolvedReceiptNo ?? facts.transaction.receiptNo, totalMinor: resolvedTotal ?? facts.transaction.totalMinor }, lines: rec.lines, merchant: { ...facts.merchant, candidates: outletFromDocument ? [{ outletId: outletFromDocument, score: 1, basis: outletEvidence.source ?? "resolved" }, ...facts.merchant.candidates.filter((c) => c.outletId !== outletFromDocument)] : facts.merchant.candidates } };
    const evaluation = evaluate(judged, rules, { intakeAt: s.intakeAt, campaignOpen: !!s.periodCode && campaign.status === "active", windowStart: rules.purchaseWindow?.start ?? campaign.startsAt, windowEnd: rules.purchaseWindow?.end ?? campaign.endsAt, selectedOutletId: resolvedOutletId, selectedOutletParticipating: !!(selectedOutlet && member), outletResolved: Boolean(resolvedOutletId), enrolled: !!enrollment && !enrollment.withdrawnAt, participantActive: participant?.status === "active", periodEntryCount: periodCount, campaignEntryCount: campaignCount, imageQuality: (asset.quality ?? {}) as Record<string, boolean> });

    // 5. Duplicate evidence, strongest identifier first.
    const fiscalDuplicates = this.deps.fiscal && (fiscal.reference || fiscal.record) ? await this.deps.fiscal.duplicatesOf(s.campaignId, submissionId, fiscal) : [];
    const exact = await this.db.select({ id: submissions.id, status: submissions.status }).from(submissions).innerJoin(mediaAssets, eq(mediaAssets.id, submissions.mediaAssetId)).where(and(eq(mediaAssets.sha256, asset.sha256), eq(submissions.campaignId, s.campaignId), ne(submissions.id, submissionId))).limit(5);
    const visual = await this.visualCandidates(asset, s);

    // The fiscal identity is a far stronger receipt key than outlet|date|number:
    // it names one transaction at one till and does not depend on reading the
    // paper correctly.
    const fiscalKey = this.deps.fiscal && authoritative ? this.deps.fiscal.canonicalKey(fiscal) : null;
    const key = fiscalKey ?? receiptKey(resolvedOutletId, resolvedDate, resolvedReceiptNo);

    // 6. Advisory model assessment. It may withhold, never grant.
    const verification = this.deps.verifier ? await this.deps.verifier.verify({ original, mime: asset.mime, facts: judged, evaluation, rules, duplicateSignals: { exact: exact.length, visual: visual.length } }) : null;
    if (verification) facts = { ...facts, verification, raw: { ...(facts.raw ?? {}), verification } };

    const discrepancies = rec.ledger.discrepancies();
    const missing = rec.ledger.missing(REQUIRED_FIELDS);
    const userCompleted = missing.every((f) => userEvidence[f as EvidenceField] != null) || (s.pendingFields ?? []).length > 0;
    const creditedExact = exact.filter((c) => c.status === "qualified");
    const creditedFiscal = fiscalDuplicates.filter((c) => c.status === "qualified");
    const duplicates: DuplicateSignal = {
      fiscalIdentityCredited: creditedFiscal.length > 0,
      fiscalIdentityOpen: fiscalDuplicates.length - creditedFiscal.length,
      exactImageCredited: creditedExact.length > 0,
      exactImage: exact.length - creditedExact.length,
      visualImage: visual.length,
      canonicalCredited: false,
      crossParticipant: false,
    };
    const disputed = (s.userEvidence as { __disputed?: boolean } | null)?.__disputed === true;
    let decision: TierDecision = decideTier({ ledger: rec.ledger, fiscalStatus: fiscal.status, authoritative, evaluation, discrepancies, duplicates, verification, missing, userCompleted, autoQualifyPaused: controls.pauseAutoQualify, disputed });

    // 7. Everything the transaction needs to know about itself is settled; the
    //    remaining work is the ledger claim, and it runs in one transaction.
    //    Reads that do not need to be transactional were done above, so the
    //    audit chain's global lock is held for writes only.
    const commitCtx = await this.commitContext(s, resolvedOutletId);
    const out = await this.db.transaction(async (tx) => {
      if (this.deps.fiscal) await this.deps.fiscal.record(tx, submissionId, s.campaignId, fiscal);
      for (const c of exact) await tx.insert(duplicateCandidates).values({ id: newId("dup"), submissionId, candidateSubmissionId: c.id, kind: "exact_bytes", score: 1 }).onConflictDoNothing();
      for (const c of visual) await tx.insert(duplicateCandidates).values({ id: newId("dup"), submissionId, candidateSubmissionId: c.id, kind: c.kind, score: c.score }).onConflictDoNothing();
      for (const c of fiscalDuplicates) await tx.insert(duplicateCandidates).values({ id: newId("dup"), submissionId, candidateSubmissionId: c.submissionId, kind: "fiscal_identity", score: 1, resolution: "same_purchase" }).onConflictDoNothing();

      let disposition = decision.disposition; let reason = decision.reason;
      let canonical = key ? (await tx.select().from(canonicalReceipts).where(and(eq(canonicalReceipts.campaignId, s.campaignId), eq(canonicalReceipts.receiptKey, key))).for("update"))[0] ?? null : null;
      let dupOf: string | null = null;
      if (canonical && canonical.firstSubmissionId !== submissionId) {
        const [first] = await tx.select().from(submissions).where(eq(submissions.id, canonical.firstSubmissionId));
        if (canonical.totalMinor != null && resolvedTotal != null && canonical.totalMinor !== resolvedTotal) { disposition = "review"; reason = "identity_conflict"; await tx.insert(duplicateCandidates).values({ id: newId("dup"), submissionId, candidateSubmissionId: canonical.creditedSubmissionId ?? canonical.firstSubmissionId, kind: "canonical", score: 0.5 }).onConflictDoNothing(); }
        else if (canonical.status === "credited") dupOf = canonical.creditedSubmissionId ?? canonical.firstSubmissionId;
        else if (first && first.participantId !== s.participantId && (["review", "received", "processing", "delayed", "awaiting_participant"].includes(first.status) || disposition === "qualified")) { disposition = "review"; reason = "ownership_dispute"; await tx.insert(duplicateCandidates).values({ id: newId("dup"), submissionId, candidateSubmissionId: first.id, kind: "canonical", score: 0.5 }).onConflictDoNothing(); }
        else if (first && first.participantId === s.participantId && !s.reuploadOf) await tx.update(submissions).set({ reuploadOf: first.id }).where(eq(submissions.id, submissionId));
      }
      if (!dupOf && exact.length) { const credited = exact.find((c) => c.status === "qualified"); if (credited) dupOf = credited.id; }
      if (dupOf) { disposition = "duplicate"; reason = "duplicate_receipt"; await tx.insert(duplicateCandidates).values({ id: newId("dup"), submissionId, candidateSubmissionId: dupOf, kind: "canonical", score: 1, resolution: "same_purchase" }).onConflictDoNothing(); }
      let canonicalId = canonical?.id ?? null;
      if (key && !canonical && disposition !== "duplicate") {
        canonicalId = newId("rcp");
        const ins = await tx.insert(canonicalReceipts).values({ id: canonicalId, campaignId: s.campaignId, receiptKey: key, outletId: resolvedOutletId, txnDate: resolvedDate, receiptNo: resolvedReceiptNo, totalMinor: resolvedTotal, firstSubmissionId: submissionId, status: disposition === "qualified" ? "credited" : "pending" }).onConflictDoNothing().returning({ id: canonicalReceipts.id });
        if (!ins.length) { // concurrent loser: the row now exists
          const [w] = await tx.select().from(canonicalReceipts).where(and(eq(canonicalReceipts.campaignId, s.campaignId), eq(canonicalReceipts.receiptKey, key))); canonicalId = w.id;
          if (w.status === "credited" || w.firstSubmissionId !== submissionId) { disposition = "duplicate"; reason = "duplicate_receipt"; await tx.insert(duplicateCandidates).values({ id: newId("dup"), submissionId, candidateSubmissionId: w.creditedSubmissionId ?? w.firstSubmissionId, kind: "canonical", score: 1, resolution: "same_purchase" }).onConflictDoNothing(); }
        }
      }
      // A qualifying decision with no receipt identity at all cannot be
      // credited: there would be nothing to stop the same purchase earning
      // twice. That is a review, not an award.
      if (disposition === "qualified" && !canonicalId) { disposition = "review"; reason = "receipt_identity_unresolved"; }
      if (disposition !== decision.disposition || reason !== decision.reason) decision = { ...decision, disposition, reason, tier: disposition === "duplicate" ? "tier_6" : decision.tier, rationale: [...decision.rationale, `ledger claim adjusted the outcome to ${disposition} (${reason})`] };

      const report = verificationReport(decision, { ledger: rec.ledger, fiscalStatus: fiscal.status, authoritative, evaluation, discrepancies, duplicates, verification, missing, userCompleted, autoQualifyPaused: controls.pauseAutoQualify, disputed });
      const committed = await this.commit(tx, { s, ctx: commitCtx, version: version.configHash, facts: { ...facts, verification }, evaluation, disposition, reason, canonicalId, attemptNo, decidedBy: "system", units: evaluation.units || rules.award.unitsPerReceipt, resolvedOutletId: resolvedOutletId, decision, report, ledgerSummary: rec.ledger.summary(), fiscalStatus: fiscal.status, pendingFields: decision.tier === "tier_4" ? missing : [] });
      await this.recordOutcome(tx, s, decision, report, fiscal.status);
      return committed;
    });
    await this.deps.alerts.metric("submission.decided", 1, { disposition: out.decision, campaignId: s.campaignId, tier: decision.tier, authority: decision.authority ?? "none" });
    await this.deps.alerts.metric("fiscal.verification", 1, { status: fiscal.status, campaignId: s.campaignId });
    return { ...out, tier: decision.tier, pendingFields: decision.tier === "tier_4" ? missing : [] };
  }

  /**
   * Capture the automated decision as calibration data.
   *
   * One row per submission, written with the decision itself, and later
   * completed with whatever a human concluded. This is an offline evaluation
   * set: nothing reads it back into a live decision and nothing retrains from
   * it. Its job is to make "the model said qualify and a reviewer disagreed"
   * countable, by tier and by evidence source, so a proposed change to
   * extraction, thresholds or rules has something to be measured against
   * before it ships.
   */
  private async recordOutcome(tx: DbOrTx, s: Submission, decision: TierDecision, report: Record<string, unknown>, fiscalStatus: string) {
    await tx.insert(verificationOutcomes).values({
      id: newId("vo"), submissionId: s.id, campaignId: s.campaignId,
      automatedTier: decision.tier, automatedDisposition: decision.disposition, automatedReason: decision.reason,
      authority: decision.authority ?? "none", fiscalStatus, duplicateRisk: decision.duplicateRisk, anomalyRisk: decision.anomalyRisk,
      discrepancies: (report.discrepancies as unknown[]) ?? [], evidence: report,
    }).onConflictDoUpdate({ target: verificationOutcomes.submissionId, set: { automatedTier: decision.tier, automatedDisposition: decision.disposition, automatedReason: decision.reason, authority: decision.authority ?? "none", fiscalStatus, duplicateRisk: decision.duplicateRisk, anomalyRisk: decision.anomalyRisk, discrepancies: (report.discrepancies as unknown[]) ?? [], evidence: report } });
  }
  /** Close the loop when a human decides: agreement, and in which direction. */
  private async recordHumanOutcome(tx: DbOrTx, submissionId: string, humanDecision: string, reviewerId: string, reason: string | null, note: string | null) {
    const [row] = await tx.select({ automated: verificationOutcomes.automatedDisposition }).from(verificationOutcomes).where(eq(verificationOutcomes.submissionId, submissionId));
    if (!row) return;
    const automated = row.automated;
    const agreement = automated === humanDecision ? "confirmed"
      : automated === "review" ? (humanDecision === "qualified" ? "referred_qualified" : "referred_rejected")
      : automated === "qualified" ? "overturned_rejection" : "overturned_qualification";
    await tx.update(verificationOutcomes).set({ humanDecision, humanReason: reason, humanNote: note, decidedBy: reviewerId, decidedAt: new Date().toISOString(), agreement }).where(eq(verificationOutcomes.submissionId, submissionId));
  }
  /** Agreement counts for calibration review. Never used to change a live decision. */
  async calibration(campaignId: string) {
    const rows = await this.db.select({ agreement: verificationOutcomes.agreement, tier: verificationOutcomes.automatedTier, authority: verificationOutcomes.authority, n: sql<number>`count(*)::int` })
      .from(verificationOutcomes).where(and(eq(verificationOutcomes.campaignId, campaignId), sql`${verificationOutcomes.agreement} is not null`))
      .groupBy(verificationOutcomes.agreement, verificationOutcomes.automatedTier, verificationOutcomes.authority);
    const [totals] = await this.db.select({ decided: sql<number>`count(*) filter (where ${verificationOutcomes.agreement} is not null)::int`, automated: sql<number>`count(*)::int` }).from(verificationOutcomes).where(eq(verificationOutcomes.campaignId, campaignId));
    return { totals: totals ?? { decided: 0, automated: 0 }, breakdown: rows };
  }

  /**
   * Everything the commit needs that does NOT have to be read inside the
   * transaction. Resolved first so the audit chain's global advisory lock —
   * which is held from the first audit write to COMMIT — covers writes only.
   * Those reads used to sit between the lock and the commit, on a separate
   * pooled connection, which both serialised the whole system on their latency
   * and risked exhausting the pool.
   */
  private async commitContext(s: Submission, outletId: string | null) {
    const [campaign, outlet, activeVersion, participant] = await Promise.all([
      this.deps.campaigns.get(s.campaignId),
      outletId ? this.deps.campaigns.outlet(outletId) : Promise.resolve(null),
      this.deps.campaigns.activeVersion(s.campaignId),
      this.deps.participants.get(s.participantId),
    ]);
    return { campaign, outlet, activeVersion, participant, messages: this.deps.campaigns.contentOf(activeVersion).messages, flags: this.deps.campaigns.flagsOf(activeVersion), rules: this.deps.campaigns.rulesOf(activeVersion) };
  }
  private async commitContextFor(s: Submission) { return this.commitContext(s, s.selectedOutletId); }

  /**
   * Near-identical images already submitted to this campaign.
   *
   * The comparison runs in the database. It used to pull the newest 4,000 rows
   * in the campaign and compute Hamming distances in JavaScript, which meant
   * that past four thousand submissions a receipt simply stopped being compared
   * against anything older — silently, oldest first. Blocking on the
   * participant or the outlet bounds the candidate set by something meaningful
   * instead of by an arbitrary row count, and both are indexed.
   *
   * Both hashes must agree: receipts from one till share an aHash (same layout)
   * without being the same photograph.
   */
  private async visualCandidates(asset: typeof mediaAssets.$inferSelect, s: Submission) {
    if (!asset.ahash || !asset.dhash) return [];
    const rows = await this.db.execute<{ id: string; distance: number }>(sql`
      select s.id as id,
             greatest(
               bit_count(('x' || m.ahash)::bit(64) # ('x' || ${asset.ahash})::bit(64)),
               bit_count(('x' || m.dhash)::bit(64) # ('x' || ${asset.dhash})::bit(64))
             ) as distance
        from ${submissions} s
        join ${mediaAssets} m on m.id = s.media_asset_id
       where s.campaign_id = ${s.campaignId}
         and s.id <> ${s.id}
         and m.ahash is not null and m.dhash is not null
         and (s.participant_id = ${s.participantId} or (s.selected_outlet_id is not null and s.selected_outlet_id = ${s.selectedOutletId}))
       order by distance asc
       limit 5`);
    const list = (Array.isArray(rows) ? rows : (rows as { rows?: Array<{ id: string; distance: number }> }).rows ?? []) as Array<{ id: string; distance: number }>;
    return list
      .filter((r) => Number(r.distance) <= PROBABLE_VISUAL_DISTANCE)
      .map((r) => ({ id: r.id, kind: "visual", score: Number((1 - Number(r.distance) / 64).toFixed(3)), distance: Number(r.distance) }));
  }

  private async delay(s: Submission, why: string) {
    const [{ n: tries }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(extractions).where(eq(extractions.submissionId, s.id));
    const ctx = await this.commitContextFor(s);
    await this.db.transaction(async (tx) => {
      await tx.update(submissions).set({ status: "delayed", reasonCode: why, version: sql`${submissions.version} + 1` }).where(eq(submissions.id, s.id));
      await this.deps.audit.record(tx, { actorType: "system", actorId: "pipeline", action: "submission.delayed", targetType: "submission", targetId: s.id, campaignId: s.campaignId, reason: why });
      if (ctx.participant && ctx.participant.status === "active") await this.deps.outbox.enqueue(tx, { channelUid: ctx.participant.channelUid, purpose: "submission_outcome", campaignId: s.campaignId, payload: render(ctx.messages, "delayed", { reference: s.reference }), idempotencyKey: `submission:${s.id}:delayed`, correlationId: s.correlationId });
      if (tries < 6) await this.deps.queue.enqueueJob(tx, "submission.process", { submissionId: s.id }, { runAfter: new Date(Date.now() + Math.min(2 ** tries, 20) * 60_000).toISOString(), correlationId: s.correlationId, dedupeKey: `process:${s.id}:${tries}` });
      else await this.deps.alerts.raise({ kind: "submission.stuck", severity: "critical", message: `submission ${s.reference} delayed after ${tries} attempts`, runbook: "docs/runbooks/media-and-extraction.md" });
    });
    return { submissionId: s.id, decision: "delayed", reason: why };
  }

  /**
   * Single integrity path for automatic and reviewer decisions.
   *
   * Runs inside the caller's transaction and does only writes plus one count.
   * Every read it used to perform — campaign, outlet, active version,
   * participant — is resolved by commitContext() before the transaction opens,
   * because the audit chain takes a global advisory lock that is held until
   * COMMIT. Cross-connection reads inside that window made the whole platform's
   * write throughput a function of their latency.
   */
  private async commit(tx: DbOrTx, a: { s: Submission; ctx: CommitContext; version: string; facts: Facts | null; evaluation: Evaluation | null; disposition: Disposition | "duplicate"; reason: string; canonicalId: string | null; attemptNo: number; decidedBy: string; note?: string | null; units: number; resolvedOutletId?: string | null; decision?: TierDecision | null; report?: Record<string, unknown> | null; ledgerSummary?: Record<string, unknown> | null; fiscalStatus?: string | null; pendingFields?: string[] }) {
    const { s, ctx, facts, evaluation, disposition, reason, canonicalId } = a; const isReview = a.decidedBy !== "system"; const now = new Date().toISOString();
    if (facts) {
      await tx.insert(extractions).values({ id: newId("ext"), submissionId: s.id, attemptNo: a.attemptNo, provider: facts.provider, model: facts.model, promptVersion: facts.promptVersion, schemaVersion: facts.schema, ocrText: facts.ocrText.slice(0, 20_000), facts: { document: facts.document, merchant: facts.merchant, transaction: facts.transaction, quality: facts.quality, evidence: facts.evidence, verification: facts.verification, ledger: a.ledgerSummary ?? null, report: a.report ?? null }, ruleResults: evaluation?.rules ?? [], disposition, confidence: facts.quality.confidence, latencyMs: facts.latencyMs, raw: facts.raw });
      await tx.delete(submissionItems).where(eq(submissionItems.submissionId, s.id));
      if (facts.lines.length) await tx.insert(submissionItems).values(facts.lines.map((l) => ({ id: newId("itm"), submissionId: s.id, lineNo: l.n, rawText: l.raw.slice(0, 200), description: l.description.slice(0, 160), quantity: l.quantity, packGrams: l.packGrams, amountMinor: l.amountMinor, voided: l.voided, productCode: l.product?.code ?? null, evidence: { unitMinor: l.unitMinor, basis: l.product?.basis ?? null } })));
    }
    const settled = !(a.pendingFields ?? []).length;
    await tx.update(submissions).set({
      status: settled ? disposition : "awaiting_participant", reasonCode: reason, decidedBy: settled ? a.decidedBy : null, decidedAt: settled ? now : null,
      canonicalReceiptId: canonicalId ?? s.canonicalReceiptId,
      // The outlet the evidence resolved to, written back so the canonical key,
      // the exports and a later reviewer all read the same answer. Under
      // capture-first nothing sets this column at intake any more.
      selectedOutletId: a.resolvedOutletId ?? s.selectedOutletId,
      verificationTier: a.decision?.tier ?? s.verificationTier, authority: a.decision?.authority ?? s.authority, fiscalStatus: a.fiscalStatus ?? s.fiscalStatus,
      pendingFields: a.pendingFields ?? [],
      version: sql`${submissions.version} + 1`,
    }).where(eq(submissions.id, s.id));
    let entryId: string | null = null;
    if (disposition === "qualified") {
      if (!canonicalId) throw err("INTEGRITY", "a qualified receipt must carry a canonical identity");
      const [existing] = await tx.select({ id: entries.id }).from(entries).where(and(eq(entries.canonicalReceiptId, canonicalId), eq(entries.status, "active")));
      if (existing) throw err("INTEGRITY", "canonical receipt already credited", { entryId: existing.id });
      entryId = newId("ent");
      await tx.insert(entries).values({ id: entryId, campaignId: s.campaignId, campaignVersionId: s.campaignVersionId, participantId: s.participantId, submissionId: s.id, canonicalReceiptId: canonicalId, periodCode: s.periodCode, units: Math.max(1, a.units), status: "active", awardedBy: a.decidedBy });
      await tx.update(canonicalReceipts).set({ status: "credited", creditedSubmissionId: s.id, creditedEntryId: entryId }).where(eq(canonicalReceipts.id, canonicalId));
      await this.deps.audit.record(tx, { actorType: isReview ? "staff" : "system", actorId: a.decidedBy, action: "entry.awarded", targetType: "entry", targetId: entryId, campaignId: s.campaignId, correlationId: s.correlationId, payload: { submissionId: s.id, canonicalId, periodCode: s.periodCode, rulesVersion: a.version, units: a.units } });
      await this.deps.crm?.emit(tx, { entityType: "entry", entityId: entryId, entityVersion: 1, payload: { participantId: s.participantId, campaignCode: ctx.campaign?.code, period: s.periodCode, outletCode: ctx.outlet?.code, reference: s.reference, status: "active", awardedAt: now }, correlationId: s.correlationId });
    } else if (disposition === "review") {
      await tx.insert(reviewTasks).values({ id: newId("rvw"), submissionId: s.id, state: "open", reasonCode: reason, slaDueAt: new Date(Date.now() + this.deps.reviewSlaHours * 3_600_000).toISOString() }).onConflictDoNothing();
    }
    await this.deps.audit.record(tx, { actorType: isReview ? "staff" : "system", actorId: a.decidedBy, action: `submission.${disposition}`, targetType: "submission", targetId: s.id, campaignId: s.campaignId, correlationId: s.correlationId, reason, payload: { entryId, canonicalId, note: a.note ?? null, failed: evaluation?.rules.filter((r) => r.outcome !== "pass").map((r) => `${r.rule}:${r.outcome}`) ?? null } });
    await this.deps.crm?.emit(tx, { entityType: "submission", entityId: s.id, entityVersion: a.attemptNo + (isReview ? 100 : 0), payload: { participantId: s.participantId, campaignCode: ctx.campaign?.code, reference: s.reference, outletCode: ctx.outlet?.code, status: disposition, reason, intakeAt: s.intakeAt }, correlationId: s.correlationId });
    const p = ctx.participant;
    if (p && p.status === "active") await this.deps.outbox.enqueue(tx, { channelUid: p.channelUid, purpose: "submission_outcome", campaignId: s.campaignId, payload: await this.outcomeMessage(tx, s, ctx, disposition, reason, isReview, a.pendingFields ?? []), idempotencyKey: `submission:${s.id}:outcome:${a.attemptNo}:${isReview ? "review" : "auto"}`, correlationId: s.correlationId });
    return { submissionId: s.id, decision: disposition, reason, entryId };
  }
  private async outcomeMessage(tx: DbOrTx, s: Submission, ctx: CommitContext, disposition: string, reason: string, isReview: boolean, pendingFields: string[] = []) {
    const M = ctx.messages; const flags = ctx.flags; const rules = ctx.rules; const camp = ctx.campaign;
    if (pendingFields.length) return render(M, "confirm_missing", { reference: s.reference, field: FIELD_LABELS[pendingFields[0]] ?? pendingFields[0] });
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(entries).where(and(eq(entries.participantId, s.participantId), eq(entries.campaignId, s.campaignId), eq(entries.status, "active")));
    const countLine = flags.participantStatus && disposition === "qualified" ? render(M, "qualified_count", { count: n, entries_word: n === 1 ? "entry" : "entries" }) : "";
    const vars = { reference: s.reference, campaign: camp?.name ?? "the promotion", reason: reasonText(M, reason, { min_packs: rules.qualification.minPacks, pack_label: `${rules.qualification.packGrams / 1000}kg pack` }), count_line: countLine };
    const key = ({ qualified: isReview ? "review_qualified" : "qualified", not_qualified: isReview ? "review_not_qualified" : "not_qualified", duplicate: isReview ? "review_duplicate" : "duplicate", review: "under_review", reupload: isReview ? "review_reupload" : "reupload" } as Record<string, string>)[disposition] ?? "under_review";
    return render(M, key, vars);
  }

  /** Reviewer decision: same commit path; optimistic version check; a reviewer cannot bypass the unique award. */
  async review(submissionId: string, { reviewerId, decision, reasonCode, note, expectedVersion }: { reviewerId: string; decision: "qualified" | "not_qualified" | "duplicate" | "reupload"; reasonCode?: string | null; note?: string | null; expectedVersion?: number | null }) {
    if (!["qualified", "not_qualified", "duplicate", "reupload"].includes(decision)) throw invalid("invalid decision");
    const pre = await this.get(submissionId); if (!pre) throw notFound("submission");
    const ctx = await this.commitContextFor(pre);
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
      // The outlet comes from the same resolved evidence the automated pass
      // used. Reading the column alone meant a capture-first submission — where
      // nothing sets it at intake — always looked as though it had no receipt
      // identity, forcing every reviewer qualification down the manual-key path
      // and losing duplicate protection with it.
      const ledgerOutlet = ((last?.facts as { ledger?: { fields?: Record<string, { value?: unknown }> } } | null)?.ledger?.fields?.outletId?.value ?? null) as string | null;
      const outletId = s.selectedOutletId ?? ledgerOutlet;
      let canonicalId = s.canonicalReceiptId; let disposition: Disposition | "duplicate" = decision; let reason = reasonCode ?? "ok";
      if (decision === "qualified") {
        const date = facts.transaction?.date ?? null, receiptNo = facts.transaction?.receiptNo ?? null, totalMinor = facts.transaction?.totalMinor ?? null;
        const key = receiptKey(outletId, date, receiptNo);
        if (!key) {
          if (!note?.trim()) throw invalid("a reviewer note is required when qualifying with incomplete receipt identity");
          // A human may qualify from the image even when OCR cannot produce a
          // stable purchase key. Keep the award auditable, but do not invent
          // an identity that could incorrectly merge this receipt with another.
          canonicalId = newId("rcp"); reason = reasonCode ?? "manual_review_qualified";
          await tx.insert(canonicalReceipts).values({ id: canonicalId, campaignId: s.campaignId, receiptKey: `manual-review:${submissionId}`, outletId, txnDate: date, receiptNo, totalMinor, firstSubmissionId: submissionId, status: "pending" });
        } else {
          const [can] = await tx.select().from(canonicalReceipts).where(and(eq(canonicalReceipts.campaignId, s.campaignId), eq(canonicalReceipts.receiptKey, key))).for("update");
          if (can && can.status === "credited" && can.creditedSubmissionId !== submissionId) { disposition = "duplicate"; reason = "duplicate_receipt"; canonicalId = can.id; }
          else if (!can) { canonicalId = newId("rcp"); await tx.insert(canonicalReceipts).values({ id: canonicalId, campaignId: s.campaignId, receiptKey: key, outletId, txnDate: date, receiptNo, totalMinor, firstSubmissionId: submissionId, status: "pending" }); }
          else canonicalId = can.id;
        }
      }
      await tx.update(reviewTasks).set({ state: "decided", decision: disposition, decisionReason: reason, note: note ?? null, decidedBy: reviewerId, decidedAt: new Date().toISOString(), version: sql`${reviewTasks.version} + 1` }).where(eq(reviewTasks.submissionId, submissionId));
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(extractions).where(eq(extractions.submissionId, submissionId));
      await this.recordHumanOutcome(tx, submissionId, disposition, reviewerId, reason, note ?? null);
      return this.commit(tx, { s, ctx, version: version.configHash, facts: null, evaluation: null, disposition, reason, canonicalId, attemptNo: n, decidedBy: reviewerId, note, units: rules.award.unitsPerReceipt, resolvedOutletId: outletId, fiscalStatus: s.fiscalStatus, pendingFields: [] });
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
      await this.deps.crm?.emit(tx, { entityType: "entry", entityId: entryId, entityVersion: 2, payload: { participantId: e.participantId, campaignCode: camp?.code, period: e.periodCode, status: "excluded" } });
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
  /**
   * Aggregate review-queue health. Three counting queries, no row transfer.
   *
   * The alerting path calls this on every housekeeping cycle. It used to select
   * every open task with two joins and map them all, which meant the mechanism
   * that reports a backlog was the first thing to fall over in one — and a
   * verification-provider outage sends every submission to review at once.
   */
  /**
   * Hand a stalled question to a reviewer.
   *
   * A submission waiting on the participant is only sensible while there is a
   * realistic chance they will answer. Past the review SLA — or where the
   * conversation could not be asked at all, because the participant is with
   * support or mid-registration — it becomes a review task, so nothing sits in
   * a state nobody is looking at.
   */
  async escalateStalledQuestions({ olderThanMs = this.deps.reviewSlaHours * 3_600_000, limit = 200 } = {}) {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const stale = await this.db.select({ id: submissions.id, campaignId: submissions.campaignId, pendingFields: submissions.pendingFields })
      .from(submissions).where(and(eq(submissions.status, "awaiting_participant"), lt(submissions.intakeAt, cutoff)))
      .orderBy(asc(submissions.intakeAt)).limit(limit);
    let n = 0;
    for (const row of stale) {
      await this.db.transaction(async (tx) => {
        const claimed = await tx.update(submissions).set({ status: "review", reasonCode: "participant_did_not_reply", pendingFields: [], version: sql`${submissions.version} + 1` }).where(and(eq(submissions.id, row.id), eq(submissions.status, "awaiting_participant"))).returning({ id: submissions.id });
        if (!claimed.length) return;
        await tx.insert(reviewTasks).values({ id: newId("rvw"), submissionId: row.id, state: "open", reasonCode: "participant_did_not_reply", slaDueAt: new Date(Date.now() + this.deps.reviewSlaHours * 3_600_000).toISOString() }).onConflictDoNothing();
        await this.deps.audit.record(tx, { actorType: "system", actorId: "pipeline", action: "submission.question_escalated", targetType: "submission", targetId: row.id, campaignId: row.campaignId, reason: "participant_did_not_reply", payload: { pendingFields: row.pendingFields } });
        n++;
      });
    }
    return n;
  }
  /** The participant could not be asked at all: send it straight to a reviewer. */
  async escalateUnaskable(submissionId: string) { return this.escalateStalledQuestions({ olderThanMs: -1, limit: 1 }).then(() => this.get(submissionId)); }

  async reviewQueueStats() {
    const now = new Date().toISOString();
    const [[totals], byReasonRows] = await Promise.all([
      this.db.select({ count: sql<number>`count(*)::int`, oldest: sql<string | null>`min(${reviewTasks.createdAt})`, overdue: sql<number>`count(*) filter (where ${reviewTasks.slaDueAt} < ${now})::int` }).from(reviewTasks).where(ne(reviewTasks.state, "decided")),
      this.db.select({ reason: reviewTasks.reasonCode, n: sql<number>`count(*)::int` }).from(reviewTasks).where(ne(reviewTasks.state, "decided")).groupBy(reviewTasks.reasonCode),
    ]);
    return { count: totals?.count ?? 0, oldest: totals?.oldest ?? null, overdue: totals?.overdue ?? 0, byReason: Object.fromEntries(byReasonRows.map((r) => [r.reason ?? "unknown", r.n])) };
  }
  /** Paginated listing for the console. Always bounded. */
  async reviewQueue({ limit = 100, offset = 0 }: { limit?: number; offset?: number } = {}) {
    const take = Math.max(1, Math.min(500, limit));
    const stats = await this.reviewQueueStats();
    const open = await this.db.select({ t: reviewTasks, s: submissions, participantPhone: participants.channelUid }).from(reviewTasks).innerJoin(submissions, eq(submissions.id, reviewTasks.submissionId)).innerJoin(participants, eq(participants.id, submissions.participantId)).where(ne(reviewTasks.state, "decided")).orderBy(asc(reviewTasks.createdAt)).limit(take).offset(Math.max(0, offset));
    return { ...stats, limit: take, offset: Math.max(0, offset), items: open.map((r) => ({ submissionId: r.s.id, reference: r.s.reference, participantPhone: maskPhone(r.participantPhone), reason: r.t.reasonCode, state: r.t.state, assignee: r.t.assignee, slaDueAt: r.t.slaDueAt, ageMinutes: Math.round((Date.now() - Date.parse(r.t.createdAt)) / 60000), period: r.s.periodCode, campaignId: r.s.campaignId, tier: r.s.verificationTier, authority: r.s.authority, fiscalStatus: r.s.fiscalStatus })) };
  }
}
