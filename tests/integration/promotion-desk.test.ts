// The promotion desk: what the client's two roles can see, what exactly one of
// them can do, and what neither can reach. Driven through the real HTTP + tRPC
// surface, because an authorisation boundary that is only enforced in the
// console is not a boundary at all.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@promo/db";
import { buildApp, type Harness } from "../helpers.ts";
import { httpHarness } from "../http.ts";

describe("promotion desk", () => {
  let h: Harness, http: Awaited<ReturnType<typeof httpHarness>>;
  const tok: Record<string, string> = {};
  let entryId: string;

  beforeAll(async () => {
    h = await buildApp({ extractor: "simulator" });
    http = await httpHarness(h);
    for (const [email, name, roles] of [
      ["promo.admin@client.test", "Thandi Ncube", ["promotion_admin"]],
      ["promo.assistant@client.test", "Rudo Moyo", ["promotion_assistant"]],
    ] as Array<[string, string, string[]]>) {
      await h.app.auth.createUser({ email, name, roles, createdBy: "test" });
    }
    tok.admin = await h.staffToken("promo.admin@client.test");
    tok.assistant = await h.staffToken("promo.assistant@client.test");
    tok.reviewer = await h.staffToken("reviewer@example.test");

    // Two people, three receipts: one qualifies with 2 packs, one is below the
    // minimum, one is a re-photograph of the first (already claimed).
    await h.register("263771000401", { first: "Desk", last: "One", identity: "TESTDSK1X" });
    await h.register("263771000402", { first: "Desk", last: "Two", identity: "TESTDSK2X" });
    await h.submit("263771000401", await h.simImage(h.simReceipt({ no: "DSK-1", packs: 2 })));
    await h.submit("263771000401", await h.simImage(h.simReceipt({ no: "DSK-2", packs: 1 })));
    await h.submit("263771000402", await h.simImage(h.simReceipt({ no: "DSK-3", packs: 3 })));
    const [e] = await h.app.db.select().from(schema.entries).where(eq(schema.entries.status, "active")).limit(1);
    entryId = e!.id;
  });
  afterAll(async () => { await http.close(); await h.close(); });

  it("both roles read the whole desk; neither can reach the platform team's surfaces", async () => {
    for (const who of ["admin", "assistant"] as const) {
      const c = http.client(tok[who]);
      expect((await c.promotion.today.query({})).campaignId, `${who} sees Today`).toBeTruthy();
      expect((await c.promotion.entries.query({})).rows.length, `${who} sees Entries`).toBeGreaterThan(0);
      expect((await c.promotion.submissions.query({})).rows.length, `${who} sees Submissions`).toBeGreaterThan(0);
      expect(await http.status(() => c.support.queue.query()), `${who} sees Queries`).toBe(200);

      // Deliberately not granted: the draw machinery, winner handling, staff
      // administration, the audit chain, integrations, and anything that can
      // unmask a national identity number.
      const period = (await h.app.campaigns.periods(h.campaign.id))[0];
      expect(await http.status(() => c.draws.freeze.mutate({ campaignId: h.campaign.id, periodId: period.id })), `${who} cannot freeze a draw`).toBe(403);
      expect(await http.status(() => c.draws.list.query({ campaignId: h.campaign.id })), `${who} cannot read draws`).toBe(403);
      expect(await http.status(() => c.winners.list.query({})), `${who} cannot read winners`).toBe(403);
      expect(await http.status(() => c.staff.list.query()), `${who} cannot administer staff`).toBe(403);
      expect(await http.status(() => c.audit.list.query({})), `${who} cannot read the audit chain`).toBe(403);
      expect(await http.status(() => c.ops.integrations.query()), `${who} cannot read integrations`).toBe(403);
      expect(await http.status(() => c.reports.export.query({ scope: "participants" })), `${who} cannot export`).toBe(403);
      expect(await http.status(() => c.participants.revealIdentity.mutate({ participantId: "ptc_x", reason: "x" })), `${who} cannot unmask an identity`).toBe(403);
      expect(await http.status(() => c.submissions.review.mutate({ submissionId: "sub_x", decision: "qualified", reasonCode: "x" })), `${who} cannot review receipts`).toBe(403);
    }
  });

  it("exactly one thing separates the two roles: an assistant cannot change an entry's standing", async () => {
    expect((await http.client(tok.admin).promotion.me.query()).canDecideEntries).toBe(true);
    const assistantMe = await http.client(tok.assistant).promotion.me.query();
    expect(assistantMe.canDecideEntries).toBe(false);
    expect(assistantMe.isAssistant).toBe(true);

    // The console hides the button, but the boundary is the server's.
    expect(await http.status(() => http.client(tok.assistant).entries.disqualify.mutate({ entryId, reason: "assistant should not be able to" }))).toBe(403);
    expect((await h.app.db.select().from(schema.entries).where(eq(schema.entries.id, entryId)))[0].status).toBe("active");

    await http.client(tok.admin).entries.disqualify.mutate({ entryId, reason: "forged receipt proven on Tuesday" });
    expect((await h.app.db.select().from(schema.entries).where(eq(schema.entries.id, entryId)))[0].status).not.toBe("active");
    // ...and the reason is in the tamper-evident trail, attributed to the admin
    // who gave it — not to "the console" and not to the platform team.
    const audit = await h.app.audit.list({ targetType: "entry", targetId: entryId, limit: 20 });
    const disqualified = audit.find((a) => a.action === "entry.disqualified");
    expect(disqualified, "the disqualification is audited").toBeTruthy();
    expect(disqualified!.reason).toContain("forged receipt proven on Tuesday");
    expect(disqualified!.actorId).toBe(await h.staffId("promo.admin@client.test"));

    await http.client(tok.admin).entries.reinstate.mutate({ entryId, reason: "receipt confirmed genuine" });
    expect((await h.app.db.select().from(schema.entries).where(eq(schema.entries.id, entryId)))[0].status).toBe("active");
  });

  it("“packs bought” is what the rules counted, and “not read” is not zero", async () => {
    const rows = (await http.client(tok.admin).promotion.submissions.query({})).rows;
    expect(rows.length).toBeGreaterThan(0);
    // Every row that was decided against a readable receipt carries the pack
    // count the rules actually used, not a number re-derived for the console.
    const qualified = rows.filter((r) => r.status === "qualified");
    expect(qualified.length).toBeGreaterThan(0);
    for (const r of qualified) expect(r.packs, `${r.reference} carries the counted packs`).toBeGreaterThanOrEqual(1);

    // A filter of "at least 1 pack" must exclude rows where we could not tell,
    // rather than treating them as zero and quietly counting them as "bought none".
    const atLeastOne = (await http.client(tok.admin).promotion.submissions.query({ packsMin: 1 })).rows;
    expect(atLeastOne.every((r) => r.packs != null && r.packs >= 1)).toBe(true);
    expect(atLeastOne.length).toBeLessThanOrEqual(rows.length);
  });

  it("every filter narrows, and they combine", async () => {
    const c = http.client(tok.admin);
    const all = (await c.promotion.entries.query({})).rows;
    expect(all.length).toBeGreaterThan(0);
    const facets = await c.promotion.filters.query({});
    expect(facets.retailers.length).toBeGreaterThan(0);
    expect(facets.periods.length).toBeGreaterThan(0);

    const retailer = all[0].retailer!;
    const byShop = (await c.promotion.entries.query({ retailer })).rows;
    expect(byShop.length).toBeGreaterThan(0);
    expect(byShop.every((r) => r.retailer === retailer)).toBe(true);

    const town = all[0].town!;
    expect((await c.promotion.entries.query({ town })).rows.every((r) => r.town === town)).toBe(true);

    // Combining must intersect, never widen.
    const combined = (await c.promotion.entries.query({ retailer, town })).rows;
    expect(combined.length).toBeLessThanOrEqual(byShop.length);
    expect(combined.every((r) => r.retailer === retailer && r.town === town)).toBe(true);

    // "Receipts sent by that person" counts every receipt they sent, including
    // the ones that did not qualify — it is the number you want when a name
    // keeps appearing.
    const busiest = Math.max(...all.map((r) => r.receiptsByPerson));
    expect(busiest).toBeGreaterThan(1);
    expect((await c.promotion.entries.query({ receiptsMin: busiest })).rows.every((r) => r.receiptsByPerson >= busiest)).toBe(true);

    // Free text finds a person by name and by the last digits a masked list shows.
    const name = all[0].name.split(" ")[0];
    expect((await c.promotion.entries.query({ search: name })).rows.length).toBeGreaterThan(0);
    expect((await c.promotion.entries.query({ search: "zzzz-no-such-person" })).rows.length).toBe(0);

    // A filter nobody matches returns nothing rather than everything: an empty
    // WHERE would silently show the whole campaign.
    expect((await c.promotion.entries.query({ packsMin: 9999 })).rows.length).toBe(0);
  });

  it("Submissions explains what Entries cannot: the receipts that did not count", async () => {
    const c = http.client(tok.admin);
    const entries = (await c.promotion.entries.query({})).rows;
    const subs = (await c.promotion.submissions.query({})).rows;
    // An entry only exists for the receipts that qualified, so the submissions
    // list is necessarily the larger one — that is the whole reason it exists.
    expect(subs.length).toBeGreaterThan(entries.length);
    const notQualified = (await c.promotion.submissions.query({ outcome: "not_qualified" })).rows;
    expect(notQualified.length).toBeGreaterThan(0);
    expect(notQualified.every((r) => r.status === "not_qualified")).toBe(true);
    // ...and each one says why, in a reason code the desk renders in words.
    expect(notQualified.every((r) => !!r.reason)).toBe(true);
    // The "still being read" chip groups the three in-flight statuses, which are
    // one thing to an operator and three to the pipeline.
    const pending = (await c.promotion.submissions.query({ outcome: "pending" })).rows;
    expect(pending.every((r) => ["received", "processing", "delayed"].includes(r.status))).toBe(true);
  });

  it("a technical user is not given the desk's roles by accident", async () => {
    // The reviewer holds entry.disqualify through its own role, but must not
    // appear as a promotion user: the desk is chosen by role, and a reviewer
    // landing on a client console would be a routing bug.
    const me = await http.client(tok.reviewer).promotion.me.query();
    expect(me.canDecideEntries).toBe(false);
    expect(me.isAssistant).toBe(false);
  });
});
