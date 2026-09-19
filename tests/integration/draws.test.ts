// Draw lifecycle against real PostgreSQL: barrier, freeze snapshot + seed commitment, deterministic
// execution, segregation of duties, tamper detection, independent verifier, winners lifecycle,
// alternates, void + re-run, prior-winner exclusion, claim expiry. Covers T-19..T-25, T-32, T-33.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { schema } from "@promo/db";
import { computeOutput, hashOf, seedCommitment, type Candidate, type Plan } from "@promo/core";
import { buildApp, type Harness } from "../helpers.ts";
import { verifyBundle } from "../../tools/verify-draw.ts";

const phones = Array.from({ length: 8 }, (_, i) => `2637720000${String(i + 1).padStart(2, "0")}`);
describe("draws and winners", () => {
  let h: Harness, officer: string, approver: string, ops: string, reviewer: string, manager: string, periodId: string, drawId: string;
  beforeAll(async () => {
    h = await buildApp({ extractor: "simulator" });
    officer = await h.staffId("draw@example.test"); approver = await h.staffId("approver@example.test"); ops = await h.staffId("fulfilment@example.test"); reviewer = await h.staffId("reviewer@example.test"); manager = await h.staffId("manager@example.test");
    for (const [i, p] of phones.entries()) { await h.register(p, { first: `Drawer${"ABCDEFGH"[i]}`, last: "Tester", identity: `TESTDRW${i}X` }); const r = await h.submit(p, await h.simImage(h.simReceipt({ no: `D${1000 + i}` }))); expect(r.submission?.status).toBe("qualified"); }
    for (const p of phones.slice(0, 2)) { const r = await h.submit(p, await h.simImage(h.simReceipt({ no: `D2${p.slice(-2)}` }))); expect(r.submission?.status).toBe("qualified"); }
  });
  afterAll(async () => { await h.close(); });

  it("T-19: the barrier blocks an open period, unresolved submissions and a missing candidate pool; the override needs a reason", async () => {
    const w0 = (await h.app.campaigns.periods(h.campaign.id)).find((p) => p.code === "W0")!; periodId = w0.id;
    let b = await h.app.draws.barrier(h.campaign.id, periodId); expect(b.blockers.map((x) => x.code)).toContain("PERIOD_OPEN");
    await expect(h.app.draws.freeze({ campaignId: h.campaign.id, periodId, actorId: officer })).rejects.toMatchObject({ code: "BLOCKED" });
    // A receipt whose number could not be read now waits on the participant
    // rather than a reviewer — and still blocks the draw, because it is
    // unresolved either way.
    const rev = await h.submit(phones[3], await h.simImage(h.simReceipt({ no: "" }))); expect(rev.submission?.status).toBe("awaiting_participant");
    await h.closePeriod("W0");
    b = await h.app.draws.barrier(h.campaign.id, periodId); expect(b.blockers.map((x) => x.code)).toEqual(["UNRESOLVED_SUBMISSIONS"]); expect(b.eligible.length).toBe(10); expect(b.distinctParticipants).toBe(8);
    await expect(h.app.draws.freeze({ campaignId: h.campaign.id, periodId, actorId: officer, override: { allow: ["UNRESOLVED_SUBMISSIONS"], reason: "" } })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(h.app.draws.freeze({ campaignId: h.campaign.id, periodId, actorId: officer, override: { allow: ["PERIOD_OPEN", "NO_CANDIDATES"], reason: "x" } })).rejects.toMatchObject({ code: "BLOCKED" });
    await h.app.pipeline.review(rev.submissionId!, { reviewerId: reviewer, decision: "not_qualified", reasonCode: "reviewer_decision", note: "unreadable number" });
    expect((await h.app.draws.barrier(h.campaign.id, periodId)).ok).toBe(true);
    await h.app.campaigns.setControls(h.campaign.id, { pauseDraws: true }, manager);
    await expect(h.app.draws.freeze({ campaignId: h.campaign.id, periodId, actorId: officer })).rejects.toMatchObject({ code: "CONFLICT" });
    await h.app.campaigns.setControls(h.campaign.id, { pauseDraws: false }, manager);
  });
  it("T-20: freeze writes an immutable snapshot with a seed commitment; a second freeze is blocked; the bundle of a frozen draw carries no randomness", async () => {
    const d = await h.app.draws.freeze({ campaignId: h.campaign.id, periodId, actorId: officer }); drawId = d.id;
    expect(d.status).toBe("frozen"); expect(d.seedCommitment).toBe(seedCommitment(d.seedHex)); expect(hashOf(d.snapshot)).toBe(d.snapshotHash);
    expect((d.snapshot as { candidates: Candidate[] }).candidates.length).toBe(10); expect((await h.app.draws.candidateCount(drawId))).toBe(10);
    await expect(h.app.draws.freeze({ campaignId: h.campaign.id, periodId, actorId: officer })).rejects.toMatchObject({ code: "BLOCKED" });
    const frozenBundle = JSON.stringify(await h.app.draws.bundle(drawId, officer)); expect(frozenBundle).not.toContain(d.seedHex); expect(frozenBundle).toContain(d.seedCommitment);
    await expect(h.app.draws.approve(drawId, approver, {})).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await h.app.campaigns.periods(h.campaign.id)).find((p) => p.id === periodId)!.status).toBe("closed");
  });
  it("T-21/T-22: execution is deterministic from the committed seed, idempotent on retry, one prize per participant, and SoD is enforced at approval", async () => {
    const e1 = await h.app.draws.execute(drawId, officer); expect(e1.status).toBe("executed");
    const out = e1.output as { winners: Array<{ participantId: string; prizeCode: string; entryId: string }>; alternates: Array<{ participantId: string }> };
    expect(out.winners.length).toBe(5); expect(new Set(out.winners.map((w) => w.participantId)).size).toBe(5); expect(out.alternates.length).toBe(3); // 8 participants, one prize each: 5 winners + 3 alternates
    expect(out.winners.filter((w) => w.prizeCode === "P1").length).toBe(2); expect(out.winners.filter((w) => w.prizeCode === "P2").length).toBe(3);
    expect(hashOf(computeOutput(e1.snapshot as { candidates: Candidate[]; plan: Plan }, e1.seedHex))).toBe(e1.outputHash);
    const e2 = await h.app.draws.execute(drawId, officer); expect(e2.outputHash).toBe(e1.outputHash); expect((await h.app.draws.attempts(drawId)).length).toBe(1);
    await expect(h.app.draws.approve(drawId, officer, {})).rejects.toMatchObject({ code: "SOD" });
    await expect(h.app.draws.approve(drawId, approver, { expectedOutputHash: "deadbeef" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await h.app.draws.verifyStored(e1)).ok).toBe(true);
  });
  it("T-23: tampering with stored evidence is detected before approval and by the independent verifier", async () => {
    const d = (await h.app.draws.get(drawId))!; const snap = d.snapshot as { candidates: Candidate[] };
    const tampered = { ...snap, candidates: [...snap.candidates.slice(1), snap.candidates[0]] };
    await h.db.update(schema.draws).set({ snapshot: tampered }).where(eq(schema.draws.id, drawId));
    await expect(h.app.draws.approve(drawId, approver, {})).rejects.toMatchObject({ code: "INTEGRITY" });
    await h.db.update(schema.draws).set({ snapshot: snap }).where(eq(schema.draws.id, drawId));
    const a = await h.app.draws.approve(drawId, approver, { expectedOutputHash: d.outputHash, note: "checked" }); expect(a.status).toBe("approved");
    expect((await h.app.draws.approve(drawId, approver, {})).status).toBe("approved"); // idempotent replay
    const bundle = await h.app.draws.bundle(drawId, approver) as Record<string, unknown>;
    const v = verifyBundle(bundle, "test-audit-key"); expect(v.verified).toBe(true); expect(v.checks.every((c) => c.pass)).toBe(true);
    expect(verifyBundle(bundle, "wrong-key").verified).toBe(false);
    const forged = JSON.parse(JSON.stringify(bundle)) as { output: { winners: Array<{ entryId: string }> } }; forged.output.winners.reverse();
    expect(verifyBundle(forged as unknown as Record<string, unknown>, "test-audit-key").verified).toBe(false);
    expect((await h.app.audit.list({ action: "draw.bundle_exported", targetId: drawId })).length).toBeGreaterThanOrEqual(2);
  });
  it("T-24/T-33: winners are materialised once, notified with a claim reference after approval, verified, accepted with collection instructions, collected; stale versions and illegal transitions are refused", async () => {
    await expect(h.app.winners.materialise(drawId, ops)).resolves.toMatchObject({ created: 5 }); expect((await h.app.winners.materialise(drawId, ops)).idempotent).toBe(true);
    const ws = (await h.app.winners.list({ drawId })).map((r) => r.w); expect(ws.length).toBe(5); expect((await h.app.winners.list({ drawId, kind: "alternate" })).length).toBe(3);
    expect(await h.app.winners.listPublic(h.campaign.id)).toEqual([]);
    const w = ws[0]; const n = await h.app.winners.notify(w.id, ops); expect(n.claimRef).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const contact = await h.app.outbox.byKeyPrefix(`winner:${w.id}:contact`); expect(contact.length).toBe(1); expect((contact[0].payload as { body: string }).body).toContain(n.claimRef);
    let cur = (await h.app.winners.get(w.id))!; expect(cur.status).toBe("notified"); expect(h.app.winners.verifyClaimToken(cur, n.claimRef)).toBe(true); expect(h.app.winners.verifyClaimToken(cur, "0000-0000-0000")).toBe(false);
    await expect(h.app.winners.transition(w.id, { status: "collected", actorId: ops })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(h.app.winners.transition(w.id, { status: "verified", actorId: ops, expectedVersion: cur.version - 1 })).rejects.toMatchObject({ code: "CONFLICT" });
    await h.app.winners.transition(w.id, { status: "verified", actorId: ops, evidence: "ID checked at collection point", expectedVersion: cur.version });
    expect((await h.app.participants.get(w.participantId))!.identityVerifiedAt).toBeTruthy();
    const outlet = (await h.app.campaigns.campaignOutlets(h.campaign.id)).find((o) => o.membership.collectionPoint)!;
    await h.app.winners.transition(w.id, { status: "accepted", actorId: ops, collectionOutletId: outlet.id });
    const collect = await h.app.outbox.byKeyPrefix(`winner:${w.id}:collect`); expect(collect.length).toBe(1); expect((collect[0].payload as { body: string }).body).toContain(outlet.branch);
    await expect(h.app.winners.transition(w.id, { status: "collected", actorId: ops })).rejects.toMatchObject({ code: "VALIDATION" });
    await h.app.winners.transition(w.id, { status: "collected", actorId: ops, fulfilmentRef: "SLIP-0001" });
    cur = (await h.app.winners.get(w.id))!; expect(cur.status).toBe("collected"); expect(cur.fulfilledBy).toBe(ops);
    expect((await h.app.winners.events(w.id)).map((e) => e.toStatus)).toEqual(["selected", "notified", "verified", "accepted", "collected"]);
  });
  it("T-24: replacing a winner promotes the first unused alternate; publication is a separate, revocable axis and shows only masked names", async () => {
    const ws = (await h.app.winners.list({ drawId })).map((r) => r.w).sort((a, b) => a.position - b.position); const w2 = ws[1];
    await h.app.winners.notify(w2.id, ops); const r = await h.app.winners.transition(w2.id, { status: "replaced", actorId: ops, reason: "no response after two attempts" }) as { replacement?: { id: string } | null };
    expect(r.replacement?.id).toBeTruthy(); const promoted = (await h.app.winners.get(r.replacement!.id))!; expect(promoted.kind).toBe("winner"); expect(promoted.prizeCode).toBe(w2.prizeCode); expect(promoted.status).toBe("selected");
    expect((await h.app.winners.list({ drawId })).filter((r) => r.w.status !== "replaced").length).toBe(5); expect((await h.app.winners.list({ drawId, kind: "alternate" })).length).toBe(2);
    await h.app.draws.publish(drawId, ops);
    await h.app.winners.notify(promoted.id, ops); await h.app.winners.transition(promoted.id, { status: "verified", actorId: ops, evidence: "ID" });
    await h.app.winners.publish(promoted.id, ops); const pub = await h.app.winners.listPublic(h.campaign.id); expect(pub.length).toBe(1);
    expect(JSON.stringify(pub)).not.toMatch(/2637720000/); expect(JSON.stringify(pub)).not.toContain("Tester"); expect(pub[0]).toMatchObject({ prize: expect.any(String) });
    await h.app.winners.unpublish(promoted.id, ops, "name spelled wrong"); expect((await h.app.winners.listPublic(h.campaign.id)).length).toBe(0);
    expect((await h.say(phones[0], "7")).replies[0]).toMatch(/No winners have been published/);
  });
  it("T-25: expiry of an unclaimed prize is driven by the claim deadline; prior winners are excluded from the next draw when the rule says so", async () => {
    const ws = (await h.app.winners.list({ drawId })).map((r) => r.w); const w3 = ws.find((w) => w.status === "selected")!;
    await h.app.winners.notify(w3.id, ops); await h.db.update(schema.winners).set({ claimExpiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(schema.winners.id, w3.id));
    await h.app.winners.expireDue(); expect((await h.app.winners.get(w3.id))!.status).toBe("expired");
    const active = await h.app.campaigns.activeVersion(h.campaign.id); expect(h.app.campaigns.rulesOf(active).eligibility.priorWinnerExclusion).toBe("none"); // sample default: D-13 open
    const vid = await h.app.campaigns.createVersion(h.campaign.id, { fromActive: true, rules: { eligibility: { ...h.app.campaigns.rulesOf(active).eligibility, priorWinnerExclusion: "campaign" } } }, manager); await h.app.campaigns.activateVersion(h.campaign.id, vid, manager);
    expect(h.app.campaigns.rulesOf(await h.app.campaigns.activeVersion(h.campaign.id)).eligibility.priorWinnerExclusion).toBe("campaign");
    // next period: W+1 opens where W0 closed, everyone enters again, then it closes
    const w0 = (await h.app.campaigns.periods(h.campaign.id)).find((p) => p.code === "W0")!; const w1 = (await h.app.campaigns.periods(h.campaign.id)).find((p) => p.code === "W+1")!;
    await h.db.update(schema.campaignPeriods).set({ startsAt: w0.endsAt, endsAt: new Date(Date.now() + 3_600_000).toISOString(), status: "open" }).where(eq(schema.campaignPeriods.id, w1.id));
    for (const [i, p] of phones.entries()) expect((await h.submit(p, await h.simImage(h.simReceipt({ no: `E${3000 + i}` })))).submission?.status).toBe("qualified");
    await h.closePeriod("W+1");
    const b = await h.app.draws.barrier(h.campaign.id, w1.id);
    const currentWinners = new Set((await h.app.winners.list({ campaignId: h.campaign.id })).filter((r) => !["replaced", "expired", "ineligible", "declined"].includes(r.w.status)).map((r) => r.w.participantId));
    expect(b.exclusions.length).toBe(currentWinners.size); expect(b.exclusions.every((x) => x.reason === "prior_winner" && currentWinners.has(x.participantId))).toBe(true);
    expect(b.eligible.some((c) => currentWinners.has(c.participantId))).toBe(false);
    expect(b.blockers.map((x) => x.code)).toContain("INSUFFICIENT_CANDIDATES"); // 8 - 4 current winners < 5 required
  });
  it("T-25: voiding a published draw needs a second approver, keeps the evidence, replaces uncollected winners and freezes a linked re-run", async () => {
    await expect(h.app.draws.voidAndRerun(drawId, officer, "candidate list disputed", officer)).rejects.toMatchObject({ code: "SOD" });
    await expect(h.app.draws.voidAndRerun(drawId, officer, "", approver)).rejects.toMatchObject({ code: "VALIDATION" });
    const rerun = await h.app.draws.voidAndRerun(drawId, officer, "candidate list disputed", approver);
    expect(rerun.status).toBe("frozen"); expect(rerun.supersedesId).toBe(drawId); expect(rerun.sequenceNo).toBe(2);
    const old = (await h.app.draws.get(drawId))!; expect(old.status).toBe("voided"); expect(old.output).toBeTruthy(); expect(old.voidApprovedBy).toBe(approver);
    const oldWinners = await h.db.select().from(schema.winners).where(eq(schema.winners.drawId, drawId));
    expect(oldWinners.filter((w) => w.status === "collected").length).toBe(1); expect(oldWinners.filter((w) => w.status !== "collected").every((w) => w.status === "replaced")).toBe(true);
    expect(oldWinners.every((w) => w.publication !== "published")).toBe(true);
    const e = await h.app.draws.execute(rerun.id, officer); expect(e.outputHash).not.toBe(old.outputHash);
    await h.app.draws.approve(rerun.id, approver, { expectedOutputHash: e.outputHash }); await h.app.draws.publish(rerun.id, ops);
    expect((await h.app.draws.list(h.campaign.id)).map((r) => r.d.status).sort()).toEqual(["published", "voided"]);
    expect((await h.app.audit.verify()).ok).toBe(true);
    const chain = await h.app.audit.list({ targetId: rerun.id }); expect(chain.map((a) => a.action)).toEqual(expect.arrayContaining(["draw.frozen", "draw.rerun", "draw.executed", "draw.approved", "draw.published"]));
  });
  it("entries in a frozen draw need an independent approver to disqualify; reinstatement restores eligibility", async () => {
    const rerun = (await h.app.draws.list(h.campaign.id)).find((r) => r.d.status === "published")!.d; const cand = (rerun.snapshot as { candidates: Candidate[] }).candidates[0];
    await expect(h.app.pipeline.disqualifyEntry(cand.entryId, { actorId: reviewer, reason: "fraud" })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    await expect(h.app.pipeline.disqualifyEntry(cand.entryId, { actorId: reviewer, reason: "fraud", approvedBy: reviewer })).rejects.toMatchObject({ code: "SOD" });
    const r = await h.app.pipeline.disqualifyEntry(cand.entryId, { actorId: reviewer, reason: "fraud", approvedBy: manager }); expect(r.affectedDraws.map((d) => d.id)).toContain(rerun.id);
    expect((await h.db.select().from(schema.entries).where(eq(schema.entries.id, cand.entryId)))[0].status).toBe("excluded");
    await h.app.pipeline.reinstateEntry(cand.entryId, { actorId: manager, reason: "appeal upheld" });
    expect((await h.db.select().from(schema.entryEvents).where(and(eq(schema.entryEvents.entryId, cand.entryId)))).map((e) => e.type)).toEqual(["disqualified", "reinstated"]);
  });
});
