// Audit findings reproduced against this tree.
//
// Each case here is a defect somebody drove to a failure, not an impression from
// reading the code. Where a case is a REGRESSION guard for a defect already
// fixed, it is marked as such and was shown to fail against the code as it stood
// before the fix.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@promo/db";
import { buildApp, type Harness } from "../helpers.ts";

describe("audit findings", () => {
  let h: Harness;
  beforeAll(async () => { h = await buildApp({ extractor: "simulator" }); });
  afterAll(async () => { await h.close(); });

  it("receipts-1: the one-purchase-one-entry guarantee rests entirely on outletMatch.required", async () => {
    // The canonical purchase identity is receiptKey(selectedOutletId, date,
    // receiptNo), and selectedOutletId is the outlet the PARTICIPANT PICKED FROM
    // A MENU, not one read off the receipt. So the same till slip, photographed
    // twice and submitted against two branches, produces two different identities
    // and nothing in the ledger collides.
    //
    // It is not exploitable on a default campaign, and that is worth stating
    // plainly: a SEPARATE rule, outlet_match, compares the printed merchant
    // against the selected branch and returns "unknown", which the precedence
    // turns into REVIEW. A human sees it. outletMatch.required defaults to true.
    //
    // What this case pins is that the guarantee is carried by that rule alone.
    // The two duplicate defences do not reach it — exact-bytes matching is
    // defeated by photographing the slip a second time, and the perceptual
    // (ahash/dhash) matches are recorded as duplicate_candidates but never change
    // a disposition; the code calls them a "search signal only". So a campaign
    // configured with outletMatch.required = false — a plausible operational
    // choice where merchant headers scan badly — silently credits one purchase
    // twice, with no review and no duplicate anywhere in the record.
    const outlets = await h.app.db.select().from(schema.outlets).where(eq(schema.outlets.retailer, "Mopani Mart"));
    expect(outlets.length, "the sample campaign has several branches of one retailer").toBeGreaterThan(1);
    const westgate = outlets.find((o) => o.branch === "Westgate")!;
    const other = outlets.find((o) => o.branch !== "Westgate")!;
    expect(westgate, "the fixture receipt header names Mopani Mart Westgate").toBeTruthy();

    // The SAME printed receipt: same number, same date, same total. Only the
    // pixels differ, which is what photographing it a second time gives you.
    const receipt = (extra: string) => h.simReceipt({ no: "TWICE-1", packs: 2, extra });
    const at = (o: typeof westgate) => `${o.retailer} ${o.branch} ${o.town}`.toLowerCase();

    // 1. With the default configuration the mismatch is caught and held.
    const phoneA = "263771000501";
    await h.register(phoneA, { first: "Dup", last: "Guarded", identity: "TESTDUP1X" });
    const guardedFirst = await h.submit(phoneA, await h.simImage(receipt("")), { outlet: at(westgate) });
    const guardedSecond = await h.submit(phoneA, await h.simImage(receipt("PLASTIC BAG 0.10\n")), { outlet: at(other) });
    expect(guardedFirst.submission?.status, "the honest submission qualifies").toBe("qualified");
    expect(guardedSecond.submission?.status, "naming another branch is held for review, not credited").toBe("review");

    // 2. Turn the one rule off, and the same two submissions both earn an entry.
    const [version] = await h.app.db.select().from(schema.campaignVersions)
      .where(and(eq(schema.campaignVersions.campaignId, h.campaign.id), eq(schema.campaignVersions.status, "active")));
    const rules = version.rules as Record<string, unknown>;
    await h.app.db.update(schema.campaignVersions)
      .set({ rules: { ...rules, outletMatch: { ...(rules.outletMatch as object), required: false } } })
      .where(eq(schema.campaignVersions.id, version.id));

    const phoneB = "263771000502";
    await h.register(phoneB, { first: "Dup", last: "Open", identity: "TESTDUP2X" });
    const openReceipt = (extra: string) => h.simReceipt({ no: "TWICE-2", packs: 2, extra });
    const openFirst = await h.submit(phoneB, await h.simImage(openReceipt("")), { outlet: at(westgate) });
    const openSecond = await h.submit(phoneB, await h.simImage(openReceipt("PLASTIC BAG 0.10\n")), { outlet: at(other) });

    const pid = (await h.app.participants.byUid(phoneB))!.id;
    const credited = await h.app.db.select().from(schema.entries)
      .where(and(eq(schema.entries.participantId, pid), eq(schema.entries.status, "active")));

    // This is the finding, recorded as the failure it is. Flip the expectation to
    // 1 when the canonical identity stops depending on a participant-supplied
    // value — for example by keying on the merchant read off the receipt, or by
    // making a perceptual match block rather than merely annotate.
    expect(
      credited.length,
      `with outletMatch.required=false, one printed receipt earned ${credited.length} entries by naming two branches ` +
      `(first=${openFirst.submission?.status}, second=${openSecond.submission?.status})`,
    ).toBe(2);

    // ...and nothing in the record marks it: no duplicate, no review, no flag.
    expect(openFirst.submission?.status).toBe("qualified");
    expect(openSecond.submission?.status).toBe("qualified");

    // Leave the campaign as it was for anything that runs after this.
    await h.app.db.update(schema.campaignVersions).set({ rules }).where(eq(schema.campaignVersions.id, version.id));
  });

  it("receipts-1a: the perceptual duplicate signal is recorded but never acted on", async () => {
    // Stated separately because it is the reason the case above is reachable at
    // all, and because it is the cheaper of the two things to change.
    const rows = await h.app.db.select().from(schema.duplicateCandidates);
    const visual = rows.filter((r) => r.kind !== "exact_bytes" && r.kind !== "canonical");
    if (!visual.length) return; // nothing visually similar in this fixture; nothing to assert
    // Every visual candidate is left "open": no disposition anywhere depends on it.
    expect(visual.every((r) => r.resolution === "open"), "visual matches never resolve to a decision").toBe(true);
  });

  it("audit-1: the chain still verifies after an event's attribution is rewritten in place", async () => {
    // Attribution IS inside the signed body — actorType and actorId are both in
    // the canonical JSON that the entry hash covers. That is better than it
    // looks at first glance and better than it needs to be for the chain itself.
    //
    // But verify() only recomputes sha256(prev + body) and compares it to the
    // stored entry hash. It never checks that the COLUMNS agree with the body it
    // just hashed — and every reader uses the columns: audit.list(), the console,
    // and anything filtering by actorId. So rewriting actor_id in place changes
    // who every consumer believes acted, while the integrity check stays green.
    const targetId = `tgt_${Math.random().toString(36).slice(2, 8)}`;
    const realActor = "stf_the_person_who_acted";
    await h.app.audit.record(h.app.db, { actorType: "staff", actorId: realActor, action: "draw.approved", targetType: "draw", targetId, reason: "approved by the second pair of eyes" });

    const before = await h.app.audit.verify();
    expect(before.ok, "the honest chain verifies").toBe(true);

    // Exactly the edit a hostile or careless operator with database access makes.
    await h.app.db.update(schema.auditEvents).set({ actorId: "stf_somebody_else" }).where(eq(schema.auditEvents.targetId, targetId));

    const after = await h.app.audit.verify();
    const [row] = await h.app.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.targetId, targetId));
    const signed = JSON.parse(row.body as string) as { actorId: string };

    // The signed body still holds the truth...
    expect(signed.actorId, "the body is untouched, so the evidence survives").toBe(realActor);
    // ...but the column every reader uses now disagrees with it...
    expect(row.actorId).toBe("stf_somebody_else");
    const listed = await h.app.audit.list({ targetType: "draw", targetId });
    expect(listed[0].actorId, "audit.list reports the rewritten actor").toBe("stf_somebody_else");
    // ...and the integrity check does not notice.
    //
    // Flip this to false once verify() cross-checks each row's columns against
    // its own signed body. The fix is small and needs no schema change: parse
    // body and compare actorType/actorId/action/targetType/targetId/reason.
    expect(
      after.ok,
      "verify() reports a clean chain even though the attribution on a draw.approved event was rewritten",
    ).toBe(true);
  });

  it("ops-1: the sample-data guard keys on the database's stamp, not the deployment's configuration", async () => {
    // The environment is recorded in schema_meta on first migration and the
    // DATABASE value governs the configuration one. That is the right call and it
    // closes the defect it was written for: a forgotten ENVIRONMENT variable
    // cannot make a production deployment seed itself, and the config default is
    // "local" rather than anything production-adjacent. Two further guards are
    // genuinely strict and keyed on the CONFIG value, so they fire no matter what
    // the database says — production refuses a simulated extractor and a
    // simulated transport at config validation, before any of this is reached.
    //
    // The residual gap is narrower and is about the other direction. tools/seed.ts
    // refuses only when `app.environment === "production"`, and app.environment is
    // the DATABASE's stamp. A database stamped staging — a staging backup restored
    // into production, or a staging database promoted — leaves the sample-data
    // guard permissive under production configuration. schema_meta is written
    // onConflictDoNothing, so the stamp is permanent and no later migration
    // corrects it.
    const [row] = await h.app.db.select().from(schema.schemaMeta).where(eq(schema.schemaMeta.key, "environment"));
    expect(row?.value, "the harness database is stamped test").toBe("test");
    await h.app.db.update(schema.schemaMeta).set({ value: "staging" }).where(eq(schema.schemaMeta.key, "environment"));

    const { createApp, loadConfig, silentLogger, SimulatorExtractor } = await import("@promo/core");
    const cfg = loadConfig({
      ENVIRONMENT: "production", DATABASE_URL: h.dbUrl, MEDIA_ROOT: h.dir, PORT: "0",
      DATA_KEY: "test-data-key-0123456789-abcdef", AUDIT_SIGNING_KEY: "test-audit-key",
      BOOTSTRAP_ADMIN_EMAIL: "admin@example.test", BOOTSTRAP_ADMIN_PASSWORD: "TestAdminPassword2026",
      EXTRACTOR: "tesseract", WHATSAPP_PROVIDER: "cloud-api",
      META_PHONE_NUMBER_ID: "1000000000", META_ACCESS_TOKEN: "t", META_APP_SECRET: "s", META_VERIFY_TOKEN: "v",
    });
    let second: Awaited<ReturnType<typeof createApp>> | null = null;
    try {
      // No transport override: createApp builds the cloud-api one from the config,
      // exactly as a real production boot would.
      second = await createApp({ config: cfg, log: silentLogger(), extractor: new SimulatorExtractor() });
      expect(cfg.ENVIRONMENT, "the operator deployed this as production").toBe("production");
      // Flip this to "production" when the resolution takes the STRICTER of the
      // two, or when a mismatch refuses to boot instead of logging a warning.
      expect(
        second.environment,
        "a production deployment reports the database's weaker stamp, so `seed.ts`'s production check does not fire",
      ).toBe("staging");
    } finally {
      await second?.close();
      await h.app.db.update(schema.schemaMeta).set({ value: "test" }).where(eq(schema.schemaMeta.key, "environment"));
    }
  });
});
