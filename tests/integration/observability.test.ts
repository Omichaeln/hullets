// T-37: operational visibility. Every handled failure lands in a redacted, fingerprinted error log
// (API internal errors, worker failures, forged webhooks, console crashes); the worker writes health
// samples that give uptime and throughput a history; access follows ops.read / ops.alerts.ack.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@promo/db";
import { buildApp, type Harness } from "../helpers.ts";
import { httpHarness } from "../http.ts";

describe("error log and health history", () => {
  let h: Harness; let http: Awaited<ReturnType<typeof httpHarness>>; let broken: Awaited<ReturnType<typeof httpHarness>>; const tok: Record<string, string> = {}; const P = "263773000501";
  beforeAll(async () => {
    h = await buildApp({ extractor: "simulator" });
    for (const e of ["admin", "reviewer", "support"]) tok[e] = await h.staffToken(`${e}@example.test`);
    http = await httpHarness(h);
    // The same application with one service failing, so an internal error can be provoked deterministically over HTTP.
    const campaigns = Object.create(h.app.campaigns) as typeof h.app.campaigns; (campaigns as { list: unknown }).list = async () => { throw new Error("connection reset by peer while syncing 263771234567 (token secret-abc) at /var/lib/app/core/x.ts"); };
    broken = await httpHarness({ ...h, app: { ...h.app, campaigns } } as Harness);
    await h.register(P, { first: "Obs", last: "One", identity: "TESTOBS1X" });
  });
  afterAll(async () => { await broken.close(); await http.close(); await h.close(); });

  it("T-37: an internal API error is opaque to the caller and recorded, redacted, with its correlation id and actor", async () => {
    type Caught = { message?: string; data?: { httpStatus?: number; stack?: string } };
    const caught = await broken.client(tok.admin).campaigns.list.query().then(() => null as Caught | null, (e: unknown) => e as Caught);
    expect(caught?.data?.httpStatus).toBe(500); expect(caught?.message).toBe("internal error"); expect(JSON.stringify(caught)).not.toMatch(/263771234567|secret-abc|stack/);
    const rows = await http.client(tok.admin).ops.errors.query({ source: "trpc" });
    const r = rows.find((x) => x.path === "campaigns.list")!; expect(r).toBeTruthy();
    expect(r.code).toBe("INTERNAL"); expect(r.message).toContain("***4567"); expect(r.message).toContain("token [redacted]"); expect(r.message).toContain("[path]"); expect(r.message).not.toContain("secret-abc");
    expect(r.correlationId).toMatch(/^req_/); expect(r.actorId).toBe(await h.staffId("admin@example.test")); expect(r.resolvedAt).toBeNull(); expect(JSON.stringify(r)).not.toMatch(/stack|\/var\/lib/);
  });
  it("T-37: a job that dead-letters is in the log with the job reference; the summary groups occurrences; resolving is audited", async () => {
    await h.app.queue.enqueueJob(h.db, "does.not.exist", { submissionId: "sub_test_ref" }, { maxAttempts: 2 }); await h.app.worker.drain();
    const rows = await h.app.observability.list({ since: new Date(Date.now() - 60_000).toISOString(), source: "worker.job" });
    const dead = rows.find((r) => r.code === "JOB_DEAD_LETTER")!; expect(dead).toBeTruthy(); expect(dead.path).toBe("does.not.exist"); expect(dead.ref?.jobId).toMatch(/^job_/); expect(dead.ref?.submissionId).toBe("sub_test_ref");
    const summary = await http.client(tok.admin).ops.errorSummary.query({ sinceHours: 1 }); const grp = summary.find((g) => g.fingerprint === dead.fingerprint)!;
    expect(grp.count).toBeGreaterThanOrEqual(1); expect(grp.open).toBe(grp.count); expect(grp.source).toBe("worker.job");
    const res = await http.client(tok.support).ops.resolveErrors.mutate({ fingerprint: dead.fingerprint, note: "unknown job kind removed from the scheduler" }); expect(res.closed).toBe(grp.open);
    expect((await http.client(tok.admin).ops.errorSummary.query({ sinceHours: 1, open: true })).some((g) => g.fingerprint === dead.fingerprint)).toBe(false);
    const audit = await h.app.audit.list({ action: "error.resolve", limit: 5 }); expect(audit.some((a) => a.targetId === dead.fingerprint && a.reason === "unknown job kind removed from the scheduler")).toBe(true);
    expect((await http.client(tok.admin).ops.resolveErrors.mutate({ fingerprint: dead.fingerprint, note: "again" })).closed).toBe(0);
  });
  it("T-37: housekeeping writes a health sample; history reports availability, throughput and the latest checks", async () => {
    await h.say(P, "hi"); await h.app.worker.housekeeping();
    const first = await http.client(tok.admin).ops.healthHistory.query({ sinceHours: 1 });
    expect(first.buckets.length).toBeGreaterThanOrEqual(1); expect(first.latest?.ok).toBe(true); expect(first.latest?.process).toContain(String(process.pid)); expect(first.availability.availabilityPct).toBe(100); expect(first.availability.gaps).toEqual([]);
    expect(first.buckets.reduce((n, b) => n + b.inbound, 0)).toBeGreaterThanOrEqual(1); expect(first.buckets.reduce((n, b) => n + b.errors, 0)).toBeGreaterThanOrEqual(1);
    expect(first.errors.total).toBeGreaterThanOrEqual(2); expect(first.intervalSec).toBe(60); expect(first.bucketSec).toBe(60);
    const checks = first.latest!.checks as Record<string, { ok?: boolean }>; expect(Object.keys(checks).sort()).toEqual(["extractor", "storage", "transport"]);
    const week = await http.client(tok.admin).ops.healthHistory.query({ sinceHours: 168 }); expect(week.bucketSec).toBe(3600); expect(week.buckets.length).toBe(1);
  });
  it("T-37: the console can report its own crashes; they are attributed to the signed-in user", async () => {
    expect((await http.client(tok.reviewer).ops.reportClientError.mutate({ kind: "render_error", message: "Cannot read properties of undefined (reading 'items') at SubmissionsPage", url: "/submissions?tab=queue" })).recorded).toBe(true);
    const [r] = await h.app.observability.list({ since: new Date(Date.now() - 60_000).toISOString(), source: "console" });
    expect(r.code).toBe("RENDER_ERROR"); expect(r.path).toBe("/submissions?tab=queue"); expect(r.actorId).toBe(await h.staffId("reviewer@example.test"));
  });
  it("T-37: reading the log needs ops.read and resolving needs ops.alerts.ack", async () => {
    expect(await http.status(() => http.client(tok.reviewer).ops.errors.query({}))).toBe(403);
    expect(await http.status(() => http.client(tok.reviewer).ops.healthHistory.query({}))).toBe(403);
    expect(await http.status(() => http.client(null).ops.errorSummary.query({}))).toBe(401);
    expect(await http.status(() => http.client(tok.support).ops.errors.query({}))).toBe(200);
    expect(await http.status(() => http.client(tok.admin).ops.resolveErrors.mutate({}))).toBe(409);
  });
  it("T-37: retention purges old samples and errors and keeps recent ones", async () => {
    await h.db.insert(schema.healthSamples).values({ at: new Date(Date.now() - 40 * 86_400_000).toISOString(), process: "old", ok: true, uptimeSec: 1 });
    await h.db.insert(schema.errorEvents).values({ id: "err_old", source: "http", code: "X", message: "old", fingerprint: "f", occurredAt: new Date(Date.now() - 100 * 86_400_000).toISOString() });
    await h.app.observability.purge();
    expect((await h.db.select().from(schema.healthSamples).where(eq(schema.healthSamples.process, "old"))).length).toBe(0); expect(await h.app.observability.get("err_old")).toBeNull();
    expect((await h.db.select().from(schema.healthSamples)).length).toBeGreaterThanOrEqual(1); expect((await h.app.observability.list({ since: new Date(Date.now() - 3_600_000).toISOString() })).length).toBeGreaterThanOrEqual(3);
  });
});

describe("forged webhooks are in the error log (Cloud API transport)", () => {
  let h: Harness; let http: Awaited<ReturnType<typeof httpHarness>>;
  beforeAll(async () => { h = await buildApp({ extractor: "simulator", transport: "cloud-api" }); http = await httpHarness(h); });
  afterAll(async () => { await http.close(); await h.close(); });
  it("T-37: a webhook with a bad signature is refused and recorded with the caller's address, never the payload", async () => {
    const r = await fetch(`${http.base}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=deadbeef" }, body: JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: "263771234567", id: "wamid.forged", type: "text", text: { body: "hello" } }] } }] }] }) });
    expect(r.status).toBe(403);
    const [e] = await h.app.observability.list({ since: new Date(Date.now() - 60_000).toISOString(), source: "webhook" });
    expect(e.code).toBe("BAD_SIGNATURE"); expect(e.detail?.ip).toBeTruthy(); expect(JSON.stringify(e)).not.toContain("263771234567"); expect(JSON.stringify(e)).not.toContain("hello");
  });
});
