// The campaign experience: every platform role can see the promotion, only the
// right role can change it, and the set-up flow's every control lands on the
// server. Driven through the real HTTP + tRPC surface.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PERMISSIONS, PLATFORM_ROLES, can } from "@promo/core";
import { buildApp, type Harness } from "../helpers.ts";
import { httpHarness } from "../http.ts";

const STAFF: Record<string, string> = { campaign_manager: "manager@example.test", reviewer: "reviewer@example.test", support: "support@example.test", draw_officer: "draw@example.test", draw_approver: "approver@example.test", fulfilment: "fulfilment@example.test", auditor: "auditor@example.test", platform_admin: "admin@example.test" };

describe("campaign experience", () => {
  let h: Harness, http: Awaited<ReturnType<typeof httpHarness>>;
  const tok: Record<string, string> = {};
  beforeAll(async () => {
    h = await buildApp({ extractor: "simulator" }); http = await httpHarness(h);
    for (const [role, email] of Object.entries(STAFF)) tok[role] = await h.staffToken(email);
  });
  afterAll(async () => { await http.close(); await h.close(); });

  it("the policy is read-wide for the platform team and act-narrow for everyone", () => {
    for (const role of PLATFORM_ROLES) for (const p of ["campaign.read", "participant.read", "submission.read", "entry.read", "draw.read", "winner.read", "report.read", "support.read"] as const) expect(can([role], p), `${role} reads ${p}`).toBe(true);
    // What the administrator gains is sight, never authority.
    for (const p of ["campaign.write", "campaign.activate", "submission.review", "submission.media", "draw.execute", "draw.approve", "winner.manage", "winner.publish", "participant.identity.reveal", "report.export"] as const) expect(can(["platform_admin"], p), `platform_admin cannot ${p}`).toBe(false);
    // The dual-control pairs are still disjoint.
    expect(PERMISSIONS["draw.execute"].some((r) => (PERMISSIONS["draw.approve"] as readonly string[]).includes(r))).toBe(false);
    expect([...PERMISSIONS["campaign.write"]]).toEqual(["campaign_manager"]);
    // The client's roles were not widened by accident.
    for (const p of ["draw.read", "winner.read", "campaign.write"] as const) expect(can(["promotion_admin"], p)).toBe(false);
  });

  it("every platform role, the administrator included, reaches the dashboard's data and the campaign pages", async () => {
    for (const role of PLATFORM_ROLES) {
      const c = http.client(tok[role]);
      const list = await c.campaigns.list.query(); expect(list.length, `${role} lists campaigns`).toBeGreaterThan(0);
      const detail = await c.campaigns.get.query({ campaignId: h.campaign.id }); expect(detail.versions.length, `${role} opens the campaign`).toBeGreaterThan(0);
      expect((await c.reports.summary.query({ campaignId: h.campaign.id })).registrations, `${role} reads the dashboard metrics`).toBeGreaterThanOrEqual(0);
      expect(await http.status(() => c.entries.list.query({})), `${role} reads entries`).toBe(200);
      expect(await http.status(() => c.participants.search.query({})), `${role} reads participants`).toBe(200);
      expect(await http.status(() => c.draws.list.query({ campaignId: h.campaign.id })), `${role} reads draws`).toBe(200);
      expect(await http.status(() => c.winners.list.query({})), `${role} reads winners`).toBe(200);
      expect(await http.status(() => c.campaigns.activation.query({ campaignId: h.campaign.id })), `${role} reads readiness`).toBe(200);
      expect(await http.status(() => c.auth.directory.query()), `${role} sees the team`).toBe(200);
    }
  });

  it("only the campaign manager can change a campaign; the server says so with 403, not with a hidden button", async () => {
    const period = (await h.app.campaigns.periods(h.campaign.id))[0];
    for (const role of PLATFORM_ROLES.filter((r) => r !== "campaign_manager")) {
      const c = http.client(tok[role]);
      expect(await http.status(() => c.campaigns.create.mutate({ code: `X-${role.toUpperCase()}`, name: "x", startsAt: "2026-01-01T00:00:00Z", endsAt: "2026-02-01T00:00:00Z" })), `${role} cannot create`).toBe(403);
      expect(await http.status(() => c.campaigns.update.mutate({ campaignId: h.campaign.id, description: "x" })), `${role} cannot edit basics`).toBe(403);
      expect(await http.status(() => c.campaigns.createVersion.mutate({ campaignId: h.campaign.id, fromActive: true })), `${role} cannot open a draft`).toBe(403);
      expect(await http.status(() => c.campaigns.setControls.mutate({ campaignId: h.campaign.id, pauseIntake: true })), `${role} cannot pause`).toBe(403);
      expect(await http.status(() => c.campaigns.setStatus.mutate({ campaignId: h.campaign.id, status: "paused" })), `${role} cannot change status`).toBe(403);
      expect(await http.status(() => c.campaigns.upsertPeriod.mutate({ campaignId: h.campaign.id, code: period.code, startsAt: period.startsAt, endsAt: period.endsAt })), `${role} cannot edit periods`).toBe(403);
    }
  });

  it("the set-up flow persists: description, basics, a draft opened from the live version, section saves, activation", async () => {
    const m = http.client(tok.campaign_manager);
    const created = await m.campaigns.create.mutate({ code: "EXP-2026", name: "Experience test", description: "For the team: a test of the set-up flow.", startsAt: "2026-10-01T00:00:00Z", endsAt: "2026-12-01T00:00:00Z", timezone: "Africa/Harare" });
    let d = await m.campaigns.get.query({ campaignId: created.campaign.id });
    expect(d.campaign.description).toBe("For the team: a test of the set-up flow.");
    expect(d.campaign.status).toBe("draft"); expect(d.versions).toHaveLength(1); expect(d.versions[0].status).toBe("draft"); expect(d.activeVersion).toBeNull();
    // Basics
    await m.campaigns.update.mutate({ campaignId: d.campaign.id, description: "Updated.", name: "Experience test (renamed)" });
    d = await m.campaigns.get.query({ campaignId: d.campaign.id }); expect(d.campaign.description).toBe("Updated."); expect(d.campaign.name).toBe("Experience test (renamed)");
    // Each section writes its part of the draft; the other parts are untouched.
    const vid = d.versions[0].id;
    await m.campaigns.updateVersion.mutate({ versionId: vid, rules: { products: [{ code: "SUG-2", name: "Brown Sugar 2kg", packGrams: 2000, aliases: ["brown sugar"], qualifying: true }], qualification: { mode: "packs", minPacks: 2, packGrams: 2000, minTotalGrams: 4000, allowMixedPacks: false }, caps: { perParticipantPerPeriod: 3, perParticipantCampaign: null }, eligibility: { minAge: 18, priorWinnerExclusion: "campaign" } } });
    await m.campaigns.updateVersion.mutate({ versionId: vid, flags: { identityStage: "winner", locationMode: "province", participantStatus: false } });
    await m.campaigns.updateVersion.mutate({ versionId: vid, content: { termsVersion: "T1", privacyVersion: "P1", termsUrl: "https://example.test/terms", prizesText: "Weekly vouchers", messages: { received: "Got it — {reference}." } } });
    await m.campaigns.updateVersion.mutate({ versionId: vid, prizePlan: { tiers: [{ code: "P1", label: "Voucher", count: 2 }], alternatesPerWinner: 2, onePrizePerParticipant: true, claimDays: 10 } });
    await m.campaigns.upsertPeriod.mutate({ campaignId: d.campaign.id, code: "W1", label: "Week 1", startsAt: "2026-10-01T00:00:00Z", endsAt: "2026-10-08T00:00:00Z", drawAt: "2026-10-09T09:00:00Z" });
    d = await m.campaigns.get.query({ campaignId: d.campaign.id });
    const v = d.versions[0] as { rules: Record<string, unknown>; flags: Record<string, unknown>; content: Record<string, unknown>; prizePlan: Record<string, unknown> };
    expect((v.rules.products as unknown[]).length).toBe(1); expect((v.rules.caps as { perParticipantPerPeriod: number }).perParticipantPerPeriod).toBe(3); expect((v.rules.eligibility as { priorWinnerExclusion: string }).priorWinnerExclusion).toBe("campaign");
    expect(v.flags.identityStage).toBe("winner"); expect(v.flags.locationMode).toBe("province");
    expect((v.content.messages as Record<string, string>).received).toContain("{reference}"); expect(v.content.termsUrl).toBe("https://example.test/terms");
    expect((v.prizePlan.tiers as unknown[]).length).toBe(1); expect(v.prizePlan.claimDays).toBe(10);
    expect(d.periods.map((p) => p.code)).toEqual(["W1"]);
    // Readiness maps to the sections: nothing about products, prizes or periods is missing any more; outlets still are.
    const r = await m.campaigns.activation.query({ campaignId: d.campaign.id });
    const codes = r.failures.map((f) => f.code);
    expect(codes).not.toContain("RULES_PRODUCTS"); expect(codes).not.toContain("PRIZES_EMPTY"); expect(codes).not.toContain("PERIODS_EMPTY"); expect(codes).not.toContain("CONTENT_TERMS");
    expect(codes).toContain("OUTLETS_EMPTY"); expect(codes).toContain("NO_ACTIVE_VERSION");
    // Activate the version, then the campaign.
    await m.campaigns.activateVersion.mutate({ campaignId: d.campaign.id, versionId: vid });
    d = await m.campaigns.get.query({ campaignId: d.campaign.id }); expect(d.activeVersion?.id).toBe(vid);
    // The live version is immutable: the set-up flow opens a draft from it instead.
    expect(await http.status(() => m.campaigns.updateVersion.mutate({ versionId: vid, flags: { identityStage: "off" } }))).toBe(409);
    const draftId = await m.campaigns.createVersion.mutate({ campaignId: d.campaign.id, fromActive: true, flags: { identityStage: "off" } });
    d = await m.campaigns.get.query({ campaignId: d.campaign.id });
    expect(d.versions).toHaveLength(2); expect(d.activeVersion?.id).toBe(vid);
    const draft = d.versions.find((x) => x.id === draftId)!; expect(draft.status).toBe("draft");
    expect((draft.flags as { identityStage: string }).identityStage).toBe("off"); expect((draft.rules as { products: unknown[] }).products.length, "the draft inherits the live rules").toBe(1);
    // A draft campaign with an active version can be set live outside production (in production the validator runs first).
    await m.campaigns.setStatus.mutate({ campaignId: d.campaign.id, status: "active", reason: "test" });
    expect((await m.campaigns.get.query({ campaignId: d.campaign.id })).campaign.status).toBe("active");
    // ...and a clone carries the description.
    const cloned = await m.campaigns.clone.mutate({ campaignId: d.campaign.id, code: "EXP-2026-B" });
    expect(cloned.campaign.description).toBe("Updated.");
  });

  it("an empty installation has no campaign, so the dashboard's empty state is what everyone sees", async () => {
    const bare = await buildApp({ extractor: "simulator", seed: false }); const bh = await httpHarness(bare);
    try {
      const admin = await bare.staffToken("admin@example.test");
      expect(await bh.client(admin).campaigns.list.query()).toEqual([]);
      // The metrics query cannot pick a campaign; the console does not issue it in this state.
      expect(await bh.status(() => bh.client(admin).reports.summary.query({}))).toBe(404);
    } finally { await bh.close(); await bare.close(); }
  });
});
