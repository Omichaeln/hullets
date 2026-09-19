import type { Discrepancy, EvidenceLedger, EvidenceSource } from "./evidence.ts";
import type { FiscalStatus } from "./types.ts";
import type { Disposition, Evaluation } from "../eligibility/rules.ts";
import type { VerificationAssessment } from "../extraction/types.ts";

/**
 * The decision hierarchy.
 *
 * This is deliberately a pure function over structured inputs rather than a
 * probability a model reports about itself. A model saying "98% confident" is
 * not evidence; it is a number with no denominator. What decides an entry here
 * is what each source asserted, whether the sources agree, whether the
 * deterministic campaign rules passed, and what the duplicate and anomaly
 * checks found. The model's assessment is one input among those, and it can
 * only ever withhold qualification — never grant it.
 *
 * Tier 1  authority verified, image agrees, rules satisfied  -> qualify
 * Tier 2  authority verified, image or data disagrees         -> review
 * Tier 3  no authority, strong OCR/AI, rules satisfied        -> qualify if risk allows
 * Tier 4  something missing, participant reconciles it        -> continue
 * Tier 5  conflicts, anomalies or low confidence              -> review
 * Tier 6  invalid, duplicate or fraudulent                    -> reject or investigate
 */
export type Tier = "tier_1" | "tier_2" | "tier_3" | "tier_4" | "tier_5" | "tier_6";
export type Risk = "none" | "low" | "medium" | "high";

/**
 * Duplicate evidence, split by whether the other submission actually HOLDS the
 * award.
 *
 * The distinction matters. A byte-identical or fiscally identical submission
 * that was credited means this purchase has already earned its entry — that is
 * a duplicate. One that exists but was never credited means something else:
 * a re-upload after we asked for a clearer photo, two people photographing the
 * same till slip at once, a retry. Treating those as duplicates rejects the
 * honest re-upload we ourselves requested. They raise the risk and go to the
 * canonical claim, which resolves the ordering under a row lock, and to a
 * reviewer when it cannot.
 */
export type DuplicateSignal = {
  /** Same fiscal transaction, already credited elsewhere. */
  fiscalIdentityCredited: boolean;
  /** Same fiscal transaction on a submission that has not been credited. */
  fiscalIdentityOpen: number;
  /** Byte-identical image, already credited elsewhere. */
  exactImageCredited: boolean;
  /** Byte-identical images that were not credited. */
  exactImage: number;
  /** Perceptually near-identical image already submitted. */
  visualImage: number;
  /** Same canonical receipt already credited. */
  canonicalCredited: boolean;
  /** Same transaction, different participant. */
  crossParticipant: boolean;
};

export type TierInput = {
  ledger: EvidenceLedger;
  fiscalStatus: FiscalStatus;
  authoritative: boolean;
  evaluation: Evaluation | null;
  discrepancies: Discrepancy[];
  duplicates: DuplicateSignal;
  verification: VerificationAssessment | null;
  /** Fields still needed that nobody has asserted. */
  missing: string[];
  /** The participant has answered everything we asked. */
  userCompleted: boolean;
  /** Campaign control: auto-qualification is paused. */
  autoQualifyPaused: boolean;
  /** The participant told us what we established is wrong. Never auto-resolved. */
  disputed?: boolean;
};

export type TierDecision = {
  tier: Tier;
  disposition: Disposition | "duplicate";
  reason: string;
  authority: EvidenceSource | null;
  duplicateRisk: Risk;
  anomalyRisk: Risk;
  /** Ordered, human-readable statements of what drove this. No single opaque score. */
  rationale: string[];
};

export function duplicateRisk(d: DuplicateSignal): Risk {
  if (d.fiscalIdentityCredited || d.canonicalCredited || d.exactImageCredited) return "high";
  if (d.crossParticipant || d.fiscalIdentityOpen > 0) return "high";
  if (d.exactImage > 0 || d.visualImage > 0) return "medium";
  return "none";
}

export function anomalyRisk(input: Pick<TierInput, "discrepancies" | "verification" | "evaluation">): Risk {
  const material = input.discrepancies.filter((x) => x.severity === "material").length;
  if (material > 1) return "high";
  if (material === 1) return "medium";
  const v = input.verification;
  if (v && v.status === "complete" && v.risk === "high") return "high";
  if (v && v.status === "complete" && v.risk === "medium") return "medium";
  if (input.discrepancies.length) return "low";
  return "none";
}

export function decideTier(input: TierInput): TierDecision {
  const rationale: string[] = [];
  const authority = input.ledger.topAuthority();
  const dupRisk = duplicateRisk(input.duplicates);
  const anomRisk = anomalyRisk(input);
  const material = input.discrepancies.filter((x) => x.severity === "material");
  const rulesOk = input.evaluation?.disposition === "qualified";

  rationale.push(`strongest evidence: ${authority ?? "none"}`);
  rationale.push(`fiscal validation: ${input.fiscalStatus}`);
  if (input.evaluation) rationale.push(`campaign rules: ${input.evaluation.disposition}${input.evaluation.disposition === "qualified" ? "" : ` (${input.evaluation.reason})`}`);
  rationale.push(`duplicate risk: ${dupRisk}`);
  rationale.push(`anomaly risk: ${anomRisk}`);

  // Tier 6 — the submission is disqualified by evidence, not by judgement.
  if (input.duplicates.fiscalIdentityCredited || input.duplicates.canonicalCredited || input.duplicates.exactImageCredited) {
    rationale.push("this transaction has already earned an entry");
    return { tier: "tier_6", disposition: "duplicate", reason: "duplicate_receipt", authority, duplicateRisk: dupRisk, anomalyRisk: anomRisk, rationale };
  }
  if (input.fiscalStatus === "invalid") {
    rationale.push("the revenue authority did not confirm this invoice");
    return { tier: "tier_6", disposition: "review", reason: "fiscal_invalid", authority, duplicateRisk: dupRisk, anomalyRisk: anomRisk, rationale };
  }

  // A deterministic rule failure is a rejection whatever the evidence quality:
  // a genuine receipt for the wrong product is still not an entry.
  if (input.evaluation && ["not_qualified", "reupload"].includes(input.evaluation.disposition)) {
    rationale.push("a campaign rule failed outright");
    return { tier: "tier_6", disposition: input.evaluation.disposition, reason: input.evaluation.reason, authority, duplicateRisk: dupRisk, anomalyRisk: anomRisk, rationale };
  }

  // Tier 4 — we could not establish something and have not yet asked.
  if (input.missing.length && !input.userCompleted) {
    rationale.push(`waiting on the participant for: ${input.missing.join(", ")}`);
    return { tier: "tier_4", disposition: "review", reason: "awaiting_participant", authority, duplicateRisk: dupRisk, anomalyRisk: anomRisk, rationale };
  }

  // Tier 2 — the authority is good but the paper does not match it.
  if (input.authoritative && material.length) {
    rationale.push(`the receipt image disagrees with the authority on: ${material.map((x) => x.field).join(", ")}`);
    return { tier: "tier_2", disposition: "review", reason: "fiscal_receipt_mismatch", authority, duplicateRisk: dupRisk, anomalyRisk: anomRisk, rationale };
  }

  // The participant contradicting what we established is a finding, not an
  // input to be reconciled away. It always reaches a human.
  if (input.disputed) {
    rationale.push("the participant disputes the details we established");
    return { tier: "tier_5", disposition: "review", reason: "participant_disputed", authority, duplicateRisk: dupRisk, anomalyRisk: anomRisk, rationale };
  }

  // Tier 5 — anything unresolved, from any source.
  const modelHold = input.verification?.decision === "hold" && input.verification.status === "complete";
  if (!rulesOk || anomRisk === "high" || dupRisk === "high" || modelHold) {
    if (modelHold) rationale.push("the verification model raised a hold");
    rationale.push("routed to a reviewer: the automated evidence does not settle it");
    return { tier: "tier_5", disposition: "review", reason: modelHold ? "ai_verification_hold" : (input.evaluation?.reason ?? "unresolved_evidence"), authority, duplicateRisk: dupRisk, anomalyRisk: anomRisk, rationale };
  }

  if (input.autoQualifyPaused) {
    rationale.push("automatic qualification is paused for this campaign");
    return { tier: "tier_5", disposition: "review", reason: "auto_qualification_paused", authority, duplicateRisk: dupRisk, anomalyRisk: anomRisk, rationale };
  }

  // Tier 1 — the authority confirmed it and the paper agrees.
  if (input.authoritative) {
    rationale.push("the revenue authority confirmed this invoice and the receipt image matches it");
    return { tier: "tier_1", disposition: "qualified", reason: "ok", authority, duplicateRisk: dupRisk, anomalyRisk: anomRisk, rationale };
  }

  // Tier 3 — no authority, but the image evidence is strong and uncontested.
  if (anomRisk === "none" || anomRisk === "low") {
    rationale.push("no fiscal record available; OCR and AI evidence is consistent and every rule passed");
    return { tier: "tier_3", disposition: "qualified", reason: "ok", authority, duplicateRisk: dupRisk, anomalyRisk: anomRisk, rationale };
  }

  rationale.push("routed to a reviewer: evidence without an authoritative record and with open questions");
  return { tier: "tier_5", disposition: "review", reason: "unresolved_evidence", authority, duplicateRisk: dupRisk, anomalyRisk: anomRisk, rationale };
}

/**
 * The structured verification assessment, in the shape the brief asks for:
 * every component stated separately, and the headline derived from them rather
 * than asserted on its own.
 */
export function verificationReport(d: TierDecision, input: TierInput) {
  const summary = input.ledger.summary();
  return {
    status: d.disposition === "qualified" ? "QUALIFIED" : d.disposition === "review" ? "REVIEW" : d.disposition.toUpperCase(),
    tier: d.tier,
    source: d.authority ?? "none",
    fiscalStatus: input.fiscalStatus,
    receiptMatch: input.authoritative ? (summary.materialDiscrepancies ? "DISPUTED" : "CONFIRMED") : "NOT_APPLICABLE",
    promotionRequirements: input.evaluation ? (input.evaluation.disposition === "qualified" ? "SATISFIED" : "NOT_SATISFIED") : "NOT_EVALUATED",
    duplicateCheck: d.duplicateRisk === "none" ? "PASS" : d.duplicateRisk.toUpperCase(),
    anomalyRisk: d.anomalyRisk.toUpperCase(),
    completeness: { resolved: Object.keys(summary.fields).length, byStatus: summary.byStatus, missing: input.missing },
    discrepancies: summary.discrepancies,
    modelAssessment: input.verification ? { status: input.verification.status, risk: input.verification.risk, decision: input.verification.decision, anomalies: input.verification.anomalies } : null,
    rationale: d.rationale,
  };
}
