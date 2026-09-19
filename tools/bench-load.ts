/**
 * Load benchmark (§20): a throwaway database, the SIMULATED extractor and transport
 * (so the numbers measure the platform, not OCR or WhatsApp), N participants firing
 * M inbound events (menu, outlet and receipt traffic) processed by W concurrent
 * worker loops. Reports throughput, end-to-end latency percentiles, exactly-once
 * evidence (entries == distinct receipts, no dead letters) and queue depth over time.
 * Output: docs/testing/evidence/load-benchmark.{json,md}.
 * Env: LOAD_PARTICIPANTS (default 40) LOAD_RECEIPTS (200) LOAD_WORKERS (4).
 */
import fs from "node:fs";
import path from "node:path";
import { schema } from "@promo/db";
import { buildApp } from "../tests/helpers.ts";

const P = Number(process.env.LOAD_PARTICIPANTS ?? 40), R = Number(process.env.LOAD_RECEIPTS ?? 200), W = Number(process.env.LOAD_WORKERS ?? 4);
const h = await buildApp({ extractor: "simulator" });
const phones = Array.from({ length: P }, (_, i) => `2637790${String(i + 1).padStart(5, "0")}`);
console.error(`[load] registering ${P} participants`); const t0 = Date.now();
for (const [i, p] of phones.entries()) { await h.register(p, { first: "Load", last: `Tester${"ABCDEFGHIJ"[i % 10]}`, identity: `TESTLD${i}X` }); await h.answerOutlet(p); }
const setupMs = Date.now() - t0;
console.error(`[load] queueing ${R} receipt images (${Math.round(R * 0.1)} of them duplicates) + ${R} status messages without processing`);
const images: Array<{ phone: string; img: Buffer }> = [];
for (let i = 0; i < R; i++) { const dup = i % 10 === 9; const no = dup ? `L${String(i - 1).padStart(6, "0")}` : `L${String(i).padStart(6, "0")}`; images.push({ phone: phones[i % P], img: await h.simImage(h.simReceipt({ no, packs: 2 })) }); }
const tq = Date.now();
await Promise.all(images.map((x, i) => h.app.queue.receive({ provider: "simulator", providerMessageId: `load_img_${i}`, kind: "message.image", channelUid: x.phone, inlineMediaB64: x.img.toString("base64"), timestamp: new Date().toISOString() })));
await Promise.all(phones.map((p, i) => h.app.queue.receive({ provider: "simulator", providerMessageId: `load_txt_${i}`, kind: "message.text", channelUid: p, text: "7", timestamp: new Date().toISOString() })));
const queueMs = Date.now() - tq;
const depth: Array<{ t: number; events: number; jobs: number; outbox: number }> = [];
const sampler = setInterval(async () => { const s = await h.app.queue.stats(); const o = await h.app.outbox.stats(); depth.push({ t: Date.now() - tq, events: (s.events.received ?? 0) + (s.events.processing ?? 0), jobs: (s.jobs.pending ?? 0) + (s.jobs.leased ?? 0), outbox: o.byStatus.pending ?? 0 }); }, 500);
console.error(`[load] processing with ${W} concurrent worker loops`); const tp = Date.now();
await Promise.all(Array.from({ length: W }, async () => { for (;;) { const n = await h.app.worker.drain(50); if (!n) break; } }));
await h.app.worker.drain(); const processMs = Date.now() - tp; clearInterval(sampler);
const events = await h.db.select().from(schema.inboundEvents); const jobs = await h.db.select().from(schema.jobs);
const lat = events.filter((e) => e.processedAt && e.kind === "message.image").map((e) => Date.parse(e.processedAt!) - Date.parse(e.receivedAt)).sort((a, b) => a - b);
const subs = await h.db.select().from(schema.submissions); const entries = await h.db.select().from(schema.entries); const canon = await h.db.select().from(schema.canonicalReceipts);
const decided = subs.filter((s) => s.decidedAt).map((s) => Date.parse(s.decidedAt!) - Date.parse(s.intakeAt)).sort((a, b) => a - b);
const pct = (arr: number[], x: number) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(x * arr.length))] : null;
const outbox = await h.app.outbox.stats(); const st = await h.app.queue.stats();
const distinctReceipts = new Set(images.map((_, i) => (i % 10 === 9 ? i - 1 : i))).size;
const out = {
  generatedAt: new Date().toISOString(), config: { participants: P, receipts: R, workers: W, extractor: "simulator (does not read pixels)", transport: "simulator" },
  timings: { setupMs, enqueueMs: queueMs, processMs, eventsPerSecond: Number(((R + P) / (processMs / 1000)).toFixed(1)), receiptsPerSecond: Number((R / (processMs / 1000)).toFixed(1)) },
  latencyMs: { inboundToProcessed: { p50: pct(lat, 0.5), p95: pct(lat, 0.95), max: lat.at(-1) ?? null }, intakeToDecision: { p50: pct(decided, 0.5), p95: pct(decided, 0.95), max: decided.at(-1) ?? null } },
  correctness: { submissions: subs.length, qualified: subs.filter((s) => s.status === "qualified").length, duplicate: subs.filter((s) => s.status === "duplicate").length, other: subs.filter((s) => !["qualified", "duplicate"].includes(s.status)).length, entries: entries.length, canonicalReceipts: canon.length, distinctReceiptsSent: distinctReceipts, exactlyOnce: entries.length === distinctReceipts && canon.length === distinctReceipts, deadEvents: st.events.dead ?? 0, failedEvents: st.events.failed ?? 0, deadJobs: st.jobs.dead ?? 0, jobsTotal: jobs.length, outbox: outbox.byStatus },
  queueDepth: depth,
};
out.correctness.exactlyOnce = out.correctness.exactlyOnce && out.correctness.deadEvents === 0 && out.correctness.deadJobs === 0;
const dir = path.resolve("docs/testing/evidence"); fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "load-benchmark.json"), JSON.stringify(out, null, 2));
fs.writeFileSync(path.join(dir, "load-benchmark.md"), [`# Load benchmark`, ``, `Generated ${out.generatedAt} · ${P} participants · ${R} receipts (10% duplicates) + ${P} status messages · ${W} worker loops · simulated extractor and transport (platform cost only, no OCR, no WhatsApp).`, ``, `| Metric | Value |`, `|---|---|`, `| Processing wall time | ${processMs} ms |`, `| Throughput | ${out.timings.eventsPerSecond} events/s (${out.timings.receiptsPerSecond} receipts/s) |`, `| Inbound → processed p50 / p95 / max | ${out.latencyMs.inboundToProcessed.p50} / ${out.latencyMs.inboundToProcessed.p95} / ${out.latencyMs.inboundToProcessed.max} ms (includes queue wait) |`, `| Intake → decision p50 / p95 / max | ${out.latencyMs.intakeToDecision.p50} / ${out.latencyMs.intakeToDecision.p95} / ${out.latencyMs.intakeToDecision.max} ms |`, `| Entries / canonical receipts / distinct receipts sent | ${entries.length} / ${canon.length} / ${distinctReceipts} |`, `| Exactly-once | **${out.correctness.exactlyOnce ? "yes" : "NO"}** |`, `| Dead events / failed events / dead jobs | ${out.correctness.deadEvents} / ${out.correctness.failedEvents} / ${out.correctness.deadJobs} |`, `| Outbox by status | ${JSON.stringify(outbox.byStatus)} |`, ``, `Queue depth samples (ms since enqueue → pending events / jobs / outbox): ${depth.map((d) => `${d.t}:${d.events}/${d.jobs}/${d.outbox}`).join(", ")}`, ``].join("\n"));
console.log(JSON.stringify({ ...out, queueDepth: undefined }, null, 2));
await h.close(); process.exit(out.correctness.exactlyOnce ? 0 : 1);
