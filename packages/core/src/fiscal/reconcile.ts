import { EvidenceLedger, type EvidenceField } from "./evidence.ts";
import { isAuthoritative, type FiscalVerification } from "./types.ts";
import type { Facts, LineFact } from "../extraction/types.ts";
import type { ExtractionContext } from "../extraction/types.ts";

/**
 * Build the evidence ledger for one submission, then reconcile it.
 *
 * Three streams feed in, in descending authority: the fiscal record from the
 * revenue authority, whatever OCR and the model read off the photograph, and
 * whatever the participant confirmed or supplied. They are all recorded. The
 * ledger decides what is believed; this module decides what each stream
 * asserts, and matches the fiscal record's own text back onto the campaign's
 * outlet list so a branch name becomes an outlet the rules can reason about.
 */

/** Values the participant confirmed or supplied, keyed by ledger field. */
export type UserEvidence = Partial<Record<EvidenceField, unknown>>;

/** Fields the promotion needs before an entry can be judged at all. */
export const REQUIRED_FIELDS: readonly EvidenceField[] = ["outletId", "date", "receiptNo"];

/** The score at which a receipt header is taken to NAME an outlet rather than merely be consistent with one. */
export const OCR_OUTLET_MIN_SCORE = 0.8;

const qualifyingUnits = (lines: readonly LineFact[], packGrams: number) =>
  lines.filter((l) => !l.voided && l.product && (l.packGrams ?? l.product?.packGrams) === packGrams).reduce((a, l) => a + (l.quantity ?? 0), 0);

/** Score an outlet against free text, reusing the campaign's own alias list. */
export function matchOutlet(text: string | null | undefined, outlets: ExtractionContext["outlets"]): { outletId: string; score: number } | null {
  const hay = String(text ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length >= 3);
  if (!hay.length) return null;
  let best: { outletId: string; score: number } | null = null;
  for (const o of outlets) {
    const terms = [o.retailer, o.branch, o.town, ...o.aliases].map((t) => String(t).toLowerCase().replace(/[^a-z0-9 ]/g, " ").trim()).filter(Boolean);
    let hits = 0;
    for (const t of terms) for (const w of t.split(/\s+/)) if (w.length >= 3 && hay.includes(w)) { hits++; break; }
    const score = terms.length ? hits / Math.min(terms.length, 4) : 0;
    if (score > 0 && (!best || score > best.score)) best = { outletId: o.id, score: Math.min(1, score) };
  }
  return best && best.score >= 0.5 ? best : null;
}

/** Translate the fiscal record's line items into the same shape the rules engine reads. */
export function fiscalLinesAsFacts(v: FiscalVerification, products: ExtractionContext["products"]): LineFact[] {
  const lines = v.record?.lines ?? [];
  return lines.map((l) => {
    const hay = `${l.description} ${l.code ?? ""}`.toLowerCase();
    const product = products.find((p) => [p.name, p.code, ...p.aliases].some((a) => a && hay.includes(String(a).toLowerCase()))) ?? null;
    // A pack size printed in the description ("2KG") is a pack size, never a
    // quantity. The catalogue's packGrams is authoritative for the product.
    return {
      n: l.n,
      raw: l.description,
      description: l.description,
      quantity: l.quantity != null ? Math.round(l.quantity) : null,
      packGrams: product?.packGrams ?? null,
      unitMinor: l.unitMinor,
      amountMinor: l.amountMinor,
      voided: false,
      product: product ? { code: product.code, packGrams: product.packGrams, basis: "fiscal_line" } : null,
    } satisfies LineFact;
  });
}

export type ReconcileInput = {
  fiscal: FiscalVerification | null;
  facts: Facts | null;
  user: UserEvidence;
  context: ExtractionContext;
  packGrams: number;
  /** The outlet the participant picked earlier in the conversation, if any. */
  selectedOutletId?: string | null;
};

export type Reconciliation = {
  ledger: EvidenceLedger;
  authoritative: boolean;
  /** The line items the rules engine should judge, from the strongest source that has any. */
  lines: LineFact[];
  linesSource: "zimra_fdms" | "ocr" | "none";
  missing: EvidenceField[];
};

/**
 * Record what each source asserts, then hand back the ledger.
 *
 * Note what this does NOT do: it never lets the fiscal record stand in for the
 * receipt image. The authority establishes the transaction; the image
 * establishes that the document the participant photographed is that
 * transaction. Both are recorded, and where they disagree the ledger keeps the
 * disagreement.
 */
export function reconcile(input: ReconcileInput): Reconciliation {
  const { fiscal, facts, user, context, packGrams } = input;
  const ledger = new EvidenceLedger();
  const authoritative = isAuthoritative(fiscal);

  if (authoritative && fiscal?.record) {
    const r = fiscal.record;
    ledger.observe("merchant", "zimra_fdms", r.merchantName);
    ledger.observe("branch", "zimra_fdms", r.branchName ?? r.branchCode);
    ledger.observe("date", "zimra_fdms", r.txnDate);
    ledger.observe("time", "zimra_fdms", r.txnAt && r.txnAt.includes("T") ? r.txnAt.slice(11, 16) : null);
    // The number PRINTED on a receipt is its invoice number. receiptGlobalNo is
    // a device-lifetime counter that identifies the transaction to the
    // authority and is generally not what the customer sees — comparing it
    // against what OCR read off the paper made every fiscal receipt look like
    // a mismatch. It stays in the identity (and in the canonical key) but is
    // only offered as the printed number when there is no invoice number.
    ledger.observe("receiptNo", "zimra_fdms", r.invoiceNo ?? r.receiptGlobalNo);
    ledger.observe("invoiceNo", "zimra_fdms", r.invoiceNo);
    ledger.observe("verificationCode", "zimra_fdms", r.verificationCode);
    ledger.observe("currency", "zimra_fdms", r.currency);
    ledger.observe("total", "zimra_fdms", r.totalMinor);
    ledger.observe("tax", "zimra_fdms", r.taxMinor);
    const fiscalLines = fiscalLinesAsFacts(fiscal, context.products);
    if (fiscalLines.length) {
      ledger.observe("lines", "zimra_fdms", fiscalLines.map((l) => ({ d: l.description, q: l.quantity, a: l.amountMinor })));
      ledger.observe("qualifyingUnits", "zimra_fdms", qualifyingUnits(fiscalLines, packGrams));
    }
    const outletFromFiscal = matchOutlet([r.merchantName, r.branchName, r.branchCode].filter(Boolean).join(" "), context.outlets);
    if (outletFromFiscal) ledger.observe("outletId", "zimra_fdms", outletFromFiscal.outletId, `matched "${[r.merchantName, r.branchName].filter(Boolean).join(" / ")}" at ${outletFromFiscal.score.toFixed(2)}`);
  }

  if (facts) {
    const t = facts.transaction;
    ledger.observe("merchant", "ocr", facts.merchant.text);
    ledger.observe("date", "ocr", t.date, t.dateAmbiguous ? "ambiguous day/month order" : null);
    ledger.observe("time", "ocr", t.time);
    ledger.observe("receiptNo", "ocr", t.receiptNo);
    ledger.observe("currency", "ocr", t.currency);
    ledger.observe("total", "ocr", t.totalMinor);
    // ESTABLISHING the outlet from a header needs a stronger match than merely
    // corroborating one. The campaign's outletMatch.minScore (0.5 by default)
    // governs whether a header is consistent with an outlet already known; it
    // is far too loose to name one, because a receipt that mentions only the
    // town scores well against every branch in that town. Below this bar the
    // outlet stays unestablished and the participant is asked — which is the
    // honest answer, and much better than quietly picking a plausible branch.
    const top = [...facts.merchant.candidates].sort((a, b) => b.score - a.score)[0];
    if (top && top.score >= OCR_OUTLET_MIN_SCORE) ledger.observe("outletId", "ocr", top.outletId, `header matched at ${top.score.toFixed(2)} (${top.basis})`);
    if (facts.lines.length) {
      ledger.observe("lines", "ocr", facts.lines.map((l) => ({ d: l.description, q: l.quantity, a: l.amountMinor })));
      ledger.observe("qualifyingUnits", "ocr", qualifyingUnits(facts.lines, packGrams));
    }
  }

  // The participant's answers are evidence at the lowest authority. An outlet
  // they picked before sending the photo counts the same way: it is a claim
  // about the transaction, to be reconciled, not a fact to be assumed.
  if (input.selectedOutletId) ledger.observe("outletId", "user", input.selectedOutletId, "chosen in the conversation");
  for (const [field, value] of Object.entries(user) as Array<[EvidenceField, unknown]>) ledger.observe(field, "user", value, "supplied by the participant");

  const fiscalLines = authoritative && fiscal ? fiscalLinesAsFacts(fiscal, context.products) : [];
  const lines = fiscalLines.length ? fiscalLines : (facts?.lines ?? []);
  const linesSource: Reconciliation["linesSource"] = fiscalLines.length ? "zimra_fdms" : facts?.lines.length ? "ocr" : "none";

  return { ledger, authoritative, lines, linesSource, missing: ledger.missing(REQUIRED_FIELDS) };
}
