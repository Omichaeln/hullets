// Authorisation, adversarial API use, privacy and audit through the real HTTP + tRPC surface (T-29, T-30, T-31, T-36, T-15).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@promo/db";
import { buildApp, type Harness } from "../helpers.ts";
import { httpHarness } from "../http.ts";
describe("security, RBAC, privacy, audit", () => {
  let h: Harness, http: Awaited<ReturnType<typeof httpHarness>>; const tok: Record<string, string> = {}; let sid: string;
  beforeAll(async () => {
    h = await buildApp({ extractor: "simulator" }); http = await httpHarness(h);
    tok.admin = await h.staffToken("admin@example.test"); for (const e of ["reviewer", "support", "draw", "approver", "fulfilment", "auditor", "manager"]) tok[e] = await h.staffToken(`${e}@example.test`);
    await h.register("263771000301", { first: "Sec", last: "One", identity: "TESTSEC1X" }); sid = (await h.submit("263771000301", await h.simImage(h.simReceipt({ no: "SEC-1" })))).submissionId!;
  });
  afterAll(async () => { await http.close(); await h.close(); });
  it("T-29: unauthenticated and under-privileged calls are denied server-side; the technical admin cannot run or approve draws", async () => {
    expect(await http.status(() => http.client(null).submissions.list.query({}))).toBe(401);
    expect(await http.status(() => http.client("0".repeat(64)).submissions.list.query({}))).toBe(401);
    expect(await http.status(() => http.client(tok.reviewer).staff.list.query())).toBe(403);
    expect(await http.status(() => http.client(tok.reviewer).reports.export.query({ scope: "participants" }))).toBe(403);
    const period = (await h.app.campaigns.periods(h.campaign.id))[0];
    expect(await http.status(() => http.client(tok.admin).draws.freeze.mutate({ campaignId: h.campaign.id, periodId: period.id }))).toBe(403);
    expect(await http.status(() => http.client(tok.reviewer).draws.freeze.mutate({ campaignId: h.campaign.id, periodId: period.id }))).toBe(403);
    // The platform team is read-wide and act-narrow: a reviewer may LOOK at winners
    // and the support queue, and may not touch either.
    expect(await http.status(() => http.client(tok.reviewer).winners.list.query({}))).toBe(200);
    expect(await http.status(() => http.client(tok.reviewer).winners.notify.mutate({ winnerId: "win_x" }))).toBe(403);
    expect(await http.status(() => http.client(tok.reviewer).support.claim.mutate({ phone: "263770000000" }))).toBe(403);
    expect(await http.status(() => http.client(tok.support).participants.revealIdentity.mutate({ participantId: "ptc_x", reason: "x" }))).toBe(403);
    expect(await http.status(() => http.client(tok.reviewer).submissions.get.query({ submissionId: "sub_doesnotexist" }))).toBe(404);
    expect(await http.status(() => http.client(tok.reviewer).support.queue.query())).toBe(200);
    // role change and disabling revoke sessions
    const u = (await h.app.auth.byEmail("support@example.test"))!;
    expect(await http.status(() => http.client(tok.support).auth.me.query())).toBe(200);
    await http.client(tok.admin).staff.update.mutate({ userId: u.id, status: "disabled" });
    expect(await http.status(() => http.client(tok.support).auth.me.query())).toBe(401);
    await http.client(tok.admin).staff.update.mutate({ userId: u.id, status: "active" }); tok.support = await h.staffToken("support@example.test");
  });
  it("T-30: receipt media needs the bearer header and the media permission; identities are masked everywhere; reveal is audited; exports are formula-safe", async () => {
    const detail = await http.client(tok.reviewer).submissions.get.query({ submissionId: sid }); expect(detail.media?.viewable).toBe(true);
    const url = `${http.base}/api/media/${sid}`;
    expect((await fetch(url, { headers: { authorization: `Bearer ${tok.reviewer}` } })).status).toBe(200);
    expect((await fetch(url, { headers: { authorization: `Bearer ${tok.support}` } })).status).toBe(403);
    expect((await fetch(url)).status).toBe(401); expect((await fetch(`${url}?token=${tok.reviewer}`)).status).toBe(401);
    const p = (await h.app.participants.byUid("263771000301"))!;
    const view = await http.client(tok.support).participants.get.query({ participantId: p.id }); expect(view.participant?.identityMask).toMatch(/\*/); expect(JSON.stringify(view)).not.toContain("TESTSEC1X"); expect(view.participant?.phone).toMatch(/^\*\*\*\d{4}$/);
    const rev = await http.client(tok.auditor).participants.revealIdentity.mutate({ participantId: p.id, reason: "winner verification" }); expect(rev.identity).toBe("TESTSEC1X");
    expect((await h.app.audit.list({ action: "participant.identity.reveal", targetId: p.id })).length).toBe(1);
    await h.app.participants.correct(p.id, { firstName: "=HYPERLINK(x)" }, "stf_t", "test");
    const csv = await (await fetch(`${http.base}/api/export/participants.csv`, { headers: { authorization: `Bearer ${tok.auditor}` } })).text(); expect(csv).toContain("'=HYPERLINK(x)"); expect(csv).not.toContain("TESTSEC1X"); expect(csv).not.toContain("263771000301");
    expect((await fetch(`${http.base}/api/export/participants.csv`, { headers: { authorization: `Bearer ${tok.reviewer}` } })).status).toBe(403);
    expect((await h.app.audit.list({ action: "report.export" })).length).toBeGreaterThanOrEqual(1);
  });
  it("audit chain verifies across all writers; checkpoints are signed", async () => { const v = await http.client(tok.auditor).audit.verify.query(); expect(v.ok).toBe(true); expect(v.total).toBeGreaterThan(20); const c = await http.client(tok.auditor).audit.checkpoint.mutate(); expect(c?.signed).toBe(true); expect(await h.app.audit.verifyCheckpoint(c!)).toEqual({ signatureOk: true, headMatches: true }); });
  it("T-15: concurrent reviewer decisions — a stale version conflicts, identity is required to credit, only one decision lands", async () => {
    const ph = "263771000302"; await h.register(ph, { first: "Rev", last: "Two", identity: "TESTREV2X" });
    const r = await h.submit(ph, await h.simImage(h.simReceipt({ no: "" }))); expect(r.submission?.status).toBe("review");
    const c = http.client(tok.reviewer); const before = await c.submissions.get.query({ submissionId: r.submissionId! }); const v = before.submission.version;
    await expect(c.submissions.review.mutate({ submissionId: r.submissionId!, decision: "qualified", expectedVersion: v })).rejects.toMatchObject({ data: { domainCode: "IDENTITY_INCOMPLETE" } });
    await c.submissions.correctFacts.mutate({ submissionId: r.submissionId!, receiptNo: "FIX-1", note: "number read from the photo" });
    const [a, b] = await Promise.allSettled([c.submissions.review.mutate({ submissionId: r.submissionId!, decision: "qualified", expectedVersion: v }), c.submissions.review.mutate({ submissionId: r.submissionId!, decision: "not_qualified", reasonCode: "reviewer_decision", expectedVersion: v })]);
    expect([a.status, b.status].filter((s) => s === "fulfilled").length).toBe(1);
    await h.app.worker.drain(); const msgs = await h.app.outbox.byKeyPrefix(`submission:${r.submissionId}:outcome`); expect(msgs.some((m) => /After review|after review/.test((m.payload as { body: string }).body))).toBe(true);
    expect((await h.db.select().from(schema.entries).where(eq(schema.entries.submissionId, r.submissionId!))).length).toBeLessThanOrEqual(1);
  });
  it("T-31: withdrawal and anonymisation remove personal data but keep ledger references", async () => {
    const p = (await h.app.participants.byUid("263771000302"))!;
    const w = await http.client(tok.support).participants.withdraw.mutate({ participantId: p.id, reason: "participant request" }); expect(w?.status).toBe("withdrawn");
    const an = await http.client(tok.admin).participants.anonymise.mutate({ participantId: p.id, reason: "deletion request" }); expect(an?.firstName).toBe("[deleted]");
    const row = (await h.app.participants.get(p.id))!; expect(row.identityEnc).toBeNull(); expect(row.identityFp).toBeNull(); expect(row.channelUid).toMatch(/^deleted:/);
    expect((await h.db.select().from(schema.submissions).where(eq(schema.submissions.participantId, p.id))).length).toBeGreaterThanOrEqual(1);
  });
  it("T-36: the production activation validator names every sample marker and open decision; only a production database can be blocked by it", async () => {
    const v = await http.client(tok.manager).campaigns.activation.query({ campaignId: h.campaign.id }); const codes = v.failures.map((f) => f.code);
    for (const c of ["DECISION_OPEN_D-01", "SAMPLE_CONFIGURATION", "TRANSPORT", "OUTLETS_SAMPLE", "STAFF_SAMPLE", "WINNER_TEMPLATE", "EVIDENCE_RECEIPT_BENCHMARK_ACCEPTED", "ENVIRONMENT"]) expect(codes).toContain(c);
    expect(v.ok).toBe(false); expect(v.blockingCount).toBe(1);
    await h.db.update(schema.schemaMeta).set({ value: "production" }).where(eq(schema.schemaMeta.key, "environment")); (h.app as { environment: string }).environment = "production";
    await http.client(tok.manager).campaigns.setStatus.mutate({ campaignId: h.campaign.id, status: "paused" });
    await expect(http.client(tok.manager).campaigns.setStatus.mutate({ campaignId: h.campaign.id, status: "active" })).rejects.toMatchObject({ data: { domainCode: "CONFLICT" } });
    await h.db.update(schema.schemaMeta).set({ value: "test" }).where(eq(schema.schemaMeta.key, "environment")); (h.app as { environment: string }).environment = "test";
    await http.client(tok.manager).campaigns.setStatus.mutate({ campaignId: h.campaign.id, status: "active" });
  });
  it("login rate limiting, temporary-password gate and MFA enrolment", async () => {
    for (let i = 0; i < 5; i++) await http.status(() => http.client(null).auth.login.mutate({ email: "nobody@example.test", password: "wrong-wrong-wrong" }));
    expect(await http.status(() => http.client(null).auth.login.mutate({ email: "nobody@example.test", password: "wrong-wrong-wrong" }))).toBe(429);
    const created = await http.client(tok.admin).staff.create.mutate({ email: "new.reviewer@example.test", name: "New Reviewer", roles: ["reviewer"] }); expect(created.temporaryPassword!.length).toBeGreaterThanOrEqual(14);
    const login = await http.client(null).auth.login.mutate({ email: "new.reviewer@example.test", password: created.temporaryPassword! }); if (login.pendingMfa) throw new Error("unexpected mfa"); const t = login.token;
    expect(await http.status(() => http.client(t).submissions.list.query({}))).toBe(403);
    await http.client(t).auth.changePassword.mutate({ currentPassword: created.temporaryPassword!, newPassword: "ANewStrongPassword2026" });
    const login2 = await http.client(null).auth.login.mutate({ email: "new.reviewer@example.test", password: "ANewStrongPassword2026" }); if (login2.pendingMfa) throw new Error("unexpected mfa"); expect(await http.status(() => http.client(login2.token).submissions.list.query({}))).toBe(200);
    const enrol = await http.client(login2.token).auth.mfaEnroll.mutate(); const { authenticator } = await import("otplib"); await http.client(login2.token).auth.mfaEnable.mutate({ code: authenticator.generate(enrol.secret!) });
    const l3 = await http.client(null).auth.login.mutate({ email: "new.reviewer@example.test", password: "ANewStrongPassword2026" }); expect(l3.pendingMfa).toBe(true);
    if (l3.pendingMfa) { await expect(http.client(null).auth.verifyMfa.mutate({ userId: l3.userId!, code: "000000" })).rejects.toBeTruthy(); const ok = await http.client(null).auth.verifyMfa.mutate({ userId: l3.userId!, code: authenticator.generate(enrol.secret!) }); expect(ok.token).toBeTruthy(); }
  });
});
