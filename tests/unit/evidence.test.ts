import { describe, expect, it } from "vitest";
import { EvidenceLedger, SOURCE_AUTHORITY, sameValue } from "@promo/core/fiscal/evidence.ts";
import { decideTier, duplicateRisk, anomalyRisk, verificationReport, type DuplicateSignal, type TierInput } from "@promo/core/fiscal/tiers.ts";
import type { Evaluation } from "@promo/core/eligibility/rules.ts";

const noDuplicates: DuplicateSignal = { fiscalIdentityCredited: false, fiscalIdentityOpen: 0, exactImageCredited: false, exactImage: 0, visualImage: 0, canonicalCredited: false, crossParticipant: false };
const passed = (over: Partial<Evaluation> = {}): Evaluation => ({ disposition: "qualified", reason: "ok", rules: [], primaryPacks: 2, totalGrams: 4000, matched: [], units: 1, ...over });

const input = (over: Partial<TierInput> = {}): TierInput => ({
  ledger: new EvidenceLedger(), fiscalStatus: "not_attempted", authoritative: false, evaluation: passed(),
  discrepancies: [], duplicates: noDuplicates, verification: null, missing: [], userCompleted: true, autoQualifyPaused: false, ...over,
});

describe("evidence ledger", () => {
  it("ranks the revenue authority above the image, OCR, the model and the participant", () => {
    expect(SOURCE_AUTHORITY.zimra_fdms).toBeGreaterThan(SOURCE_AUTHORITY.receipt_image);
    expect(SOURCE_AUTHORITY.receipt_image).toBeGreaterThan(SOURCE_AUTHORITY.ocr);
    expect(SOURCE_AUTHORITY.ocr).toBeGreaterThan(SOURCE_AUTHORITY.ai);
    expect(SOURCE_AUTHORITY.ai).toBeGreaterThan(SOURCE_AUTHORITY.user);
  });

  it("resolves to the highest authority and records who agreed", () => {
    const l = new EvidenceLedger();
    l.observe("branch", "ocr", "Borrowdale").observe("branch", "zimra_fdms", "Borrowdale").observe("branch", "user", "Borrowdale");
    const r = l.resolve("branch");
    expect(r.source).toBe("zimra_fdms");
    expect(r.status).toBe("verified");
    expect(r.agreedBy).toEqual(expect.arrayContaining(["ocr", "user"]));
  });

  it("never lets the participant overwrite the authority — it records the conflict", () => {
    const l = new EvidenceLedger();
    l.observe("branch", "zimra_fdms", "Avondale").observe("branch", "receipt_image", "Avondale").observe("branch", "user", "Borrowdale");
    const r = l.resolve("branch");
    expect(r.value).toBe("Avondale");
    expect(r.status).toBe("conflicted");
    expect(r.conflicts).toEqual([{ source: "user", value: "Borrowdale" }]);
  });

  it("marks a single uncorroborated source as such", () => {
    const l = new EvidenceLedger();
    l.observe("branch", "user", "Borrowdale");
    expect(l.resolve("branch").status).toBe("single_source");
  });

  it("reports what nothing asserted", () => {
    const l = new EvidenceLedger();
    l.observe("date", "ocr", "2026-09-19");
    expect(l.missing(["date", "outletId", "receiptNo"])).toEqual(["outletId", "receiptNo"]);
  });

  it("grades a disagreement on a field that changes the outcome as material", () => {
    const l = new EvidenceLedger();
    l.observe("total", "zimra_fdms", 1498).observe("total", "ocr", 9999);
    l.observe("merchant", "zimra_fdms", "Mopani Mart").observe("merchant", "ocr", "Something else");
    const d = l.discrepancies();
    expect(d.find((x) => x.field === "total")!.severity).toBe("material");
    expect(d.find((x) => x.field === "merchant")!.severity).toBe("minor");
  });

  it("tolerates rounding on amounts and formatting on names", () => {
    expect(sameValue("total", 1498, 1499)).toBe(true);
    expect(sameValue("total", 1498, 1600)).toBe(false);
    // Branch and merchant names are printed inconsistently, so containment
    // counts as agreement for those two — and only those two.
    expect(sameValue("branch", "Westgate Branch", "WESTGATE BR")).toBe(true);
    expect(sameValue("branch", "Mopani Westgate", "westgate")).toBe(true);
    expect(sameValue("branch", "Westgate", "Avondale")).toBe(false);
    expect(sameValue("date", "2026-09-19", "2026-09")).toBe(false);
    expect(sameValue("receiptNo", "R-12345", "r12345")).toBe(true);
  });
});

describe("decision hierarchy", () => {
  it("tier 1: authority confirmed, image agrees, rules satisfied -> qualify", () => {
    const l = new EvidenceLedger().observe("date", "zimra_fdms", "2026-09-19").observe("date", "ocr", "2026-09-19");
    const d = decideTier(input({ ledger: l, fiscalStatus: "valid", authoritative: true }));
    expect(d.tier).toBe("tier_1");
    expect(d.disposition).toBe("qualified");
  });

  it("tier 2: authority confirmed but the paper disagrees materially -> review", () => {
    const l = new EvidenceLedger().observe("total", "zimra_fdms", 1498).observe("total", "ocr", 9999);
    const d = decideTier(input({ ledger: l, fiscalStatus: "valid", authoritative: true, discrepancies: l.discrepancies() }));
    expect(d.tier).toBe("tier_2");
    expect(d.disposition).toBe("review");
    expect(d.reason).toBe("fiscal_receipt_mismatch");
  });

  it("tier 3: no authority, consistent image evidence, rules satisfied -> qualify", () => {
    const l = new EvidenceLedger().observe("date", "ocr", "2026-09-19");
    const d = decideTier(input({ ledger: l, fiscalStatus: "no_code" }));
    expect(d.tier).toBe("tier_3");
    expect(d.disposition).toBe("qualified");
  });

  it("tier 4: something is missing and the participant has not answered -> wait for them", () => {
    const d = decideTier(input({ missing: ["outletId"], userCompleted: false }));
    expect(d.tier).toBe("tier_4");
    expect(d.reason).toBe("awaiting_participant");
  });

  it("tier 5: a model hold routes to a human without changing the rules verdict", () => {
    const d = decideTier(input({ verification: { status: "complete", decision: "hold", risk: "medium", provider: "p", model: "m", promptVersion: "v", latencyMs: 1, modelProbability: null, calibratedProbability: null, riskScore: 0.4, dimensions: [], supportingEvidence: [], contradictoryEvidence: [], anomalies: [] } }));
    expect(d.tier).toBe("tier_5");
    expect(d.reason).toBe("ai_verification_hold");
  });

  it("tier 6: a fiscal identity that already earned an entry is a duplicate, whatever else passed", () => {
    const d = decideTier(input({ fiscalStatus: "valid", authoritative: true, duplicates: { ...noDuplicates, fiscalIdentityCredited: true } }));
    expect(d.tier).toBe("tier_6");
    expect(d.disposition).toBe("duplicate");
  });

  it("an identical image that was never credited is a risk, not a rejection", () => {
    // A re-upload we ourselves asked for is byte-identical to the original.
    // Rejecting it as a duplicate would refuse the very thing we requested.
    const d = decideTier(input({ duplicates: { ...noDuplicates, exactImage: 1 } }));
    expect(d.disposition).not.toBe("duplicate");
    expect(d.duplicateRisk).toBe("medium");
  });

  it("tier 6: the authority refusing to confirm the invoice is never an automatic qualification", () => {
    const d = decideTier(input({ fiscalStatus: "invalid" }));
    expect(d.tier).toBe("tier_6");
    expect(d.reason).toBe("fiscal_invalid");
  });

  it("a genuine receipt that fails a campaign rule is still rejected", () => {
    const d = decideTier(input({ fiscalStatus: "valid", authoritative: true, evaluation: passed({ disposition: "not_qualified", reason: "below_minimum" }) }));
    expect(d.disposition).toBe("not_qualified");
    expect(d.reason).toBe("below_minimum");
  });

  it("a paused campaign never auto-qualifies", () => {
    const d = decideTier(input({ fiscalStatus: "valid", authoritative: true, autoQualifyPaused: true }));
    expect(d.disposition).toBe("review");
    expect(d.reason).toBe("auto_qualification_paused");
  });

  it("grades duplicate and anomaly risk from evidence rather than a self-reported score", () => {
    expect(duplicateRisk({ ...noDuplicates, fiscalIdentityCredited: true })).toBe("high");
    expect(duplicateRisk({ ...noDuplicates, fiscalIdentityOpen: 1 })).toBe("high");
    expect(duplicateRisk({ ...noDuplicates, visualImage: 1 })).toBe("medium");
    expect(duplicateRisk(noDuplicates)).toBe("none");
    expect(anomalyRisk({ discrepancies: [{ field: "total", authority: "zimra_fdms", authorityValue: 1, source: "ocr", sourceValue: 2, severity: "material" }, { field: "date", authority: "zimra_fdms", authorityValue: 1, source: "ocr", sourceValue: 2, severity: "material" }], verification: null, evaluation: null })).toBe("high");
  });

  it("reports every component of the verdict separately", () => {
    const l = new EvidenceLedger().observe("date", "zimra_fdms", "2026-09-19").observe("date", "ocr", "2026-09-19");
    const i = input({ ledger: l, fiscalStatus: "valid", authoritative: true });
    const report = verificationReport(decideTier(i), i);
    expect(report).toMatchObject({ status: "QUALIFIED", tier: "tier_1", source: "zimra_fdms", fiscalStatus: "valid", receiptMatch: "CONFIRMED", promotionRequirements: "SATISFIED", duplicateCheck: "PASS", anomalyRisk: "NONE" });
    expect(report.rationale.length).toBeGreaterThan(0);
  });
});
