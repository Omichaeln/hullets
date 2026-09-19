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
export type QrEvidence = { attempted: boolean; status: "not_attempted" | "no_code" | "invalid_url" | "blocked_url" | "fetch_failed" | "unsupported_content" | "parsed"; decoder: string; format: string | null; codeSha256: string | null; urlHost: string | null; urlPath: string | null; queryKeys: string[]; finalHost: string | null; finalPath: string | null; contentType: string | null; documentSha256: string | null; fetchedAt: string | null; fields: string[]; warnings: string[]; errorCode: string | null };
export type VerificationDimension = { name: string; outcome: "pass" | "fail" | "warning" | "not_checkable"; evidence: string[] };
export type VerificationAssessment = { status: "not_attempted" | "not_configured" | "complete" | "unavailable" | "invalid"; provider: string; model: string; promptVersion: string; latencyMs: number; modelProbability: number | null; calibratedProbability: number | null; risk: "low" | "medium" | "high" | "unknown"; riskScore: number | null; dimensions: VerificationDimension[]; supportingEvidence: string[]; contradictoryEvidence: string[]; anomalies: string[]; decision: "advisory" | "hold" | "not_applicable" };
export type Facts = {
  schema: typeof FACTS_SCHEMA; provider: string; model: string; promptVersion: string | null; latencyMs: number; ocrText: string;
  document: { kind: DocumentKind; score: number; signals: Record<string, unknown> };
  merchant: { text: string | null; candidates: OutletCandidate[] };
  transaction: { receiptNo: string | null; receiptNoRaw: string | null; till: string | null; date: string | null; dateRaw: string | null; dateAmbiguous: boolean; time: string | null; currency: string | null; totalMinor: number | null; totalRaw: string | null };
  lines: LineFact[];
  quality: { missing: string[]; warnings: string[]; confidence: number | null; injectionSuspected: boolean };
  evidence: { qr: QrEvidence | null };
  verification: VerificationAssessment | null;
  raw: Record<string, unknown> | null;
};
export type ExtractionContext = { outlets: Array<{ id: string; retailer: string; branch: string; town: string; aliases: string[] }>; products: Array<{ code: string; name: string; aliases: string[]; packGrams: number; qualifying: boolean }>; dateOrder: "DMY" | "MDY"; quality?: Record<string, unknown> };
export interface Extractor { readonly name: string; readonly mode: "real" | "simulated" | "unconfigured"; extract(input: { original: Buffer; normalised: Buffer; mime: string; context: ExtractionContext }): Promise<Facts>; health(): Promise<{ provider: string; mode: string; ok: boolean; model?: string; note?: string; error?: string }>; close?(): Promise<void>; }
export class ExtractorUnavailable extends Error { transient = true; constructor(m: string, public code = "EXTRACTOR_UNAVAILABLE") { super(m); } }
export const emptyFacts = (provider: string, model: string, extra: Partial<Facts> = {}): Facts => ({ schema: FACTS_SCHEMA, provider, model, promptVersion: null, latencyMs: 0, ocrText: "", document: { kind: "unknown", score: 0, signals: {} }, merchant: { text: null, candidates: [] }, transaction: { receiptNo: null, receiptNoRaw: null, till: null, date: null, dateRaw: null, dateAmbiguous: false, time: null, currency: null, totalMinor: null, totalRaw: null }, lines: [], quality: { missing: [], warnings: [], confidence: null, injectionSuspected: false }, evidence: { qr: null }, verification: null, raw: null, ...extra });
