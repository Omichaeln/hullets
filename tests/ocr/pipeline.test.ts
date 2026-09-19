// REAL OCR (tesseract, offline) through the full pipeline on the synthetic fixture set:
// every benchmark fixture must land on its labelled disposition, duplicates must be caught in
// all four re-photograph variants, two phones racing the same purchase get one award (T-12),
// and the seed's draw-pool receipts are all distinct. Covers T-04, T-07, T-09, T-12, T-14.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { schema } from "@promo/db";
import { buildApp, type Harness } from "../helpers.ts";

type Fixture = { id: string; expect: { document?: string; disposition: string | string[]; reason?: string; packs?: number; receiptNo?: string; date?: string; outlet?: string }; duplicateOf: string | null };
const manifest = JSON.parse(fs.readFileSync(path.resolve("fixtures/receipts/manifest.json"), "utf8")) as { fixtures: Fixture[] };
const OUTLET_QUERY: Record<string, string> = { A: "mopani westgate harare", B: "baobab westgate harare", C: "jacaranda westgate harare" };
const layoutOf = (id: string) => id.match(/-([ABC])(?:-photo)?$/)?.[1] ?? "A";
const bench = manifest.fixtures.filter((f) => !/^pool-|^uat-/.test(f.id)); const pool = manifest.fixtures.filter((f) => /^pool-/.test(f.id));
const results: Array<{ id: string; expected: string | string[]; got: string; reason: string | null; receiptNo: string | null; date: string | null; ms: number }> = [];
/** Facts as the pipeline read them (latest extraction attempt). */
async function factsOf(h: Harness, submissionId: string) { const rows = await h.db.select().from(schema.extractions).where(eq(schema.extractions.submissionId, submissionId)); const f = rows.sort((a, b) => b.attemptNo - a.attemptNo)[0]?.facts as { receipt?: { number?: string | null; date?: string | null } } | undefined; return { receiptNo: f?.receipt?.number ?? null, date: f?.receipt?.date ?? null }; }

describe("real OCR pipeline on the fixture set", () => {
  let h: Harness; const P = "263777000001", P2 = "263777000002";
  beforeAll(async () => { h = await buildApp({ extractor: "tesseract" }); await h.register(P, { first: "Ocr", last: "One", identity: "TESTOCR1X" }); await h.register(P2, { first: "Ocr", last: "Two", identity: "TESTOCR2X" }); });
  afterAll(async () => {
    const dir = path.resolve("docs/testing/evidence"); fs.mkdirSync(dir, { recursive: true });
    const pass = results.filter((r) => (Array.isArray(r.expected) ? r.expected.includes(r.got) : r.expected === r.got)).length;
    fs.writeFileSync(path.join(dir, "ocr-pipeline-results.json"), JSON.stringify({ generatedAt: new Date().toISOString(), extractor: "tesseract (offline, real OCR)", fixtures: results.length, agree: pass, results }, null, 2));
    await h.close();
  });
  for (const f of bench.filter((x) => !x.duplicateOf)) {
    it(`T-14 ${f.id}: ${Array.isArray(f.expect.disposition) ? f.expect.disposition.join("|") : f.expect.disposition}`, async () => {
      const t0 = Date.now();
      const r = await h.submit(P, h.fixture(f.id), { outlet: OUTLET_QUERY[layoutOf(f.id)] });
      // Where the system could not establish something and the participant did
      // not answer, the stalled-question sweep hands it to a reviewer. That is
      // the outcome these fixtures are labelled with.
      const s = (r.submission?.status === "awaiting_participant" ? await h.escalate(r.submissionId!) : r.submission)!;
      const facts = await factsOf(h, s.id);
      results.push({ id: f.id, expected: f.expect.disposition, got: s.status, reason: s.reasonCode, receiptNo: facts.receiptNo, date: facts.date, ms: Date.now() - t0 });
      if (Array.isArray(f.expect.disposition)) expect(f.expect.disposition).toContain(s.status); else expect(s.status).toBe(f.expect.disposition);
      if (f.expect.reason && s.status !== "qualified" && s.reasonCode !== "participant_did_not_reply") expect(s.reasonCode).toBe(f.expect.reason);
      if (s.status === "qualified") { const c = (await h.db.select().from(schema.canonicalReceipts).where(eq(schema.canonicalReceipts.id, s.canonicalReceiptId!)))[0]; if (f.expect.receiptNo) expect(c.receiptNo).toBe(f.expect.receiptNo); if (f.expect.date) expect(c.txnDate).toBe(f.expect.date); expect(r.outcomes[0]).toMatch(/entry has been added|qualified entries/); }
      if (s.status === "reupload") expect(r.outcomes[0]).toMatch(/photo/i);
      if (s.status === "not_qualified") expect(r.outcomes[0]).not.toMatch(/won|winner/i);
    });
  }
  for (const f of bench.filter((x) => x.duplicateOf)) {
    it(`T-07 ${f.id} is the same purchase as ${f.duplicateOf} (${f.id.includes("no-total") ? "total lost" : "re-photographed"})`, async () => {
      const t0 = Date.now();
      const r = await h.submit(P2, h.fixture(f.id), { outlet: OUTLET_QUERY[layoutOf(f.duplicateOf!)] });
      const s = (r.submission?.status === "awaiting_participant" ? await h.escalate(r.submissionId!) : r.submission)!;
      const facts = await factsOf(h, s.id);
      results.push({ id: f.id, expected: "duplicate", got: s.status, reason: s.reasonCode, receiptNo: facts.receiptNo, date: facts.date, ms: Date.now() - t0 });
      expect(s.status).toBe("duplicate"); expect(r.outcomes[0]).toMatch(/already been used/); expect(r.outcomes[0]).not.toMatch(/2637770000/);
      expect((await h.db.select().from(schema.entries).where(eq(schema.entries.submissionId, s.id))).length).toBe(0);
    });
  }
  it("T-12: two phones racing the same purchase get exactly one award and one canonical receipt", async () => {
    // Capture-first: neither phone chooses a shop. Both send the same photo at
    // the same moment and the purchase identity is read off the receipt, which
    // is what the race is actually about.
    const img = h.fixture("pool-01-B");
    const [a, b] = await Promise.all([h.app.queue.receive({ provider: "simulator", providerMessageId: `race_${Date.now()}_a`, kind: "message.image", channelUid: P, inlineMediaB64: img.toString("base64") }), h.app.queue.receive({ provider: "simulator", providerMessageId: `race_${Date.now()}_b`, kind: "message.image", channelUid: P2, inlineMediaB64: img.toString("base64") })]);
    expect(a.accepted && b.accepted).toBe(true);
    // two workers process the two events (and then their jobs) concurrently
    await Promise.all([h.app.worker.processEvent(), h.app.worker.processEvent()]); await Promise.all([h.app.worker.processJob(), h.app.worker.processJob()]); await h.app.worker.drain();
    const subs = (await h.db.select().from(schema.submissions)).filter((s) => s.inboundEventId && [a.id, b.id].includes(s.inboundEventId));
    expect(subs.length).toBe(2);
    // The invariant, not one particular ordering: whichever commits first takes
    // the purchase, and the other is withheld — as a duplicate when the first
    // was credited, or as an ownership dispute when it was not. Either way the
    // purchase resolves to ONE canonical receipt and at most one award.
    const statuses = subs.map((s) => s.status).sort();
    expect(statuses.filter((x) => x === "qualified").length, statuses.join(",")).toBeLessThanOrEqual(1);
    expect(statuses.every((x) => ["qualified", "duplicate", "review"].includes(x)), statuses.join(",")).toBe(true);
    // Whichever loses is withheld for a stated reason, never silently dropped.
    for (const w of subs.filter((x) => x.status !== "qualified")) expect(w.reasonCode, `${w.status}/${w.reasonCode}`).toBeTruthy();
    const canon = new Set(subs.map((s) => s.canonicalReceiptId).filter(Boolean)); expect(canon.size, subs.map((x) => `${x.status}/${x.reasonCode}/${x.verificationTier}/${JSON.stringify(x.pendingFields)}`).join(" | ")).toBe(1);
    expect((await h.db.select().from(schema.entries)).filter((e) => subs.some((s) => s.id === e.submissionId)).length).toBeLessThanOrEqual(1);
  });
  it("the draw-pool receipts are all distinct purchases under real OCR", async () => {
    for (const f of pool.slice(1)) { const r = await h.submit(P, h.fixture(f.id), { outlet: OUTLET_QUERY[layoutOf(f.id)] }); results.push({ id: f.id, expected: "qualified", got: r.submission!.status, reason: r.submission!.reasonCode, ...(await factsOf(h, r.submission!.id)), ms: 0 }); expect(r.submission?.status).toBe("qualified"); }
  });
  it("T-04: a stored receipt image is normalised, fingerprinted and retrievable only through the media service", async () => {
    const s = (await h.db.select().from(schema.submissions)).find((x) => x.status === "qualified")!; const a = (await h.app.media.get(s.mediaAssetId!))!;
    expect(a.status).toBe("stored"); expect(a.ahash).toMatch(/^[0-9a-f]{16}$/); expect(a.sha256).toMatch(/^[0-9a-f]{64}$/); expect(a.normalizedKey).toBeTruthy();
    expect((await h.app.media.bytes(a))!.length).toBe(a.bytes); expect((await h.app.media.bytes(a, { normalised: true }))!.length).toBeGreaterThan(1000);
    expect(fs.readdirSync(h.dir, { recursive: true }).some((f) => String(f).endsWith(".jpg") || String(f).endsWith(".png") || String(f).endsWith(".bin"))).toBe(true);
  });
});
