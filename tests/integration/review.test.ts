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
    expect(second.replies[0]).toMatch(/received your receipt/); const s2 = (await h.app.pipeline.get(second.result!.submissionId!))!; expect(s2.status).toBe("qualified"); expect(s2.reuploadOf).toBe(first.submissionId);
    const third = await h.say(A, "", { image: await h.simImage(h.simReceipt({ no: "RV-101" })) }); expect(third.replies[0]).toMatch(/received your receipt for Mopani Mart/); expect(third.replies[0]).toMatch(/Reply 2 and choose the shop/); // every later photo reuses the chosen outlet
    await h.app.worker.drain(); expect((await h.app.pipeline.get(third.result!.submissionId!))!.reuploadOf).toBeNull();
  });
  it("review tasks carry an SLA, can be assigned, released and escalated; a decision closes the task exactly once", async () => {
    const r = await h.submit(A, await h.simImage(h.simReceipt({ no: "" }))); expect(r.submission?.status).toBe("review"); expect(r.submission?.reasonCode).toBe("receipt_number_unreadable");
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
    const actions = (await h.app.audit.list({ targetId: r.submissionId! })).map((a) => a.action); for (const a of ["submission.received", "review.escalated", "submission.facts_corrected", "submission.qualified"]) expect(actions, actions.join(",")).toContain(a);
  });
  it("T-07: the same receipt from a second phone while the first is under review is an ownership dispute; resolving it as a different purchase is recorded, never a second award", async () => {
    // A's photo names another shop than the outlet A selected: the key (selected outlet, date, number) is intact but the match is uncertain -> review
    const one = await h.submit(A, await h.simImage(h.simReceipt({ no: "RV-300", merchant: "Baobab Stores\nWestgate, Harare" }))); expect(one.submission?.reasonCode).toBe("outlet_mismatch");     expect(one.submission?.status).toBe("review");
    const two = await h.submit(B, await h.simImage(h.simReceipt({ no: "RV-300" }))); expect(two.submission?.status).toBe("review"); expect(two.submission?.reasonCode).toBe("ownership_dispute");
    const cands = await h.db.select().from(schema.duplicateCandidates).where(eq(schema.duplicateCandidates.submissionId, two.submissionId!)); expect(cands.length).toBe(1);
    await h.app.pipeline.resolveDuplicate(cands[0].id, "different_purchase", reviewer, "different tills, same number series");
    await h.app.pipeline.review(one.submissionId!, { reviewerId: reviewer, decision: "not_qualified", reasonCode: "reviewer_decision", note: "date unreadable" });
    await h.app.pipeline.review(two.submissionId!, { reviewerId: reviewer, decision: "qualified" });
    expect((await h.db.select().from(schema.entries).where(eq(schema.entries.participantId, (await h.app.participants.byUid(B))!.id))).length).toBe(1);
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
    const vid = await h.app.campaigns.createVersion(h.campaign.id, { fromActive: true, rules: { caps: { perParticipantPerPeriod: 5, perParticipantCampaign: null } } }, manager); await h.app.campaigns.activateVersion(h.campaign.id, vid, manager);
    const mine = async () => (await h.db.select().from(schema.entries).where(eq(schema.entries.participantId, (await h.app.participants.byUid(A))!.id))).filter((e) => e.status === "active").length;
    expect(await mine()).toBe(4);
    expect((await h.submit(A, await h.simImage(h.simReceipt({ no: "RV-500" })))).submission?.status).toBe("qualified"); expect(await mine()).toBe(5);
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
