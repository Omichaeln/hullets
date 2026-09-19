// Regression for the draw's hard capacity ceiling. A single multi-row INSERT of
// draw_candidates binds six parameters per row, so freezing a period broke at
// 10,923 eligible entries with a driver-level error that named nothing — on
// draw day, after the barrier had already closed the period.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { schema } from "@promo/db";
import { buildApp, type Harness } from "../helpers.ts";
import { newId } from "@promo/core";

const ENTRIES = 12_500; // comfortably past 10,922

describe("draw capacity", () => {
  let h: Harness;
  beforeAll(async () => { h = await buildApp({ extractor: "simulator" }); }, 300_000);
  afterAll(async () => { await h.close(); });

  it(`freezes a period with ${ENTRIES.toLocaleString()} eligible entries`, async () => {
    const period = (await h.app.campaigns.periods(h.campaign.id)).find((p) => p.code === "W0")!;
    const version = (await h.app.campaigns.activeVersion(h.campaign.id))!;

    // One real participant and one real receipt, then the ledger rows are
    // synthesised: this test is about the freeze statement, not the intake
    // path, and driving 12,500 receipts through extraction to prove something
    // about a bind-parameter count would take an hour.
    const phone = "263779000001";
    await h.register(phone, { first: "Scale", last: "Test", identity: "TESTSCL1X" });
    const seedSubmission = await h.submit(phone, await h.simImage(h.simReceipt({ no: "SCALE-1" })));
    expect(seedSubmission.submission?.status).toBe("qualified");
    const seedParticipantId = (await h.app.participants.byUid(phone))!.id;

    // Spread the entries over many participants: the prize plan awards one
    // prize per person, so a single-participant pool is refused by the barrier
    // long before the insert is reached.
    const PEOPLE = 250;
    const people = Array.from({ length: PEOPLE }, (_, i) => ({ id: `scale_ptc_${i}`, channel: "whatsapp", channelUid: `26378${String(i).padStart(8, "0")}`, firstName: "Scale", surname: `P${i}`, status: "active" }));
    await h.db.insert(schema.participants).values(people);
    const participantFor = (i: number) => (i === 0 ? seedParticipantId : people[i % PEOPLE].id);

    // entries carries a unique key per submission and per canonical receipt, so
    // each synthetic row needs its own of each.
    const subs = Array.from({ length: ENTRIES }, (_, i) => ({ ...seedSubmission.submission!, id: `scale_sub_${i}`, participantId: participantFor(i), reference: `R-SCL-${String(i).padStart(6, "0")}`, providerMessageId: `scale_msg_${i}`, canonicalReceiptId: null }));
    const canons = Array.from({ length: ENTRIES }, (_, i) => ({ id: `scale_rcp_${i}`, campaignId: h.campaign.id, receiptKey: `scale:${i}`, firstSubmissionId: `scale_sub_${i}`, status: "credited" }));
    const entries = Array.from({ length: ENTRIES }, (_, i) => ({
      id: newId("ent"), campaignId: h.campaign.id, campaignVersionId: version.id, participantId: participantFor(i),
      submissionId: `scale_sub_${i}`, canonicalReceiptId: `scale_rcp_${i}`,
      periodCode: period.code, units: 1, status: "active", awardedBy: "scale-test",
    }));
    for (let i = 0; i < ENTRIES; i += 1_000) {
      await h.db.insert(schema.submissions).values(subs.slice(i, i + 1_000));
      await h.db.insert(schema.canonicalReceipts).values(canons.slice(i, i + 1_000));
      await h.db.insert(schema.entries).values(entries.slice(i, i + 1_000));
    }

    const [{ n }] = await h.db.select({ n: sql<number>`count(*)::int` }).from(schema.entries).where(eq(schema.entries.periodCode, period.code));
    expect(n).toBeGreaterThanOrEqual(ENTRIES);

    await h.closePeriod("W0");
    const officer = (await h.app.auth.byEmail("draw@example.test"))!.id;
    const draw = await h.app.draws.freeze({ campaignId: h.campaign.id, periodId: period.id, actorId: officer, override: { allow: ["UNRESOLVED_SUBMISSIONS"], reason: "scale test" } });

    const [{ c }] = await h.db.select({ c: sql<number>`count(*)::int` }).from(schema.drawCandidates).where(eq(schema.drawCandidates.drawId, draw.id));
    expect(c).toBeGreaterThanOrEqual(ENTRIES);
    // Positions stay contiguous from zero, which is what verifyStored() re-reads.
    const [{ maxPos }] = await h.db.select({ maxPos: sql<number>`max(position)::int` }).from(schema.drawCandidates).where(eq(schema.drawCandidates.drawId, draw.id));
    expect(maxPos).toBe(c - 1);
    expect((await h.app.draws.verifyStored(draw)).ok).toBe(true);
  }, 900_000);
});
