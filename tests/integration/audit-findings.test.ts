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

  it("audit-1 (fixed): rewriting an event's attribution in place is detected", async () => {
    // Attribution is inside the signed body — actorType and actorId are both in
    // the canonical JSON the entry hash covers. verify() used to recompute only
    // sha256(prev + body) and never check that the COLUMNS agreed with the body
    // it had just hashed, and every reader uses the columns: audit.list(), the
    // console, anything filtering by actorId. So rewriting actor_id in place
    // changed who the system said approved a draw while the chain reported clean.
    const targetId = `tgt_${Math.random().toString(36).slice(2, 8)}`;
    const realActor = "stf_the_person_who_acted";
    await h.app.audit.record(h.app.db, { actorType: "staff", actorId: realActor, action: "draw.approved", targetType: "draw", targetId, reason: "approved by the second pair of eyes" });

    expect((await h.app.audit.verify()).ok, "the honest chain verifies").toBe(true);

    // Exactly the edit a hostile or careless operator with database access makes.
    await h.app.db.update(schema.auditEvents).set({ actorId: "stf_somebody_else" }).where(eq(schema.auditEvents.targetId, targetId));

    const after = await h.app.audit.verify();
    const [row] = await h.app.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.targetId, targetId));
    const signed = JSON.parse(row.body as string) as { actorId: string };

    // The body still holds the truth, and now the verifier says the row disagrees
    // with it rather than passing the edit through in silence.
    expect(signed.actorId, "the body is untouched, so the evidence survives").toBe(realActor);
    expect(after.ok).toBe(false);
    const finding = after.broken.find((b) => b.id === row.id);
    expect(finding?.what).toBe("body_column_mismatch");
    expect(finding?.fields).toContain("actorId");
    // ...and only the field that was actually changed is named.
    expect(finding?.fields).toEqual(["actorId"]);

    // Put it back; the chain is clean again, which also shows the check is keyed
    // on the disagreement and not on the row simply having been written to.
    await h.app.db.update(schema.auditEvents).set({ actorId: realActor }).where(eq(schema.auditEvents.targetId, targetId));
    expect((await h.app.audit.verify()).ok).toBe(true);
  });

  it("audit-1 (fixed): every other signed field is covered too, and honest rows stay clean", async () => {
    // A guard that only watched actorId would be trivially sidestepped by editing
    // the action or the target instead.
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["action", { action: "draw.rejected" }, "action"],
      ["targetType", { targetType: "winner" }, "targetType"],
      ["reason", { reason: "a different reason entirely" }, "reason"],
      ["actorType", { actorType: "system" }, "actorType"],
      ["payload", { payload: { injected: true } }, "payload"],
    ];
    for (const [name, patch, field] of cases) {
      const targetId = `tgt_${name}_${Math.random().toString(36).slice(2, 8)}`;
      await h.app.audit.record(h.app.db, { actorType: "staff", actorId: "stf_a", action: "draw.approved", targetType: "draw", targetId, reason: "original", payload: { original: true } });
      const [row] = await h.app.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.targetId, targetId));
      await h.app.db.update(schema.auditEvents).set(patch).where(eq(schema.auditEvents.id, row.id));
      const r = await h.app.audit.verify();
      const finding = r.broken.find((b) => b.id === row.id);
      expect(finding?.fields, `editing ${name} in place must be named`).toContain(field);
      await h.app.db.update(schema.auditEvents).set({ actorType: "staff", action: "draw.approved", targetType: "draw", reason: "original", payload: { original: true } }).where(eq(schema.auditEvents.id, row.id));
    }
    // The whole chain — several hundred honest events written by the fixtures
    // above — must still verify. A cross-check that cries wolf is worse than none,
    // and the timestamp is the field most likely to: Postgres returns timestamptz
    // as "2026-09-16 12:11:07.067+00" while the body carries the same instant as
    // "2026-09-16T12:11:07.067Z", so they are compared as instants, not strings.
    const final = await h.app.audit.verify();
    expect(final.ok, `honest chain reported ${final.brokenCount} broken: ${JSON.stringify(final.broken.slice(0, 3))}`).toBe(true);
    expect(final.total).toBeGreaterThan(20);
  });

  it("audit-1 (fixed): the stored payload is exactly what the body signed", async () => {
    // canonicalJson maps undefined to null and KEEPS the key; the driver's
    // JSON.stringify DROPS an undefined key on the way into jsonb. So a payload
    // carrying an undefined was signed one way and stored another, and the column
    // was never a faithful copy of the signed evidence. Nobody was misled about
    // who acted, but the cross-check above cannot be strict while that is true.
    const targetId = `tgt_${Math.random().toString(36).slice(2, 8)}`;
    await h.app.audit.record(h.app.db, {
      actorType: "staff", actorId: "stf_a", action: "staff.update", targetType: "staff_user", targetId,
      payload: { name: undefined, roles: undefined, status: "disabled" } as Record<string, unknown>,
    });
    const [row] = await h.app.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.targetId, targetId));
    const signed = JSON.parse(row.body as string) as { payload: Record<string, unknown> };
    expect(signed.payload, "the body normalises undefined to an explicit null").toEqual({ name: null, roles: null, status: "disabled" });
    expect(row.payload, "and the column now holds the same value rather than dropping the keys").toEqual(signed.payload);
    expect((await h.app.audit.verify()).ok).toBe(true);
  });

  it("audit-1 (fixed): treating a dropped null as equal does not hide a changed value", async () => {
    // The comparison strips null-valued keys so rows written before the writer
    // was fixed — an explicit null in the body, no key in the column — do not all
    // report as tampered with. That tolerance must not extend to a real edit.
    const targetId = `tgt_${Math.random().toString(36).slice(2, 8)}`;
    await h.app.audit.record(h.app.db, {
      actorType: "staff", actorId: "stf_a", action: "staff.update", targetType: "staff_user", targetId,
      payload: { status: "disabled", roles: null } as Record<string, unknown>,
    });
    const [row] = await h.app.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.targetId, targetId));

    // Dropping the null key is tolerated — it carries no information.
    await h.app.db.update(schema.auditEvents).set({ payload: { status: "disabled" } }).where(eq(schema.auditEvents.id, row.id));
    expect((await h.app.audit.verify()).ok, "an absent key and an explicit null are the same statement").toBe(true);

    // Changing the value that matters is not.
    await h.app.db.update(schema.auditEvents).set({ payload: { status: "active" } }).where(eq(schema.auditEvents.id, row.id));
    const after = await h.app.audit.verify();
    expect(after.ok).toBe(false);
    expect(after.broken.find((b) => b.id === row.id)?.fields).toContain("payload");

    // Giving a real key a null value is not tolerated either: the other side
    // still holds the value, so the two no longer agree.
    await h.app.db.update(schema.auditEvents).set({ payload: { status: null } }).where(eq(schema.auditEvents.id, row.id));
    expect((await h.app.audit.verify()).ok, "nulling out a recorded value is a change").toBe(false);

    await h.app.db.update(schema.auditEvents).set({ payload: { status: "disabled", roles: null } }).where(eq(schema.auditEvents.id, row.id));
    expect((await h.app.audit.verify()).ok).toBe(true);
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
