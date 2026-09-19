/**
 * Deterministic receipt text parser: OCR text (untrusted) -> facts with nulls for
 * unknowns. Pattern matching only; no value is inferred from context, and no
 * text is ever interpreted as an instruction.
 */
import type { Facts, LineFact, ExtractionContext, DocumentKind } from "./types.ts";
import { FACTS_SCHEMA } from "./types.ts";
import { matchOutlets, matchProduct } from "./matching.ts";

const KEYWORDS = ["total", "cash", "change", "vat", "tax", "receipt", "invoice", "till", "cashier", "tel", "thank", "subtotal", "qty", "amount", "tender", "balance", "card", "item", "sale", "trading"];
const INJECTION = ["ignore previous", "ignore all", "system prompt", "you are", "approve this", "qualify this", "mark as qualified", "instruction", "assistant"];
const VOID = /\b(void|voided|refund|refunded|return|returned|reversal|reversed|cancel|cancelled)\b/i;
const PACK = /(\d+(?:[.,]\d+)?)\s*(kg|kgs|kilo|kilogram|kilograms|g|gr|gm|gms|gram|grams)\b/i;
const MONEY = /(?<!\d)(\d{1,6})[.,](\d{2})(?!\d)/g;
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

export const money = (s: string | null | undefined): number | null => { if (s == null) return null; const m = String(s).replace(/[\s$]/g, "").match(/^(\d{1,7})[.,](\d{2})$/); return m ? Number(m[1]) * 100 + Number(m[2]) : null; };
export const packGrams = (desc: string): number | null => { const m = String(desc || "").match(PACK); if (!m) return null; const n = Number(m[1].replace(",", ".")); if (!Number.isFinite(n) || n <= 0) return null; return /^k/i.test(m[2]) ? Math.round(n * 1000) : Math.round(n); };
/** Repair OCR punctuation inside numbers only ("3:19", "3_19", "6·20" -> "6.20"; "6,2O" -> "6.20"). */
export const cleanLine = (l: string) => String(l || "").trim().replace(/(\d)[:_·°'`‘’](\d{2})(?!\d)/g, "$1.$2").replace(/(\d[.,])([0-9OoIl]{2})(?![0-9A-Za-z])/g, (_, a, b) => a + b.replace(/[Oo]/g, "0").replace(/[Il]/g, "1")).replace(/\s+/g, " ");

export function classify(text: string, quality: Record<string, unknown> = {}) {
  const t = text.toLowerCase(); const words = t.split(/\s+/).filter(Boolean);
  const kw = KEYWORDS.filter((k) => t.includes(k)).length; const prices = (t.match(/\d+[.,]\d{2}\b/g) || []).length; const dateLike = /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\s+[a-z]{3,4}\.?\s+\d{2,4}\b/.test(t);
  const injectionHits = INJECTION.filter((k) => t.includes(k)).length;
  let score = Math.min(kw, 5) * 0.1 + Math.min(prices, 4) * 0.1 + (dateLike ? 0.1 : 0);
  if (words.length < 6) score = Math.min(score, 0.15); score = Math.min(1, Number(score.toFixed(2)));
  const kind: DocumentKind = score >= 0.5 ? "receipt" : score <= 0.2 ? "non_receipt" : "unknown";
  return { kind, score, signals: { keywords: kw, priceTokens: prices, dateLike, words: words.length, injectionHits, ...quality }, injectionSuspected: injectionHits > 0 };
}
export function parseDate(text: string, dateOrder: "DMY" | "MDY") {
  let m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/); if (m) return valid(+m[1], +m[2], +m[3], m[0], false);
  m = text.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/);
  if (m) { const a = +m[1], b = +m[2]; let y = +m[3]; if (y < 100) y += 2000; let d: number, mo: number, amb = false; if (a > 12 && b <= 12) { d = a; mo = b; } else if (b > 12 && a <= 12) { d = b; mo = a; } else { amb = a !== b && a <= 12 && b <= 12; if (dateOrder === "MDY") { mo = a; d = b; } else { d = a; mo = b; } } return valid(y, mo, d, m[0], amb); }
  m = text.match(/\b(\d{1,2})\s+([A-Za-z]{3,4})\.?,?\s+(\d{4}|\d{2})\b/); if (m && MONTHS[m[2].toLowerCase()]) { let y = +m[3]; if (y < 100) y += 2000; return valid(y, MONTHS[m[2].toLowerCase()], +m[1], m[0], false); }
  m = text.match(/\b([A-Za-z]{3,4})\.?\s+(\d{1,2}),?\s+(\d{4})\b/); if (m && MONTHS[m[1].toLowerCase()]) return valid(+m[3], MONTHS[m[1].toLowerCase()], +m[2], m[0], false);
  return null;
}
function valid(y: number, mo: number, d: number, raw: string, ambiguous: boolean) { if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null; const dt = new Date(Date.UTC(y, mo - 1, d)); if (dt.getUTCMonth() !== mo - 1) return null; return { date: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`, raw, ambiguous }; }
export function parseTime(text: string) { const m = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\b/); return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null; }
export function parseReceiptNo(text: string) {
  for (const re of [/(?:receipt|rcpt|rec|invoice|inv|slip|docket|doc(?:ument)?|trans(?:action)?|txn|ref(?:erence)?)\s*(?:no|nr|num|number|#)?\s*[:#.]?\s*([A-Z0-9][A-Z0-9/-]{2,})/i, /\b(?:no|nr|num)\s*[:#.]\s*([A-Z0-9][A-Z0-9/-]{3,})/i, /#\s*(\d{4,})/]) {
    const m = text.match(re); if (!m) continue; const v = m[1].toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!/\d/.test(v) || /^(TILL|DATE|TIME|POS|NO|NR)$/.test(v) || v.length < 3) continue; return { receiptNo: v, raw: m[0] };
  }
  return { receiptNo: null, raw: null };
}
export function parseTill(text: string) { const m = text.match(/\b(?:till|terminal|pos|register|lane|counter)\s*(?:no|nr|#)?\s*[:#.]?\s*([A-Z0-9]{1,6})\b/i); return m ? m[1].toUpperCase() : null; }
export function parseTotal(lines: string[]) {
  let best: { totalMinor: number; raw: string } | null = null;
  for (const l of lines) { if (/sub\s*-?\s*total|total\s*(items|qty|quantity|savings|discount)|items?\s*total/i.test(l)) continue; if (!/\b(grand\s+)?total\b|\bamount\s+due\b|\bto\s+pay\b/i.test(l)) continue; const toks = [...l.matchAll(MONEY)]; if (toks.length) { const t = toks[toks.length - 1]; best = { totalMinor: Number(t[1]) * 100 + Number(t[2]), raw: l }; } }
  return best ?? { totalMinor: null, raw: null };
}
export function parseCurrency(text: string) { if (/\bUSD\b|US\$/i.test(text) || /\$/.test(text)) return "USD"; if (/\bZWG\b|\bZiG\b/i.test(text)) return "ZWG"; if (/\bZAR\b|(?<![A-Za-z])R\s?\d/.test(text)) return "ZAR"; return null; }

const STOP = /\b(sub\s*-?\s*total|total|cash|change|tender|vat|tax|balance|card|thank|receipt|invoice|slip|till|date|tel|cashier|pos|payment|paid|due|rounding|discount|savings)\b/i;
const HAS_WORD = /[A-Za-z]{3,}/;
const QTY_LEAD = /^(\d{1,3})\s*(?:x|@|\*|×)\s*/i;
const INLINE = /^(.*?[A-Za-z]{3,}.*?)\s+(\d{1,3})\s*(?:x|@|\*|×)\s*(\d+[.,]\d{2})\s*=?\s*(\d+[.,]\d{2})\s*$/i;
const INLINE_QTY_ONLY = /^(.*?[A-Za-z]{3,}.*?)\s+(?:qty\s*[:.]?\s*)?(\d{1,3})\s*(?:x|×)\s*(\d+[.,]\d{2})\s*$/i;
const DESC_PRICE = /^(.*?[A-Za-z]{3,}.*?)\s+(\d{1,6}[.,]\d{2})\s*[A-Z]?\s*$/;
const QTY_LINE = /^(?:qty\s*[:.]?\s*)?(\d{1,3})\s*(?:x|@|\*|×)\s*(\d+[.,]\d{2})(?:\s*=?\s*(\d+[.,]\d{2}))?\s*$/i;
export function parseLines(raw: string[]): LineFact[] {
  const lines = raw.map(cleanLine).filter(Boolean); const items: LineFact[] = [];
  const push = (desc: string, qty: number | null, unit: string | null, amount: string | null, src: string) => { const description = desc.replace(/\s+/g, " ").trim(); items.push({ n: items.length + 1, raw: src, description, quantity: qty != null && qty > 0 && qty < 1000 ? qty : null, packGrams: packGrams(description), unitMinor: money(unit), amountMinor: money(amount), voided: VOID.test(src), product: null }); };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], next = lines[i + 1] ?? "";
    if (STOP.test(l) && !PACK.test(l)) continue;
    let m = l.match(INLINE); if (m) { push(m[1], +m[2], m[3], m[4], l); continue; }
    m = l.match(INLINE_QTY_ONLY); if (m) { push(m[1], +m[2], m[3], null, l); continue; }
    const lead = l.match(QTY_LEAD); if (lead && HAS_WORD.test(l.slice(lead[0].length))) { const rest = l.slice(lead[0].length); const dp = rest.match(DESC_PRICE); push(dp ? dp[1] : rest, +lead[1], null, dp ? dp[2] : null, l); continue; }
    m = l.match(DESC_PRICE);
    if (m && !/^\d/.test(l)) { const q = next.match(QTY_LINE); if (q) { push(m[1], +q[1], q[2], q[3] ?? m[2], `${l} | ${next}`); i++; } else push(m[1], 1, null, m[2], l); continue; }
    // Some fiscal printers put the product description on one row and the
    // quantity/unit/amount values on the next row. Only consume this shape
    // when the description contains a pack size and the following row has a
    // quantity plus additional numeric evidence; a lone price such as 15.50
    // must not become a quantity of 15.
    if (packGrams(l) != null) {
      const q = next.match(/^(\d{1,3})(?=\s|$)/); const tail = q ? next.slice(q[0].length).trim() : "";
      if (q && !QTY_LINE.test(next) && /\d/.test(tail)) { push(l, +q[1], null, null, `${l} | ${next}`); i++; continue; }
    }
    if (HAS_WORD.test(l) && !/\d+[.,]\d{2}\s*$/.test(l)) { const q = next.match(QTY_LINE); if (q) { push(l, +q[1], q[2], q[3] ?? null, `${l} | ${next}`); i++; } }
  }
  // a VOID/REFUND line cancels the nearest preceding item it names (or the previous item)
  for (let i = 0; i < lines.length; i++) { if (!VOID.test(lines[i]) || items.some((it) => it.raw === lines[i])) continue; const toks = norm(lines[i]).split(" ").filter((w) => w.length > 2 && !VOID.test(w)); for (let j = items.length - 1; j >= 0; j--) { const d = norm(items[j].description).split(" "); if (!toks.length || toks.some((t) => d.includes(t))) { items[j].voided = true; break; } } }
  return items;
}
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

export function parseReceiptText(text: string, ctx: ExtractionContext, provenance: { provider: string; model: string; promptVersion: string | null; latencyMs?: number; confidence?: number | null; raw?: Record<string, unknown> | null }): Facts {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const doc = classify(text, ctx.quality);
  const itemStart = lines.findIndex((l) => /\b(retail|description|quantity|unit\s+price|amount)\b/i.test(l));
  const header = lines.slice(0, itemStart > 0 ? itemStart : Math.min(lines.length, 20)).join(" ");
  const rn = parseReceiptNo(text); const d = parseDate(text, ctx.dateOrder); const total = parseTotal(lines.map(cleanLine));
  const items = parseLines(lines).map((li) => ({ ...li, product: matchProduct(li.description, ctx.products) }));
  const missing: string[] = []; if (!rn.receiptNo) missing.push("receipt_number"); if (!d) missing.push("transaction_date"); if (total.totalMinor == null) missing.push("total"); if (!items.length) missing.push("line_items");
  const warnings: string[] = []; if (d?.ambiguous) warnings.push("date_day_month_ambiguous"); if (doc.injectionSuspected) warnings.push("instruction_like_text_ignored");
  return { schema: FACTS_SCHEMA, provider: provenance.provider, model: provenance.model, promptVersion: provenance.promptVersion, latencyMs: provenance.latencyMs ?? 0, ocrText: String(text || ""), document: { kind: doc.kind, score: doc.score, signals: doc.signals }, merchant: { text: header || null, candidates: matchOutlets(header, ctx.outlets) }, transaction: { receiptNo: rn.receiptNo, receiptNoRaw: rn.raw, till: parseTill(text), date: d?.date ?? null, dateRaw: d?.raw ?? null, dateAmbiguous: !!d?.ambiguous, time: parseTime(text), currency: parseCurrency(text), totalMinor: total.totalMinor, totalRaw: total.raw }, lines: items, quality: { missing, warnings, confidence: provenance.confidence ?? null, injectionSuspected: doc.injectionSuspected }, raw: provenance.raw ?? null };
}
