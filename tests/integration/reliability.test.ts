// Failure injection: worker crash / lease expiry (T-13), extractor outage -> delayed (T-11),
// outbound send failures, unknown outcomes and delivery callbacks (T-28), forged Cloud API
// webhooks over HTTP (T-28/T-29), CRM contract delivery, read-back, faults and reconciliation (T-26/T-27).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@promo/db";
import { ExtractorUnavailable } from "@promo/core";
import { buildApp, type Harness } from "../helpers.ts";
import { httpHarness } from "../http.ts";
import { createReceiver } from "../../tools/crm-receiver.ts";
import type { AddressInfo } from "node:net";

describe("queue, outbox and extractor resilience (simulator transport)", () => {
  let h: Harness; const P = "263773000001";
  beforeAll(async () => { h = await buildApp({ extractor: "simulator" }); await h.register(P, { first: "Rel", last: "One", identity: "TESTREL1X" }); });
  afterAll(async () => { await h.close(); });
  it("T-13: an event whose worker died mid-flight is re-leased after expiry and processed exactly once", async () => {
    const r = await h.say(P, "hi", { drain: false }); expect(r.accepted).toBe(true);
    const leased = await h.app.queue.leaseEvent(1); expect(leased?.id).toBe(r.id); // a worker takes it and crashes
    expect(await h.app.worker.processEvent()).toBe(false); // nobody else can take it while the lease holds
    await new Promise((res) => setTimeout(res, 1200));
    expect(await h.app.worker.processEvent()).toBe(true); expect(await h.app.worker.processEvent()).toBe(false);
    const ev = (await h.app.queue.event(r.id!))!; expect(ev.status).toBe("processed"); expect(ev.attempts).toBe(2);
    expect((await h.app.outbox.byKeyPrefix(`reply:${r.id}:`)).length).toBe(1);
  });
  it("T-13: a job that keeps failing dead-letters with an alert and can be replayed by an operator", async () => {
    const stats0 = await h.app.queue.stats();
    await h.app.queue.enqueueJob(h.db, "does.not.exist", {}, { maxAttempts: 2 }); await h.app.worker.drain();
    const dead = await h.app.queue.deadLetters(); const j = dead.jobs.find((x) => x.kind === "does.not.exist")!; expect(j.status).toBe("dead");
    expect((await h.app.signals.open()).some((a) => a.kind === "jobs.dead_letter")).toBe(true);
    expect(await h.app.queue.retryJob(j.id)).toBe(true); await h.app.worker.drain(); expect((await h.app.queue.deadLetters()).jobs.find((x) => x.id === j.id)?.status).toBe("dead");
    expect((await h.app.queue.stats()).jobs.dead).toBeGreaterThanOrEqual((stats0.jobs.dead ?? 0) + 1);
  });
  it("T-11: an extractor outage leaves the submission delayed with a participant notice and a scheduled retry; the retry credits normally and never twice", async () => {
    h.simExtractor.failNext = new ExtractorUnavailable("provider 503");
    const r = await h.submit(P, await h.simImage(h.simReceipt({ no: "REL-1" }))); expect(r.submission?.status).toBe("delayed"); expect(r.submission?.reasonCode).toBe("EXTRACTOR_UNAVAILABLE");
    expect((await h.app.outbox.byKeyPrefix(`submission:${r.submissionId}:outcome`)).length).toBe(0); const delayed = await h.app.outbox.byKeyPrefix(`submission:${r.submissionId}:delayed`); expect(delayed.length).toBe(1); expect((delayed[0].payload as { body: string }).body).toMatch(/taking longer/i);
    const pending = await h.db.select().from(schema.jobs).where(eq(schema.jobs.status, "pending")); expect(pending.some((j) => j.kind === "submission.process" && (j.payload as { submissionId: string }).submissionId === r.submissionId)).toBe(true);
    await h.app.pipeline.process(r.submissionId!); await h.app.pipeline.process(r.submissionId!);
    const s = (await h.app.pipeline.get(r.submissionId!))!; expect(s.status).toBe("qualified");
    expect((await h.db.select().from(schema.entries).where(eq(schema.entries.submissionId, r.submissionId!))).length).toBe(1);
    expect((await h.db.select().from(schema.extractions).where(eq(schema.extractions.submissionId, r.submissionId!))).length).toBe(2);
  });
  it("T-28: transient send failures back off and retry; a permanent failure and an unknown outcome are surfaced as alerts; delivery callbacks never regress state", async () => {
    await h.app.worker.drain(); // nothing older waits in the outbox
    const enqueue = async (key: string) => { await h.app.outbox.enqueue(h.db, { channelUid: P, purpose: "reply", campaignId: h.campaign.id, payload: "test message", idempotencyKey: key }); return (await h.app.outbox.byKeyPrefix(key))[0]; };
    const a = await enqueue("rel:transient"); h.transport.failNext = { message: "rate limited", code: "429" }; await h.app.worker.dispatchOutbound();
    let row = (await h.app.outbox.get(a.id))!; expect(row.status).toBe("retryable_failure"); expect(row.nextAttemptAt).toBeTruthy(); expect(Date.parse(row.nextAttemptAt!)).toBeGreaterThan(Date.now());
    await h.app.worker.drain(); expect((await h.app.outbox.get(a.id))!.status).toBe("retryable_failure"); // not before its backoff
    expect(await h.app.outbox.retry(a.id)).toBe(true); await h.app.worker.drain(); row = (await h.app.outbox.get(a.id))!; expect(row.status).toBe("sent"); expect(row.providerMessageId).toBeTruthy();
    const b = await enqueue("rel:permanent"); h.transport.failNext = { message: "recipient opted out", code: "131050", permanent: true }; await h.app.worker.dispatchOutbound(); expect((await h.app.outbox.get(b.id))!.status).toBe("permanent_failure");
    const c = await enqueue("rel:unknown"); h.transport.failNext = { message: "socket hang up", unknownOutcome: true }; await h.app.worker.dispatchOutbound(); expect((await h.app.outbox.get(c.id))!.status).toBe("unknown_outcome");
    const kinds = (await h.app.signals.open()).map((x) => x.kind); expect(kinds).toContain("outbound.failure");
    await h.app.worker.drain(); expect((await h.app.outbox.get(c.id))!.status).toBe("unknown_outcome"); // never auto-resent: an operator decides
    const pm = row.providerMessageId!;
    await h.app.queue.receive({ provider: "simulator", providerMessageId: pm, kind: "delivery.status", status: "read", channelUid: P, timestamp: new Date().toISOString() });
    await h.app.queue.receive({ provider: "simulator", providerMessageId: pm, kind: "delivery.status", status: "delivered", channelUid: P, timestamp: new Date().toISOString() });
    await h.app.worker.drain(); row = (await h.app.outbox.get(a.id))!; expect(row.status).toBe("read"); expect(row.deliveredAt).toBeTruthy(); expect(row.readAt).toBeTruthy();
    expect((await h.app.queue.receive({ provider: "simulator", providerMessageId: pm, kind: "delivery.status", status: "read", channelUid: P })).duplicate).toBe(true);
  });
  it("outbound pause and the non-production allowlist block dispatch with a retryable/blocked status", async () => {
    await h.app.campaigns.setControls(h.campaign.id, { pauseOutbound: true }, "stf_test");
    await h.app.outbox.enqueue(h.db, { channelUid: P, purpose: "reply", campaignId: h.campaign.id, payload: "paused?", idempotencyKey: "rel:paused" }); await h.app.worker.drain();
    const row = (await h.app.outbox.byKeyPrefix("rel:paused"))[0]; expect((await h.app.outbox.get(row.id))!.status).toBe("retryable_failure"); expect((await h.app.outbox.get(row.id))!.errorCode).toBe("OUTBOUND_PAUSED");
    await h.app.campaigns.setControls(h.campaign.id, { pauseOutbound: false }, "stf_test"); await h.app.outbox.retry(row.id); await h.app.worker.drain(); expect((await h.app.outbox.get(row.id))!.status).toBe("sent");
  });
});

describe("Cloud API webhook surface over HTTP (no network: nothing is sent)", () => {
  let h: Harness, http: Awaited<ReturnType<typeof httpHarness>>; const SECRET = "test-app-secret";
  const sign = (raw: string) => "sha256=" + crypto.createHmac("sha256", SECRET).update(raw).digest("hex");
  const payload = (id: string, from = "263774000001", text = "hi") => JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ value: { messaging_product: "whatsapp", metadata: { phone_number_id: "1000000000" }, messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }] }, field: "messages" }] }] });
  const post = (raw: string, headers: Record<string, string> = {}) => fetch(`${http.base}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw });
  beforeAll(async () => { h = await buildApp({ extractor: "simulator", transport: "cloud-api" }); http = await httpHarness(h); });
  afterAll(async () => { await http.close(); await h.close(); });
  it("T-29: the verify handshake needs the exact token; unsigned, forged and malformed posts are rejected before anything is persisted", async () => {
    expect((await fetch(`${http.base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123`)).status).toBe(403);
    const ok = await fetch(`${http.base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=123456`); expect(ok.status).toBe(200); expect(await ok.text()).toBe("123456");
    const raw = payload("wamid.forged");
    expect((await post(raw)).status).toBe(403);
    expect((await post(raw, { "x-hub-signature-256": "sha256=" + "0".repeat(64) })).status).toBe(403);
    expect((await post(raw, { "x-hub-signature-256": sign(raw + " ") })).status).toBe(403);
    expect((await post("{not json", { "x-hub-signature-256": sign("{not json") })).status).toBe(400);
    expect((await h.db.select().from(schema.inboundEvents)).length).toBe(0);
    expect((await h.app.signals.metricSeries("webhook.bad_signature", new Date(Date.now() - 60_000).toISOString())).length).toBe(3);
  });
  it("a correctly signed event is persisted then acknowledged; a replay is deduplicated; processing produces a reply that waits in the outbox", async () => {
    const raw = payload("wamid.real.1");
    const r1 = await post(raw, { "x-hub-signature-256": sign(raw) }); expect(r1.status).toBe(200); expect(await r1.json()).toMatchObject({ accepted: 1, deduped: 0 });
    const r2 = await post(raw, { "x-hub-signature-256": sign(raw) }); expect(await r2.json()).toMatchObject({ accepted: 0, deduped: 1 });
    expect(await h.app.worker.processEvent()).toBe(true);
    const [ev] = await h.db.select().from(schema.inboundEvents); expect(ev.status).toBe("processed"); expect(ev.channelUid).toBe("263774000001"); expect(ev.provider).toBe("whatsapp-cloud-api");
    const out = await h.app.outbox.byKeyPrefix(`reply:${ev.id}:`); expect(out.length).toBe(1); expect(out[0].status).toBe("pending"); expect((out[0].payload as { body: string }).body).toMatch(/1\. Register/);
    const status = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ value: { metadata: { phone_number_id: "1000000000" }, statuses: [{ id: "wamid.out.1", status: "delivered", timestamp: "1700000000", recipient_id: "263774000001" }] }, field: "messages" }] }] });
    expect((await post(status, { "x-hub-signature-256": sign(status) })).status).toBe(200);
    const evs = await h.db.select().from(schema.inboundEvents); expect(evs.find((e) => e.kind === "delivery.status:delivered")).toBeTruthy();
  });
  it("media is fetched only from Meta hosts", async () => {
    const t = h.app.transport as unknown as { o: { fetchImpl?: typeof fetch } };
    t.o.fetchImpl = (async (url: string | URL | Request) => { const u = String(url); if (/graph\.facebook\.com/.test(u)) return new Response(JSON.stringify({ url: "https://evil.example.test/x.jpg" }), { status: 200 }); return new Response("nope", { status: 200 }); }) as typeof fetch;
    await expect(h.app.transport.downloadMedia("m1")).rejects.toMatchObject({ permanent: true, message: /Meta host/ });
    t.o.fetchImpl = (async (url: string | URL | Request) => { const u = String(url); if (/graph\.facebook\.com/.test(u)) return new Response(JSON.stringify({ url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1" }), { status: 200 }); return new Response(Buffer.from("bytes"), { status: 200, headers: { "content-length": "5" } }); }) as typeof fetch;
    expect((await h.app.transport.downloadMedia("m1")).toString()).toBe("bytes");
  });
});

describe("CRM contract adapter against the local receiver (T-26/T-27)", () => {
  let h: Harness, recv: ReturnType<typeof createReceiver>; const P = "263775000001";
  beforeAll(async () => {
    recv = createReceiver(); await new Promise<void>((r) => recv.server.listen(0, "127.0.0.1", () => r())); const port = (recv.server.address() as AddressInfo).port;
    h = await buildApp({ extractor: "simulator", env: { CRM_PROVIDER: "http-contract", CRM_BASE_URL: `http://127.0.0.1:${port}`, CRM_TOKEN: "test-crm-token", CRM_TIMEOUT_MS: "1500" } });
  });
  afterAll(async () => { await h.close(); await new Promise<void>((r) => recv.server.close(() => r())); });
  it("registration and a qualified entry are delivered as canonical records, confirmed by read-back, and carry no identity number or full phone", async () => {
    await h.register(P, { first: "Crm", last: "One", identity: "TESTCRM1X" }); const r = await h.submit(P, await h.simImage(h.simReceipt({ no: "CRM-1" }))); expect(r.submission?.status).toBe("qualified");
    await h.app.worker.drain(); const sum = await h.app.crm.summary(); expect(sum.byStatus.delivered).toBeGreaterThanOrEqual(4); expect(sum.byStatus.pending ?? 0).toBe(0);
    const types = [...recv.records.keys()].map((k) => k.split(":")[0]); for (const t of ["participant", "enrollment", "submission", "entry"]) expect(types).toContain(t);
    const dump = JSON.stringify([...recv.records.values()]); expect(dump).not.toContain("TESTCRM1X"); expect(dump).not.toContain("263775000001"); expect(dump).toContain("***0001"); expect(dump).toContain("crm-map/1");
    const entry = [...recv.records.values()].find((x) => x.external_key && String(x.external_key).includes(":entry:"))!; expect(entry.status).toBe("active"); expect(entry.period).toBe("W0"); expect(entry.outlet_code).toBe("MOP-HRE-01");
    const refs = await h.db.select().from(schema.crmRefs); expect(refs.length).toBeGreaterThanOrEqual(4);
    expect((await h.app.crm.health()).ok).toBe(true);
  });
  it("T-27: a write whose acknowledgement is lost becomes unknown_outcome, then reconciliation confirms it from the vendor's record", async () => {
    recv.setFault("timeout-after-write");
    const p = (await h.app.participants.byUid(P))!; await h.app.participants.correct(p.id, { firstName: "Crmx" }, "stf_t", "typo");
    await h.app.worker.drain(); const ev = (await h.app.crm.list({ status: "unknown_outcome" }))[0]; expect(ev).toBeTruthy(); expect(ev.entityType).toBe("participant");
    recv.setFault("none"); const rec = await h.app.crm.reconcile(); expect(rec.reconciled).toBe(1);
    expect((await h.db.select().from(schema.crmEvents).where(eq(schema.crmEvents.id, ev.id)))[0].status).toBe("reconciled");
    expect(recv.records.get(`participant:${ev.externalKey}`)?.first_name).toBe("Crmx");
  });
  it("T-27: an outage is retryable with backoff and an operator retry; a stale version never overwrites a newer one", async () => {
    recv.setFault("down");
    const p = (await h.app.participants.byUid(P))!; await h.app.participants.correct(p.id, { firstName: "Crmy" }, "stf_t", "again"); await h.app.worker.drain();
    const ev = (await h.app.crm.list({ status: "retryable_failure" }))[0]; expect(ev).toBeTruthy(); expect(ev.nextAttemptAt).toBeTruthy();
    recv.setFault("none"); await h.app.worker.drain(); expect((await h.db.select().from(schema.crmEvents).where(eq(schema.crmEvents.id, ev.id)))[0].status).toBe("retryable_failure");
    expect(await h.app.crm.retry(ev.id)).toBe(true); await h.app.worker.drain(); expect((await h.db.select().from(schema.crmEvents).where(eq(schema.crmEvents.id, ev.id)))[0].status).toBe("delivered");
    const rec = (v: number, name: string) => h.app.crm.emit(h.app.db, { entityType: "participant", entityId: "ptc_stale_test", entityVersion: v, payload: { firstName: name, surname: "X", phone: "***0009", location: "Harare", status: "active" } });
    await rec(2, "Newer"); await h.app.worker.drain(); await rec(1, "Stale"); await h.app.worker.drain();
    const key = h.app.crm.key("participant", "ptc_stale_test"); expect(recv.records.get(`participant:${key}`)?.first_name).toBe("Newer"); expect((await h.app.crm.list({ status: "permanent_failure" })).some((e) => /superseded/.test(e.lastError ?? ""))).toBe(true);
    // and the vendor itself refuses an older version if one ever reaches it
    const r409 = await fetch(`http://127.0.0.1:${(recv.server.address() as AddressInfo).port}/records/participant/${encodeURIComponent(key)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ entity_version: 1, record: { first_name: "Stale" } }) }); expect(r409.status).toBe(409);
    expect((await h.app.signals.open()).some((a) => a.kind === "crm.delivery")).toBe(true);
  });
});
