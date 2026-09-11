// Participant journeys through the real intake -> conversation -> pipeline -> outbox path
// with the labelled SIMULATED extractor (fast). Real-OCR journeys live in tests/ocr.
// Covers T-01, T-02, T-03, T-05, T-06, T-07 (identity), T-13 (replay), T-16, navigation, handoff.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { schema } from "@promo/db";
import { buildApp, type Harness } from "../helpers.ts";
const P1 = "263771000001", P2 = "263771000002";
describe("participant journeys", () => {
  let h: Harness; beforeAll(async () => { h = await buildApp({ extractor: "simulator" }); }); afterAll(async () => { await h.close(); });
  const entryCount = async () => (await h.db.select().from(schema.entries)).length;
  it("T-01: a greeting from a new phone returns the campaign menu", async () => { const r = await h.say(P1, "Hi"); expect(r.result?.state).toBe("HOME"); expect(r.replies[0]).toMatch(/1\. Register/); expect(r.replies[0]).toMatch(/7\. My entries/); });
  it("T-16: an unregistered participant can read mechanics, terms, prizes and winners", async () => { expect((await h.say(P1, "3")).replies[0]).toMatch(/2 x 2kg pack/i); expect((await h.say(P1, "4")).replies[0]).toMatch(/TEST-T1/); expect((await h.say(P1, "5")).replies[0]).toMatch(/voucher/i); expect((await h.say(P1, "6")).replies[0]).toMatch(/No winners have been published yet/); expect((await h.say(P1, "2")).replies[0]).toMatch(/register first/i); });
  it("T-02: registration captures five fields with confirmation, correction and terms; a returning phone is recognised", async () => {
    expect((await h.say(P1, "1")).replies[0]).toMatch(/FIRST NAME/); expect((await h.say(P1, "T")).replies[0]).toMatch(/at least 2/); expect((await h.say(P1, "Tendai")).replies[0]).toMatch(/SURNAME/); expect((await h.say(P1, "Ncube")).replies[0]).toMatch(/ID number/); expect((await h.say(P1, "12")).replies[0]).toMatch(/doesn't look like/); expect((await h.say(P1, "TEST1234X")).replies[0]).toMatch(/town or city/);
    const c = await h.say(P1, "Harare"); expect(c.replies[0]).toMatch(/Name: Tendai Ncube/); expect(c.replies[0]).toMatch(/ID: TE\*+4X/); expect(c.replies[0]).toMatch(/\+263771000001/);
    expect((await h.say(P1, "2")).replies[0]).toMatch(/SURNAME/); expect((await h.say(P1, "Ncube-Moyo")).replies[0]).toMatch(/Ncube-Moyo/); expect((await h.say(P1, "yes")).replies[0]).toMatch(/TEST-T1/);
    const done = await h.say(P1, "yes"); expect(done.replies[0]).toMatch(/registered, Tendai/);
    const p = (await h.app.participants.byUid(P1))!; expect(p.surname).toBe("Ncube-Moyo"); expect(p.identityEnc).toBeTruthy(); expect(p.identityEnc).not.toContain("TEST1234X"); expect(p.identityFp).toBeTruthy(); expect(p.identityMask).toMatch(/\*/);
    const e = (await h.app.participants.enrollment(p.id, h.campaign.id))!; expect(e.termsVersion).toBe("TEST-T1"); expect(e.privacyVersion).toBe("TEST-P1");
    expect((await h.say(P1, "hello")).replies[0]).toMatch(/1\. Register/); expect((await h.say(P1, "1")).replies[0]).toMatch(/already registered as Tendai/); await h.say(P1, "menu");
    expect((await h.db.select().from(schema.participants).where(eq(schema.participants.channelUid, P1))).length).toBe(1);
  });
  it("T-03: outlet selection covers all 80 branches by shop, pages, search and Back, and always ends in a canonical id", async () => {
    const r1 = await h.say(P1, "2"); expect(r1.result?.state).toBe("OUTLET"); expect(r1.replies[0]).toMatch(/1\. Baobab Stores/); expect(r1.replies[0]).toMatch(/8\. Savanna Grocer/);
    const r2 = await h.say(P1, "1"); expect(r2.replies[0]).toMatch(/Baobab Stores: choose the BRANCH/); expect(r2.replies[0]).toMatch(/9\. More/);
    const r3 = await h.say(P1, "9"); expect(r3.replies[0]).toMatch(/2\. .*Victoria Falls/); expect((await h.say(P1, "back")).replies[0]).toMatch(/Choose the SHOP/i);
    await h.say(P1, "1"); const pick = await h.say(P1, "1"); expect(pick.result?.state).toBe("RECEIPT"); expect(pick.replies[0]).toMatch(/Outlet: Baobab Stores —/);
    await h.say(P1, "back"); const s = await h.say(P1, "westgate"); expect(s.result?.state).toBe("OUTLET"); expect((s.replies[0].match(/\n\d\./g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect((await h.say(P1, "zzzz-nowhere")).replies[0]).toMatch(/No branch matched/); expect((await h.say(P1, "42")).replies[0]).toMatch(/one of the numbers/);
    await h.say(P1, "mopani westgate harare"); const ok = await h.say(P1, "1"); expect(ok.result?.state).toBe("RECEIPT");
    const ses = (await h.app.conversation.session(h.campaign.id, P1))!; expect((ses.context as { outletId: string }).outletId).toBe("out_MOP-HRE-01");
    expect((await h.app.campaigns.campaignOutlets(h.campaign.id)).length).toBe(80);
    expect((await h.say(P1, "hello there")).replies[0]).toMatch(/PHOTO of your receipt/); expect((await h.say(P1, "", { kind: "unsupported" })).replies[0]).toMatch(/PHOTO of your receipt/);
  });
  it("T-05/T-06/T-13: first receipt awards one entry; a second unique receipt awards another; the same receipt again never credits twice; replayed webhooks are deduped", async () => {
    const img1 = await h.simImage(h.simReceipt({ no: "004512" })); const a = await h.say(P1, "", { image: img1 }); expect(a.replies[0]).toMatch(/received your receipt.*reference is R-/s); await h.app.worker.drain();
    const sid = a.result!.submissionId!; const s1 = (await h.app.pipeline.get(sid))!; expect(s1.status).toBe("qualified");
    const outcome = await h.app.outbox.byKeyPrefix(`submission:${sid}:outcome`); expect(outcome.length).toBe(1); expect((outcome[0].payload as { body: string }).body).toMatch(/ONE entry has been added/); expect((outcome[0].payload as { body: string }).body).not.toMatch(/won/i);
    expect(await entryCount()).toBe(1);
    const b = await h.submit(P1, await h.simImage(h.simReceipt({ no: "004513" }))); expect(b.submission?.status).toBe("qualified"); expect(await entryCount()).toBe(2); expect(b.outcomes[0]).toMatch(/2 qualified entries/);
    const c = await h.submit(P1, img1); expect(c.submission?.status).toBe("duplicate"); expect(c.outcomes[0]).toMatch(/already been used/); expect(c.outcomes[0]).not.toMatch(/2637/);
    await h.register(P2, { first: "Rudo", last: "Chari", identity: "TEST9999Y", town: "Bulawayo" });
    const d = await h.submit(P2, await h.simImage(h.simReceipt({ no: "004512" }) + "\n")); expect(d.submission?.status).toBe("duplicate"); expect(await entryCount()).toBe(2);
    const pm = (await h.app.queue.event(a.id!))!.providerMessageId; const replay = await h.say(P1, "", { image: img1, providerMessageId: pm }); expect(replay.duplicate).toBe(true); expect(await entryCount()).toBe(2);
    const st = await h.say(P1, "7"); expect(st.replies[0]).toMatch(/Qualified: 2/); expect(st.replies[0]).toMatch(/Not qualified: 1/);
  });
  it("T-07/T-14 (identity): a re-photograph with the total lost is the same purchase; a conflicting readable total goes to review; never a second award", async () => {
    const before = await entryCount();
    const noTotal = await h.submit(P2, await h.simImage(h.simReceipt({ no: "004512" }).replace(/TOTAL [^\n]*\n/, "") + "\n\n")); expect(noTotal.submission?.status).toBe("duplicate");
    const conflict = await h.submit(P2, await h.simImage(h.simReceipt({ no: "004512", packs: 3 }))); expect(conflict.submission?.status).toBe("review"); expect(conflict.submission?.reasonCode).toBe("identity_conflict"); expect(conflict.outcomes[0]).toMatch(/quick check/);
    expect(await entryCount()).toBe(before);
    expect((await h.db.select().from(schema.canonicalReceipts).where(eq(schema.canonicalReceipts.receiptNo, "004512"))).length).toBe(1);
  });
  it("global navigation and unsupported input never qualify; support handoff suspends automation until released", async () => {
    await h.say(P1, "2"); expect((await h.say(P1, "help")).replies[0]).toMatch(/BACK goes one step back/); expect((await h.say(P1, "cancel")).replies[0]).toMatch(/Cancelled/); expect((await h.say(P1, "0")).replies[0]).toMatch(/1\. Register/);
    const before = await entryCount(); await h.selectOutlet(P1); await h.say(P1, "voice note"); expect(await entryCount()).toBe(before);
    const r = await h.say(P1, "support"); expect(r.replies[0]).toMatch(/team will pick this up/); expect((await h.say(P1, "2")).replies[0]).toMatch(/team is handling/);
    expect((await h.app.conversation.handoffQueue()).length).toBe(1);
    await h.app.conversation.releaseHandoff(h.campaign.id, P1, "stf_test"); expect((await h.say(P1, "menu")).replies[0]).toMatch(/1\. Register/);
  });
  it("T-18: a new content version applies prospectively; enrollment keeps the accepted notice versions", async () => {
    const vid = await h.app.campaigns.createVersion(h.campaign.id, { fromActive: true, content: { termsVersion: "TEST-T2", messages: { menu: "New menu {campaign}\n1. Register\n2. Enter" } } }, "stf_test"); await h.app.campaigns.activateVersion(h.campaign.id, vid, "stf_test");
    expect((await h.say(P1, "menu")).replies[0]).toMatch(/^New menu/);
    const p = (await h.app.participants.byUid(P1))!; expect((await h.app.participants.enrollment(p.id, h.campaign.id))!.termsVersion).toBe("TEST-T1");
    expect((await h.db.select().from(schema.entries).where(and(eq(schema.entries.participantId, p.id)))).every((e) => e.campaignVersionId !== vid)).toBe(true);
  });
  it("closed campaign: only winners browsing remains; paused intake refuses new entries with a clear message", async () => {
    await h.app.campaigns.setControls(h.campaign.id, { pauseIntake: true }, "stf_test"); expect((await h.say(P2, "2")).replies[0]).toMatch(/paused/i); await h.app.campaigns.setControls(h.campaign.id, { pauseIntake: false }, "stf_test");
    await h.app.campaigns.setStatus(h.campaign.id, "closed", "stf_test", "test"); expect((await h.say(P2, "hi")).replies[0]).toMatch(/closed/); expect((await h.say(P2, "6")).replies[0]).toMatch(/No winners/);
  });
});
