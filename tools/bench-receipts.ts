/**
 * Receipt extraction benchmark (§20 evidence). Runs the configured REAL extractor
 * (EXTRACTOR=tesseract by default; anthropic / anthropic+tesseract when a key is set)
 * over the labelled fixture set, evaluates each result with the sample rules and
 * reports disposition agreement, field accuracy and latency. No database: this
 * measures reading + rules, not the ledger (dedupe is covered by tests/ocr).
 * Output: docs/testing/evidence/receipt-benchmark.{json,md}. Exit 1 below the gate.
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig, createExtractor, evaluate, Rules, images } from "@promo/core";
import { sampleOutlets, SAMPLE_PRODUCTS } from "./lib/sample.ts";

type Fixture = { id: string; file: string; notes: string; expect: { document?: string; disposition: string | string[]; reason?: string; packs?: number; receiptNo?: string; date?: string; outlet?: string }; duplicateOf: string | null };
const GATE = { dispositionAgreement: 0.9, qualifiedFieldAccuracy: 1.0 };
const manifest = JSON.parse(fs.readFileSync(path.resolve("fixtures/receipts/manifest.json"), "utf8")) as { fixtures: Fixture[] };
const cfg = loadConfig({ ...process.env, ENVIRONMENT: process.env.ENVIRONMENT ?? "local", EXTRACTOR: process.env.EXTRACTOR ?? "tesseract" });
if (cfg.EXTRACTOR === "simulator") { console.error("the benchmark needs a real extractor (EXTRACTOR=tesseract|anthropic|anthropic+tesseract)"); process.exit(2); }
const extractor = createExtractor(cfg);
const rules = Rules.parse({ products: SAMPLE_PRODUCTS, qualification: { mode: "packs", minPacks: 2, packGrams: 2000, minTotalGrams: 4000, allowMixedPacks: false }, dateOrder: "DMY", purchaseWindow: { start: "2026-09-01T00:00:00Z", end: "2027-01-01T00:00:00Z" } });
const outlets = sampleOutlets().map((o) => ({ id: `out_${o.code}`, code: o.code, retailer: o.retailer, branch: o.branch, town: o.town, aliases: o.aliases }));
const rows: Array<Record<string, unknown>> = []; const lat: number[] = [];
const fixtures = manifest.fixtures.filter((f) => !f.duplicateOf);
for (const f of fixtures) {
  const bytes = fs.readFileSync(path.resolve("fixtures/receipts", f.file)); const t0 = Date.now();
  const q = await images.quality(bytes); const normalised = await images.normalise(bytes);
  const outletId = f.expect.outlet ? `out_${f.expect.outlet}` : outlets[0].id;
  const facts = await extractor.extract({ original: bytes, normalised, mime: "image/jpeg", context: { outlets, products: rules.products, dateOrder: rules.dateOrder, quality: q as unknown as Record<string, unknown> } });
  const ev = evaluate(facts, rules, { intakeAt: new Date().toISOString(), campaignOpen: true, windowStart: rules.purchaseWindow!.start, windowEnd: rules.purchaseWindow!.end, selectedOutletId: outletId, selectedOutletParticipating: true, enrolled: true, participantActive: true, periodEntryCount: 0, campaignEntryCount: 0, imageQuality: q });
  const ms = Date.now() - t0; lat.push(ms);
  const exp = f.expect; const okDisp = Array.isArray(exp.disposition) ? exp.disposition.includes(ev.disposition) : exp.disposition === ev.disposition;
  const fields = { receiptNo: exp.receiptNo ? facts.transaction.receiptNo === exp.receiptNo.toUpperCase().replace(/[^A-Z0-9]/g, "") : null, date: exp.date ? facts.transaction.date === exp.date : null, packs: exp.packs != null ? ev.primaryPacks === exp.packs : null, document: exp.document ? facts.document.kind === exp.document : null };
  rows.push({ id: f.id, notes: f.notes, expected: exp.disposition, got: ev.disposition, reason: ev.reason, agree: okDisp, fields, receiptNo: facts.transaction.receiptNo, date: facts.transaction.date, packs: ev.primaryPacks, confidence: facts.quality.confidence, ms });
  console.error(`${okDisp ? "ok  " : "MISS"} ${f.id.padEnd(28)} ${String(ev.disposition).padEnd(14)} ${ev.reason.padEnd(26)} ${ms}ms`);
}
const agree = rows.filter((r) => r.agree).length / rows.length;
const fieldChecks = rows.flatMap((r) => Object.values(r.fields as Record<string, boolean | null>).filter((v) => v !== null)); const fieldAcc = fieldChecks.filter(Boolean).length / Math.max(1, fieldChecks.length);
const qualifiedRows = rows.filter((r) => r.expected === "qualified"); const qualifiedFieldChecks = qualifiedRows.flatMap((r) => Object.values(r.fields as Record<string, boolean | null>).filter((v) => v !== null)); const qualifiedFieldAcc = qualifiedFieldChecks.filter(Boolean).length / Math.max(1, qualifiedFieldChecks.length);
const sorted = [...lat].sort((a, b) => a - b); const p = (x: number) => sorted[Math.min(sorted.length - 1, Math.floor(x * sorted.length))];
const h = await extractor.health();
const out = { generatedAt: new Date().toISOString(), extractor: { name: extractor.name, mode: extractor.mode, model: h.model ?? null }, gate: GATE, fixtures: rows.length, dispositionAgreement: agree, fieldAccuracy: fieldAcc, qualifiedFieldAccuracy: qualifiedFieldAcc, latencyMs: { p50: p(0.5), p95: p(0.95), max: sorted.at(-1) }, pass: agree >= GATE.dispositionAgreement && qualifiedFieldAcc >= GATE.qualifiedFieldAccuracy, note: "Synthetic fixtures (fictional retailers and products). Agreement on client-supplied real receipts is the activation evidence (docs/testing/receipt-benchmark.md).", rows };
const dir = path.resolve("docs/testing/evidence"); fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "receipt-benchmark.json"), JSON.stringify(out, null, 2));
const md = [`# Receipt extraction benchmark`, ``, `Generated ${out.generatedAt} · extractor **${out.extractor.name}** (${out.extractor.mode}${out.extractor.model ? `, ${out.extractor.model}` : ""})`, ``, `| Metric | Value | Gate |`, `|---|---|---|`, `| Disposition agreement | ${(agree * 100).toFixed(1)}% (${rows.filter((r) => r.agree).length}/${rows.length}) | ≥ ${GATE.dispositionAgreement * 100}% |`, `| Labelled field accuracy (all) | ${(fieldAcc * 100).toFixed(1)}% (${fieldChecks.filter(Boolean).length}/${fieldChecks.length}) | – |`, `| Labelled field accuracy (qualified receipts) | ${(qualifiedFieldAcc * 100).toFixed(1)}% | ${GATE.qualifiedFieldAccuracy * 100}% |`, `| Latency p50 / p95 / max | ${out.latencyMs.p50} / ${out.latencyMs.p95} / ${out.latencyMs.max} ms | – |`, `| Result | **${out.pass ? "PASS" : "FAIL"}** | |`, ``, `> ${out.note}`, ``, `| Fixture | Expected | Got | Reason | No. | Date | Packs | ms |`, `|---|---|---|---|---|---|---|---|`, ...rows.map((r) => `| ${r.id} | ${Array.isArray(r.expected) ? (r.expected as string[]).join(" / ") : r.expected} | ${r.agree ? "" : "**"}${r.got}${r.agree ? "" : "**"} | ${r.reason} | ${r.receiptNo ?? "–"} | ${r.date ?? "–"} | ${r.packs} | ${r.ms} |`)].join("\n");
fs.writeFileSync(path.join(dir, "receipt-benchmark.md"), md + "\n");
console.log(JSON.stringify({ ...out, rows: undefined }, null, 2)); await extractor.close?.(); process.exit(out.pass ? 0 : 1);
