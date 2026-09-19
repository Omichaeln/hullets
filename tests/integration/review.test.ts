// Review workspace and ledger operations with the SIMULATED extractor: reupload linkage (T-08),
// assignment / release / escalation and SLA, fact correction, duplicate resolution, ownership
// disputes across phones (T-07), safe reprocessing, caps (T-10), entry trace and reports.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@promo/db";
import { buildApp, type Harness } from "../helpers.ts";
const A = "263776000001", B = "263776000002";
describe("review and ledger operations", () => {
  let h: Harness, reviewer: string, manager: string;
  beforeAll(async () => { h = await buildApp({ extractor: "simulator" }); reviewer = await h.staffId("reviewer@example.test"); manager = await h.staffId("manager@example.test"); await h.register(A, { first: "Rev", last: "Alpha", identity: "TESTRVA1X" }); await h.register(B, { first: "Rev", last: "Beta", identity: "TESTRVB1X" }); });
  afterAll(async () => { await h.close(); });
  it("T-08: a re-upload request links the next photo to the original attempt and the participant sees a single reference thread", async () => {
    const first = await h.submit(A, await h.simImage("not a receipt at all\njust words")); expect(first.submission?.status).toBe("reupload"); expect(first.outcomes[0]).toMatch(/new photo|clearer photo/i);
    const second = await h.say(A, "", { image: await h.simImage(h.simReceipt({ no: "RV-100" })) }); await h.app.worker.drain(); // no need to pick the outlet again
    expect(second.replies[0]).toMatch(/reading your receipt/); const s2 = (await h.app.pipeline.get(second.result!.submissionId!))!; expect(s2.status).toBe("qualified"); expect(s2.reuploadOf).toBe(first.submissionId);
    // Capture-first: a later photo is simply another receipt. Where it was
    // bought is read from it, not carried over from the last one.
    const third = await h.say(A, "", { image: await h.simImage(h.simReceipt({ no: "RV-101" })) }); expect(third.replies[0]).toMatch(/reading your receipt/);
    await h.app.worker.drain(); expect((await h.app.pipeline.get(third.result!.submissionId!))!.reuploadOf).toBeNull();
  });
  it("review tasks carry an SLA, can be assigned, released and escalated; a decision closes the task exactly once", async () => {
    // An unreadable receipt number is now put to the participant first. When
    // they do not answer, the stalled-question sweep hands it to a reviewer —
    // which is where this test starts.
    const r = await h.submit(A, await h.simImage(h.simReceipt({ no: "" }))); expect(r.submission?.status).toBe("awaiting_participant");
    const escalated = await h.escalate(r.submissionId!); expect(escalated?.status).toBe("review"); expect(escalated?.reasonCode).toBe("participant_did_not_reply");
    const q = await h.app.pipeline.reviewQueue(); const item = q.items.find((i) => i.submissionId === r.submissionId)!; expect(item.state).toBe("open"); expect(Date.parse(item.slaDueAt)).toBeGreaterThan(Date.now());
    await h.app.pipeline.assign(r.submissionId!, reviewer); await expect(h.app.pipeline.assign(r.submissionId!, manager)).rejects.toMatchObject({ code: "CONFLICT" });
    await h.app.pipeline.release(r.submissionId!, reviewer); await h.app.pipeline.assign(r.submissionId!, manager);
    await h.app.pipeline.escalate(r.submissionId!, manager, "needs a second opinion"); expect((await h.app.pipeline.reviewQueue()).items.find((i) => i.submissionId === r.submissionId)!.state).toBe("escalated");
    await h.app.pipeline.correctFacts(r.submissionId!, { receiptNo: "RV-200" }, reviewer, "read from the photo");
    const before = (await h.app.pipeline.get(r.submissionId!))!.version;
    await h.app.pipeline.review(r.submissionId!, { reviewerId: reviewer, decision: "qualified", expectedVersion: before });
    await expect(h.app.pipeline.review(r.submissionId!, { reviewerId: reviewer, decision: "not_qualified", reasonCode: "reviewer_decision", expectedVersion: before })).rejects.toMatchObject({ code: "CONFLICT" });
    const s = (await h.app.pipeline.get(r.submissionId!))!; expect(s.status).toBe("qualified"); expect((await h.db.select().from(schema.canonicalReceipts).where(eq(schema.canonicalReceipts.id, s.canonicalReceiptId!)))[0].receiptNo).toBe("RV200"); // canonical form: upper-case alphanumerics
    const entry = (await h.db.select().from(schema.entries).where(eq(schema.entries.submissionId, r.submissionId!)))[0]; expect(entry.awardedBy).toBe(reviewer);
    expect((await h.db.select().from(schema.canonicalReceipts).where(eq(schema.canonicalReceipts.receiptNo, "RV200"))).length).toBe(1);
    await h.app.worker.drain(); const msgs = await h.app.outbox.byKeyPrefix(`submission:${r.submissionId}:`); expect(msgs.some((m) => /review/i.test((m.payload as { body: string }).body))).toBe(true);
    const actions = (await h.app.audit.list({ targetId: r.submissionId! })).map((a) => a.action); for (const a of ["submission.received", "submission.question_escalated", "review.escalated", "submission.facts_corrected", "submission.qualified"]) expect(actions, actions.join(",")).toContain(a);
  });
  it("a reviewer can qualify an image with unreadable identity fields using a manual-review canonical record", async () => {
    const r = await h.submit(B, await h.simImage(h.simReceipt({ no: "", packs: 4 }))); expect(r.submission?.status).toBe("awaiting_participant");
    expect((await h.escalate(r.submissionId!))?.status).toBe("review");
    await expect(h.app.pipeline.review(r.submissionId!, { reviewerId: reviewer, decision: "qualified" })).rejects.toMatchObject({ code: "VALIDATION" });
    await h.app.pipeline.review(r.submissionId!, { reviewerId: reviewer, decision: "qualified", note: "Human verified the receipt image and qualifying product; fiscal identity fields are unreadable." });
    const s = (await h.app.pipeline.get(r.submissionId!))!; expect(s.status).toBe("qualified");
    const [canonical] = await h.db.select().from(schema.canonicalReceipts).where(eq(schema.canonicalReceipts.id, s.canonicalReceiptId!)); expect(canonical.receiptKey).toBe(`manual-review:${r.submissionId}`); expect(canonical.receiptNo).toBeNull();
    expect((await h.db.select().from(schema.entries).where(eq(schema.entries.submissionId, r.submissionId!))).length).toBe(1);
  });
  it("T-07: the same receipt from a second phone while the first is under review is an ownership dispute; resolving it as a different purchase is recorded, never a second award", async () => {
    // A's receipt names a shop the campaign does not list, so the system asks A
    // which outlet it was. A answers — and because the header still corroborates
    // nothing, the match stays uncertain and the submission goes to review with
    // its receipt identity intact.
    const one = await h.submit(A, await h.simImage(h.simReceipt({ no: "RV-300", merchant: "Unlisted Trading Co\nSomewhere" })), { outlet: "mopani westgate harare" });
    expect(one.submission?.status).toBe("review"); expect(one.submission?.reasonCode).toBe("outlet_mismatch");
    // B photographs the same purchase while A's is still open: an ownership
    // dispute, never a second award.
    const two = await h.submit(B, await h.simImage(h.simReceipt({ no: "RV-300", merchant: "Unlisted Trading Co\nSomewhere" }) + "\n"), { outlet: "mopani westgate harare" });
    expect(two.submission?.status).toBe("review"); expect(two.submission?.reasonCode).toBe("ownership_dispute");
    // The canonical match is the one that decides; a perceptual match on the
    // same outlet is recorded alongside it as corroboration.
    const cands = await h.db.select().from(schema.duplicateCandidates).where(eq(schema.duplicateCandidates.submissionId, two.submissionId!));
    expect(cands.some((c) => c.kind === "canonical")).toBe(true);
    await h.app.pipeline.resolveDuplicate(cands[0].id, "different_purchase", reviewer, "different tills, same number series");
    const bId = (await h.app.participants.byUid(B))!.id;
    const bBefore = (await h.db.select().from(schema.entries).where(eq(schema.entries.participantId, bId))).length;
    await h.app.pipeline.review(one.submissionId!, { reviewerId: reviewer, decision: "not_qualified", reasonCode: "reviewer_decision", note: "date unreadable" });
    await h.app.pipeline.review(two.submissionId!, { reviewerId: reviewer, decision: "qualified" });
    // Resolving the dispute in B's favour awards exactly one entry: the
    // purchase is credited once, to whoever the reviewer decided owns it.
    expect((await h.db.select().from(schema.entries).where(eq(schema.entries.participantId, bId))).length).toBe(bBefore + 1);
    await expect(h.app.pipeline.review(one.submissionId!, { reviewerId: reviewer, decision: "qualified" })).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("safe reprocessing re-runs extraction for a non-credited submission only; credited ones must be disqualified instead", async () => {
    const nq = await h.submit(A, await h.simImage(h.simReceipt({ no: "RV-400", packs: 1 }))); expect(nq.submission?.status).toBe("not_qualified");
    await h.app.pipeline.reprocess(nq.submissionId!, manager, "extractor fix deployed"); await h.app.worker.drain();
    const s = (await h.app.pipeline.get(nq.submissionId!))!; expect(s.status).toBe("not_qualified"); expect((await h.db.select().from(schema.extractions).where(eq(schema.extractions.submissionId, nq.submissionId!))).length).toBe(2);
    const ok = await h.submit(A, await h.simImage(h.simReceipt({ no: "RV-401" }))); expect(ok.submission?.status).toBe("qualified");
    await expect(h.app.pipeline.reprocess(ok.submissionId!, manager, "x")).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("T-10: an approved per-period cap stops further awards with a clear reason; mixed 1kg packs count only when the rule allows", async () => {
    const active = await h.app.campaigns.activeVersion(h.campaign.id); const rules = h.app.campaigns.rulesOf(active);
    const mine = async () => (await h.db.select().from(schema.entries).where(eq(schema.entries.participantId, (await h.app.participants.byUid(A))!.id))).filter((e) => e.status === "active").length;
    const held = await mine();
    await h.app.campaigns.createVersion(h.campaign.id, {}, manager);
    const capVid = await h.app.campaigns.createVersion(h.campaign.id, { fromActive: true, rules: { caps: { perParticipantPerPeriod: held + 1, perParticipantCampaign: null } } }, manager); await h.app.campaigns.activateVersion(h.campaign.id, capVid, manager);
    expect((await h.submit(A, await h.simImage(h.simReceipt({ no: "RV-500" })))).submission?.status).toBe("qualified"); expect(await mine()).toBe(held + 1);
    const capped = await h.submit(A, await h.simImage(h.simReceipt({ no: "RV-501" }))); expect(capped.submission?.status).toBe("not_qualified"); expect(capped.submission?.reasonCode).toBe("entry_cap_reached"); expect(capped.outcomes[0]).toMatch(/maximum|limit/i);
    const v2 = await h.app.campaigns.createVersion(h.campaign.id, { fromActive: true, rules: { caps: { perParticipantPerPeriod: null, perParticipantCampaign: null }, qualification: { ...rules.qualification, allowMixedPacks: true } } }, manager); await h.app.campaigns.activateVersion(h.campaign.id, v2, manager);
    const mixed = await h.submit(B, await h.simImage(h.simReceipt({ no: "RV-600", packs: 4, product: "SWEETVALE BROWN SUGAR 1KG" }))); expect(mixed.submission?.status).toBe("qualified");
    const v3 = await h.app.campaigns.createVersion(h.campaign.id, { fromActive: true, rules: { qualification: { ...rules.qualification, allowMixedPacks: false } } }, manager); await h.app.campaigns.activateVersion(h.campaign.id, v3, manager);
    const strict = await h.submit(B, await h.simImage(h.simReceipt({ no: "RV-601", packs: 4, product: "SWEETVALE BROWN SUGAR 1KG" }))); expect(strict.submission?.status).toBe("not_qualified"); expect(strict.submission?.reasonCode).toBe("below_minimum");
  });
  it("reports reconcile with the ledger and every count has a definition", async () => {
    const rep = await h.app.reports.summary(h.campaign.id, { since: new Date(Date.now() - 86_400_000).toISOString(), until: new Date(Date.now() + 60_000).toISOString() });
    const entries = (await h.db.select().from(schema.entries)).filter((e) => e.status === "active").length;
    expect(rep.entries_active).toBe(entries); expect(rep.definitions).toBeTruthy(); expect(Object.keys(rep.definitions).length).toBeGreaterThan(5);
    const subs = await h.db.select().from(schema.submissions); expect(rep.submissions).toBe(subs.length);
  });
});
