/**
 * Integration harness: a throwaway PostgreSQL database per suite (real
 * constraints, real transactions), the full application wiring, the simulator
 * transport and either the labelled SIMULATED extractor (fast: rules/ledger/
 * draw suites) or the REAL tesseract OCR (pipeline suites with fixture images).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createApp, loadConfig, SimulatorTransport, SimulatorExtractor, TesseractExtractor, SimulatorFdmsAdapter, embedReceiptText, silentLogger, sha256 } from "@promo/core";
import { ensureDatabase, dropDatabase } from "@promo/db";
import { ensureSampleCampaign, ensureSampleStaff, SAMPLE_CODE } from "../tools/lib/sample.ts";
import { fixture } from "../tools/lib/journeys.ts";
import sharp from "sharp";
import { schema } from "@promo/db";
import { eq } from "drizzle-orm";

let sharedOcr: TesseractExtractor | null = null;
export const realExtractor = () => (sharedOcr ??= new TesseractExtractor());
export const BASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://promo:promo@127.0.0.1:5432/promo";
/**
 * Test decoder for the fiscal path.
 *
 * Reads a `<<QR:...>>` marker appended to the image bytes rather than decoding
 * pixels, exactly as the simulated extractor reads embedded receipt text. The
 * real decoder is covered separately in tests/unit/fiscal.test.ts against a
 * genuine QR image.
 */
const markerDecoder = async (bytes: Buffer) => {
  const m = bytes.toString("latin1").match(/<<QR:([^>]+)>>/);
  return m ? [{ format: "QR_CODE", text: m[1], rawSha256: sha256(m[1]) }] : [];
};

export async function buildApp({ extractor = "simulator", seed = true, env = {} as Record<string, string>, transport: transportKind = "simulator" as "simulator" | "cloud-api", fiscal = false } = {}) {
  const name = `promo_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`; const url = BASE_URL.replace(/\/[^/]*$/, `/${name}`); await ensureDatabase(url);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hullets-")); const transport = new SimulatorTransport();
  const cloud = transportKind === "cloud-api" ? { WHATSAPP_PROVIDER: "cloud-api", META_PHONE_NUMBER_ID: "1000000000", META_ACCESS_TOKEN: "test-access-token", META_APP_SECRET: "test-app-secret", META_VERIFY_TOKEN: "test-verify-token" } : { WHATSAPP_PROVIDER: "simulator" };
  const cfg = loadConfig({ ENVIRONMENT: "test", ...(fiscal ? { FISCAL_PROVIDER: "simulator" } : {}), DATABASE_URL: url, MEDIA_ROOT: path.join(dir, "media"), PORT: "0", BOOTSTRAP_ADMIN_EMAIL: "admin@example.test", BOOTSTRAP_ADMIN_PASSWORD: "TestAdminPassword2026", DATA_KEY: "test-data-key-0123456789-abcdef", AUDIT_SIGNING_KEY: "test-audit-key", EXTRACTOR: extractor, ...cloud, ...env });
  const simExtractor = new SimulatorExtractor();
  const fdms = new SimulatorFdmsAdapter();
  const app = await createApp({ config: cfg, log: silentLogger(), transport: transportKind === "cloud-api" ? undefined : transport, extractor: extractor === "tesseract" ? realExtractor() : simExtractor, fdmsAdapter: fiscal ? fdms : undefined });
  if (fiscal) (app.fiscal as unknown as { opts: { decoder?: typeof markerDecoder } }).opts.decoder = markerDecoder;
  if (seed) { await ensureSampleCampaign(app); await ensureSampleStaff(app); }
  const campaign = seed ? (await app.campaigns.byCode(SAMPLE_CODE))! : null;
  let n = 0;
  const h = {
    app, db: app.db, campaign: campaign!, transport, dir, simExtractor, dbUrl: url,
    /** Close a period for draw tests: moves its end to a second ago (submissions already inside keep their period code). */
    async closePeriod(code: string) { const p = (await app.campaigns.periods(campaign!.id)).find((x) => x.code === code)!; await new Promise((r) => setTimeout(r, 5)); await app.db.update(schema.campaignPeriods).set({ endsAt: new Date().toISOString() }).where(eq(schema.campaignPeriods.id, p.id)); return p; },
    /** Inbound message through the durable queue; drains the worker unless told not to. */
    async say(phone: string, text: string, { image = null as Buffer | null, providerMessageId = null as string | null, drain = true, kind = undefined as "unsupported" | undefined } = {}) {
      const id = providerMessageId ?? `t_${++n}_${Date.now()}`;
      const r = await app.queue.receive({ provider: "simulator", providerMessageId: id, kind: image ? "message.image" : kind === "unsupported" ? "message.unsupported" : "message.text", channelUid: phone, text, inlineMediaB64: image ? image.toString("base64") : null, timestamp: new Date().toISOString() });
      if (drain) await app.worker.drain();
      const replies = r.id ? (await app.outbox.byKeyPrefix(`reply:${r.id}:`)).map((m) => (m.payload as { body: string }).body) : [];
      const ev = r.id ? await app.queue.event(r.id) : null;
      return { ...r, replies, result: (ev?.result ?? null) as { state?: string; submissionId?: string | null } | null, eventStatus: ev?.status ?? null };
    },
    async register(phone: string, { first = "Tendai", last = "Ncube", identity = "TEST1234X", town = "Harare" } = {}) { await h.say(phone, "hi"); await h.say(phone, "1"); await h.say(phone, first); await h.say(phone, last); await h.say(phone, identity); await h.say(phone, town); await h.say(phone, "yes"); return h.say(phone, "yes"); },
    /** Start an entry. The flow is capture-first: this only opens the camera prompt. */
    async startEntry(phone: string) { return h.say(phone, "1"); },
    /** Push a waiting submission to a reviewer, as the stalled-question sweep would. */
    async escalate(submissionId: string) { await app.pipeline.escalateStalledQuestions({ olderThanMs: -1, limit: 50 }); return app.pipeline.get(submissionId); },
    /** Answer an ASK_FIELD prompt for the shop by searching and picking the first hit. */
    async answerOutlet(phone: string, query = "mopani westgate harare") { await h.say(phone, query); return h.say(phone, "1"); },
    /**
     * Submit an image and wait for the decision.
     *
     * No outlet is chosen up front any more — the shop is established from the
     * fiscal record or the receipt header, and the participant is only asked
     * when neither could say. `answer` supplies what a test wants the
     * participant to reply if the system does ask.
     */
    async submit(phone: string, image: Buffer, { providerMessageId = null as string | null, answer = null as string | null, outlet = null as string | null } = {}) {
      // `outlet` is what the participant replies IF the system asks which shop
      // it was — it is no longer chosen up front. Where the receipt header or
      // the fiscal record establishes the outlet, it is never used.
      answer = answer ?? (outlet ? `${outlet}|1` : null);
      await h.startEntry(phone);
      const r = await h.say(phone, "", { image, providerMessageId }); await app.worker.drain();
      let submissionId = r.result?.submissionId ?? null;
      let submission = submissionId ? await app.pipeline.get(submissionId) : null;
      if (submission?.status === "awaiting_participant" && answer) {
        for (const part of answer.split("|")) await h.say(phone, part);
        await app.worker.drain();
        submission = submissionId ? await app.pipeline.get(submissionId) : null;
      }
      const outcomes = submissionId ? (await app.outbox.byKeyPrefix(`submission:${submissionId}:`)).map((m) => (m.payload as { body: string }).body) : [];
      const replies = submissionId ? (await app.outbox.forUid(app.participants.uid(phone) ?? phone)).map((m) => (m.payload as { body?: string }).body ?? "") : [];
      return { submissionId, submission, ack: r.replies, outcomes, replies };
    },
    /** Register a fiscal transaction with the simulated authority, keyed by the QR a test will send. */
    fiscalSim: fdms,
    /** A receipt image whose embedded text the simulator reads, carrying a ZIMRA-style QR value. */
    async fiscalImage(text: string, qrValue: string) { const img = await h.simImage(text); return Buffer.concat([img, Buffer.from(`\n<<QR:${qrValue}>>`)]); },
    /** Receipt text for the SIMULATED extractor. */
    simReceipt({ no = "004512", date = null as string | null, packs = 2, product = "SWEETVALE BROWN SUGAR 2KG", merchant = "Mopani Mart\nWestgate Branch, Harare", extra = "" } = {}) { const d = date ?? new Date().toISOString().slice(0, 10).split("-").reverse().join("/"); return `${merchant}\nTel 0242 000000\nReceipt No: ${no}  Till 03\nDate: ${d} 14:22\n${product}\n${packs} x 3.10  ${(packs * 3.1).toFixed(2)}\n${extra}TOTAL ${(packs * 3.1).toFixed(2)}\nCASH 10.00\nThank you`; },
    /** Wrap text as a (noise) image so the media store accepts it; two different texts give different bytes. */
    async simImage(text: string) { const w = 160, h2 = 140, raw = Buffer.alloc(w * h2 * 3); let x = 7; for (const c of text) x = (x * 31 + c.charCodeAt(0)) >>> 0; for (let i = 0; i < raw.length; i++) { x = (x * 1103515245 + 12345) >>> 0; raw[i] = (x >>> 16) & 0xff; } const png = await sharp(raw, { raw: { width: w, height: h2, channels: 3 } }).png().toBuffer(); return Buffer.concat([png, embedReceiptText(text)]); },
    fixture,
    async staffToken(email: string, password = "StaffTestPassword2026") { await app.auth._setPasswordForTests(email, password); const r = await app.auth.login({ email, password }); if (!r || "pendingMfa" in r) throw new Error("login failed"); return r.token; },
    async staffId(email: string) { return (await app.auth.byEmail(email))!.id; },
    async close() { await app.close(); await dropDatabase(url); fs.rmSync(dir, { recursive: true, force: true }); },
  };
  return h;
}
export type Harness = Awaited<ReturnType<typeof buildApp>>;
export { SAMPLE_CODE };
