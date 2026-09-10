/**
 * Deterministic, versioned eligibility (rules v1). Pure: same (facts, rules,
 * context) -> same result. Integer grams and minor units only. Each rule
 * reports pass | fail | unknown with a participant-safe reason code and
 * internal evidence. Precedence: document/quality failures -> REUPLOAD;
 * any other fail -> NOT_QUALIFIED; any unknown -> REVIEW; else QUALIFIED.
 * Duplicates are decided by the pipeline's canonical-receipt claim, not here.
 */
import type { Facts } from "../extraction/types.ts";
import type { Rules } from "../campaign/types.ts";

export type Outcome = "pass" | "fail" | "unknown";
export type RuleResult = { rule: string; outcome: Outcome; reason: string | null; evidence: unknown };
export type Disposition = "qualified" | "not_qualified" | "review" | "reupload";
export type Context = { intakeAt: string; campaignOpen: boolean; windowStart: string; windowEnd: string; selectedOutletId: string | null; selectedOutletParticipating: boolean; enrolled: boolean; participantActive: boolean; periodEntryCount: number; campaignEntryCount: number; imageQuality: { blurry?: boolean; tooDark?: boolean; lowContrast?: boolean } };
export type Evaluation = { disposition: Disposition; reason: string; rules: RuleResult[]; primaryPacks: number; totalGrams: number; matched: Array<{ code: string; quantity: number | null; packGrams: number | null; grams: number | null; line: string }>; units: number };

const inWindow = (date: string, start: string, end: string) => { const t = Date.parse(`${date}T12:00:00Z`); const s = Date.parse(start), e = Date.parse(end); const dayStart = Date.UTC(new Date(s).getUTCFullYear(), new Date(s).getUTCMonth(), new Date(s).getUTCDate()); return t >= dayStart && t < e; };
const swap = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return d > 12 ? null : `${y}-${String(d).padStart(2, "0")}-${String(m).padStart(2, "0")}`; };

export function evaluate(facts: Facts, rules: Rules, ctx: Context): Evaluation {
  const R: RuleResult[] = []; const add = (rule: string, outcome: Outcome, reason: string | null, evidence: unknown = null) => R.push({ rule, outcome, reason: outcome === "pass" ? null : reason, evidence });
  const doc = facts.document, tx = facts.transaction, iq = ctx.imageQuality ?? {};
  // 1. document + image quality
  if (doc.kind === "non_receipt") add("document_is_receipt", "fail", "not_a_receipt", { score: doc.score });
  else if (doc.kind === "unknown" || doc.score < rules.review.minDocumentScore) add("document_is_receipt", "unknown", "not_a_receipt", { score: doc.score });
  else add("document_is_receipt", "pass", null, { score: doc.score });
  if ((iq.blurry || iq.tooDark || iq.lowContrast) && doc.kind !== "receipt") add("image_quality", "fail", "image_unreadable", iq); else add("image_quality", "pass", null, iq);
  // 2. campaign + participant
  add("campaign_open", ctx.campaignOpen ? "pass" : "fail", "campaign_not_open", { intakeAt: ctx.intakeAt });
  add("participant_enrolled", ctx.enrolled ? "pass" : "fail", "not_enrolled");
  add("participant_active", ctx.participantActive ? "pass" : "fail", "participant_not_eligible");
  // 3. receipt identity
  add("receipt_number", tx.receiptNo ? "pass" : "unknown", "receipt_number_unreadable", { receiptNo: tx.receiptNo });
  add("total", tx.totalMinor != null ? "pass" : "unknown", "total_unreadable", { totalMinor: tx.totalMinor });
  // 4. purchase date in [windowStart, windowEnd)
  if (!tx.date) add("purchase_date", "unknown", "date_unreadable", { raw: tx.dateRaw });
  else if (tx.dateAmbiguous) { const alt = swap(tx.date); const a = inWindow(tx.date, ctx.windowStart, ctx.windowEnd), b = alt ? inWindow(alt, ctx.windowStart, ctx.windowEnd) : a; if (a) add("purchase_date", "pass", null, { date: tx.date, alt, ambiguous: true, dateOrder: rules.dateOrder }); else if (!b) add("purchase_date", "fail", "date_outside_window", { date: tx.date, alt }); else add("purchase_date", "unknown", "date_ambiguous", { date: tx.date, alt }); }
  else add("purchase_date", inWindow(tx.date, ctx.windowStart, ctx.windowEnd) ? "pass" : "fail", "date_outside_window", { date: tx.date, window: [ctx.windowStart, ctx.windowEnd] });
  // 5. outlet
  add("outlet_participating", ctx.selectedOutletParticipating ? "pass" : "fail", "outlet_not_participating", { selected: ctx.selectedOutletId });
  const cands = facts.merchant.candidates; const hit = cands.find((c) => c.outletId === ctx.selectedOutletId && c.score >= rules.outletMatch.minScore);
  if (!rules.outletMatch.required) add("outlet_match", "pass", null, { skipped: true }); else if (hit) add("outlet_match", "pass", null, hit); else if (!cands.length && !(facts.merchant.text ?? "").trim()) add("outlet_match", "unknown", "outlet_unreadable", { header: facts.merchant.text }); else if (!cands.length) add("outlet_match", "unknown", "outlet_mismatch", { header: facts.merchant.text, candidates: [] }); else add("outlet_match", "unknown", "outlet_mismatch", { header: facts.merchant.text, top: cands[0] });
  // 6. product + quantity (voided lines excluded; a printed "2KG" is a pack size, never a quantity)
  const q = rules.qualification; const matched: Evaluation["matched"] = []; let qtyUnknown = false;
  for (const li of facts.lines) { if (li.voided || !li.product) continue; const pack = li.packGrams ?? li.product.packGrams ?? null; if (li.quantity == null || !pack) { qtyUnknown = true; matched.push({ code: li.product.code, quantity: li.quantity, packGrams: pack, grams: null, line: li.raw }); continue; } matched.push({ code: li.product.code, quantity: li.quantity, packGrams: pack, grams: li.quantity * pack, line: li.raw }); }
  const primaryPacks = matched.filter((m) => m.grams != null && m.packGrams === q.packGrams).reduce((a, m) => a + (m.quantity ?? 0), 0);
  const totalGrams = matched.reduce((a, m) => a + (m.grams ?? 0), 0);
  let meets = q.mode === "weight" ? totalGrams >= q.minTotalGrams : primaryPacks >= q.minPacks && primaryPacks * q.packGrams >= q.minTotalGrams;
  if (!meets && q.mode === "packs" && q.allowMixedPacks) meets = totalGrams >= q.minTotalGrams;
  if (!matched.length) add("qualifying_product", "fail", "no_qualifying_product", { lines: facts.lines.length }); else if (meets) add("qualifying_product", "pass", null, { primaryPacks, totalGrams, matched }); else if (qtyUnknown) add("qualifying_product", "unknown", "quantity_unreadable", { primaryPacks, totalGrams, matched }); else add("qualifying_product", "fail", "below_minimum", { primaryPacks, totalGrams, required: q, matched });
  // 7. approved caps only (null = unlimited)
  const capP = rules.caps.perParticipantPerPeriod, capC = rules.caps.perParticipantCampaign;
  if (capP != null && ctx.periodEntryCount >= capP) add("entry_cap", "fail", "entry_cap_reached", { count: ctx.periodEntryCount, cap: capP }); else if (capC != null && ctx.campaignEntryCount >= capC) add("entry_cap", "fail", "entry_cap_reached", { count: ctx.campaignEntryCount, cap: capC }); else add("entry_cap", "pass", null, { unlimited: capP == null && capC == null });
  // 8. OCR confidence and cross-check warnings are information: low -> review, never fail
  const conf = facts.quality.confidence;
  if (conf != null && conf < rules.review.minOcrConfidence) add("ocr_confidence", "unknown", "image_unreadable", { confidence: conf }); else add("ocr_confidence", "pass", null, { confidence: conf });
  const disagree = facts.quality.warnings.filter((w) => /disagreement/.test(w));
  if (disagree.length) add("extraction_consistency", "unknown", "receipt_number_unreadable", { warnings: disagree }); else add("extraction_consistency", "pass", null);

  const fails = R.filter((r) => r.outcome === "fail"), unknowns = R.filter((r) => r.outcome === "unknown");
  let disposition: Disposition, reason: string;
  if (fails.length) { const docFail = fails.find((r) => ["document_is_receipt", "image_quality"].includes(r.rule)); disposition = docFail ? "reupload" : "not_qualified"; reason = (docFail ?? fails[0]).reason!; }
  else if (unknowns.length) { disposition = "review"; reason = unknowns[0].reason!; }
  else { disposition = "qualified"; reason = "ok"; }
  return { disposition, reason, rules: R, primaryPacks, totalGrams, matched, units: disposition === "qualified" ? rules.award.unitsPerReceipt : 0 };
}
