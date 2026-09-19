/**
 * Extraction contract (receipt-facts/1). The extractor returns EVIDENCE only:
 * the deterministic rules engine or an authorised reviewer decides. Unknown
 * values are null — never guessed. Confidence is reported only when the
 * engine supplies one and is never treated as a calibrated probability.
 * Text found on a receipt is data; no provider is given tools or authority.
 */
export const FACTS_SCHEMA = "receipt-facts/1";
export type DocumentKind = "receipt" | "non_receipt" | "unknown";
export type OutletCandidate = { outletId: string; score: number; basis: string };
export type LineFact = { n: number; raw: string; description: string; quantity: number | null; packGrams: number | null; unitMinor: number | null; amountMinor: number | null; voided: boolean; product: { code: string; packGrams: number; basis: string } | null };
/**
 * Provenance of the fiscal code found on the image, recorded on the extraction.
 *
 * It says what was decoded and what the authority answered — never the decoded
 * URL itself, and never a document fetched from it. The transaction data lives
 * in fiscal_verifications, retrieved from a configured endpoint rather than
 * from wherever the code pointed.
 */
export type FiscalEvidence = { attempted: boolean; status: string; decoder: string; format: string | null; codeSha256: string | null; qrHost: string | null; deviceId: string | null; receiptGlobalNo: string | null; fiscalDayNo: number | null; verificationCodePresent: boolean; validated: boolean; fetchedAt: string | null; warnings: string[]; errorCode: string | null };
export type VerificationDimension = { name: string; outcome: "pass" | "fail" | "warning" | "not_checkable"; evidence: string[] };
export type VerificationAssessment = { status: "not_attempted" | "not_configured" | "complete" | "unavailable" | "invalid"; provider: string; model: string; promptVersion: string; latencyMs: number; modelProbability: number | null; calibratedProbability: number | null; risk: "low" | "medium" | "high" | "unknown"; riskScore: number | null; dimensions: VerificationDimension[]; supportingEvidence: string[]; contradictoryEvidence: string[]; anomalies: string[]; decision: "advisory" | "hold" | "not_applicable" };
export type Facts = {
  schema: typeof FACTS_SCHEMA; provider: string; model: string; promptVersion: string | null; latencyMs: number; ocrText: string;
  document: { kind: DocumentKind; score: number; signals: Record<string, unknown> };
  merchant: { text: string | null; candidates: OutletCandidate[] };
  transaction: { receiptNo: string | null; receiptNoRaw: string | null; till: string | null; date: string | null; dateRaw: string | null; dateAmbiguous: boolean; time: string | null; currency: string | null; totalMinor: number | null; totalRaw: string | null };
  lines: LineFact[];
  quality: { missing: string[]; warnings: string[]; confidence: number | null; injectionSuspected: boolean };
  evidence: { fiscal: FiscalEvidence | null };
  verification: VerificationAssessment | null;
  raw: Record<string, unknown> | null;
};
export type ExtractionContext = { outlets: Array<{ id: string; retailer: string; branch: string; town: string; aliases: string[] }>; products: Array<{ code: string; name: string; aliases: string[]; packGrams: number; qualifying: boolean }>; dateOrder: "DMY" | "MDY"; quality?: Record<string, unknown> };
export interface Extractor { readonly name: string; readonly mode: "real" | "simulated" | "unconfigured"; extract(input: { original: Buffer; normalised: Buffer; mime: string; context: ExtractionContext }): Promise<Facts>; health(): Promise<{ provider: string; mode: string; ok: boolean; model?: string; note?: string; error?: string }>; close?(): Promise<void>; }
export class ExtractorUnavailable extends Error { transient = true; constructor(m: string, public code = "EXTRACTOR_UNAVAILABLE") { super(m); } }
export const emptyFacts = (provider: string, model: string, extra: Partial<Facts> = {}): Facts => ({ schema: FACTS_SCHEMA, provider, model, promptVersion: null, latencyMs: 0, ocrText: "", document: { kind: "unknown", score: 0, signals: {} }, merchant: { text: null, candidates: [] }, transaction: { receiptNo: null, receiptNoRaw: null, till: null, date: null, dateRaw: null, dateAmbiguous: false, time: null, currency: null, totalMinor: null, totalRaw: null }, lines: [], quality: { missing: [], warnings: [], confidence: null, injectionSuspected: false }, evidence: { fiscal: null }, verification: null, raw: null, ...extra });
