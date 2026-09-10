import { describe, it, expect } from "vitest";
import { evaluate } from "../../packages/core/src/eligibility/rules.ts";
import { Rules } from "../../packages/core/src/campaign/types.ts";
import { emptyFacts, type Facts } from "../../packages/core/src/extraction/types.ts";
const rules = Rules.parse({ products: [{ code: "SV2", name: "Sweetvale Brown Sugar 2kg", aliases: ["brown sugar"], packGrams: 2000, qualifying: true }, { code: "SV1", name: "Sweetvale Brown Sugar 1kg", aliases: ["brown sugar 1kg"], packGrams: 1000, qualifying: true }] });
const ctx = { intakeAt: "2026-10-10T10:00:00Z", campaignOpen: true, windowStart: "2026-09-01T00:00:00Z", windowEnd: "2027-01-01T00:00:00Z", selectedOutletId: "o1", selectedOutletParticipating: true, enrolled: true, participantActive: true, periodEntryCount: 0, campaignEntryCount: 0, imageQuality: {} };
const facts = (over: Partial<Facts> & { lines?: Facts["lines"] } = {}): Facts => ({ ...emptyFacts("t", "m"), document: { kind: "receipt", score: 0.9, signals: {} }, merchant: { text: "Mopani", candidates: [{ outletId: "o1", score: 1, basis: "alias" }] }, transaction: { receiptNo: "1", receiptNoRaw: "1", till: null, date: "2026-10-05", dateRaw: "05/10/2026", dateAmbiguous: false, time: null, currency: "USD", totalMinor: 620, totalRaw: "TOTAL 6.20" }, lines: [{ n: 1, raw: "x", description: "SWEETVALE BROWN SUGAR 2KG", quantity: 2, packGrams: 2000, unitMinor: 310, amountMinor: 620, voided: false, product: { code: "SV2", packGrams: 2000, basis: "brown sugar" } }], ...over });
describe("eligibility rules (integer grams, deterministic)", () => {
  it("two 2 kg packs qualify with one unit; one pack fails; three packs still one unit", () => {
    expect(evaluate(facts(), rules, ctx)).toMatchObject({ disposition: "qualified", units: 1, primaryPacks: 2 });
    expect(evaluate(facts({ lines: [{ ...facts().lines[0], quantity: 1 }] }), rules, ctx)).toMatchObject({ disposition: "not_qualified", reason: "below_minimum" });
    expect(evaluate(facts({ lines: [{ ...facts().lines[0], quantity: 3 }] }), rules, ctx)).toMatchObject({ disposition: "qualified", units: 1, primaryPacks: 3 });
  });
  it("voided lines do not count; wrong product fails; unknown quantity reviews", () => {
    expect(evaluate(facts({ lines: [{ ...facts().lines[0], voided: true }] }), rules, ctx).reason).toBe("no_qualifying_product");
    expect(evaluate(facts({ lines: [{ ...facts().lines[0], product: null }] }), rules, ctx).reason).toBe("no_qualifying_product");
    expect(evaluate(facts({ lines: [{ ...facts().lines[0], quantity: null }] }), rules, ctx)).toMatchObject({ disposition: "review", reason: "quantity_unreadable" });
  });
  it("mixed pack sizes qualify only when the rule allows it", () => {
    const four1kg = facts({ lines: [{ ...facts().lines[0], description: "BROWN SUGAR 1KG", quantity: 4, packGrams: 1000, product: { code: "SV1", packGrams: 1000, basis: "brown sugar 1kg" } }] });
    expect(evaluate(four1kg, rules, ctx).disposition).toBe("not_qualified");
    expect(evaluate(four1kg, Rules.parse({ ...rules, qualification: { ...rules.qualification, allowMixedPacks: true } }), ctx).disposition).toBe("qualified");
  });
  it("dates: outside window fails; ambiguous straddling the window reviews; unreadable reviews", () => {
    expect(evaluate(facts({ transaction: { ...facts().transaction, date: "2026-08-20" } }), rules, ctx).reason).toBe("date_outside_window");
    expect(evaluate(facts({ transaction: { ...facts().transaction, date: "2026-06-10", dateAmbiguous: true } }), rules, ctx)).toMatchObject({ disposition: "review", reason: "date_ambiguous" });
    expect(evaluate(facts({ transaction: { ...facts().transaction, date: "2026-10-06", dateAmbiguous: true } }), rules, ctx).disposition).toBe("qualified");
    expect(evaluate(facts({ transaction: { ...facts().transaction, date: null } }), rules, ctx).reason).toBe("date_unreadable");
  });
  it("outlet: mismatch or unreadable header reviews; non-participating fails", () => {
    expect(evaluate(facts({ merchant: { text: "x", candidates: [{ outletId: "o2", score: 0.9, basis: "" }] } }), rules, ctx).reason).toBe("outlet_mismatch");
    expect(evaluate(facts({ merchant: { text: null, candidates: [] } }), rules, ctx).reason).toBe("outlet_unreadable");
    expect(evaluate(facts(), rules, { ...ctx, selectedOutletParticipating: false }).reason).toBe("outlet_not_participating");
  });
  it("non-receipts and unreadable images are re-upload cases, never a business rejection", () => {
    expect(evaluate(facts({ document: { kind: "non_receipt", score: 0, signals: {} }, lines: [] }), rules, ctx)).toMatchObject({ disposition: "reupload", reason: "not_a_receipt" });
    expect(evaluate(facts({ document: { kind: "unknown", score: 0.3, signals: {} } }), rules, { ...ctx, imageQuality: { blurry: true } })).toMatchObject({ disposition: "reupload", reason: "image_unreadable" });
  });
  it("caps only when approved; missing identity fields review; low OCR confidence reviews", () => {
    expect(evaluate(facts(), Rules.parse({ ...rules, caps: { perParticipantPerPeriod: 1, perParticipantCampaign: null } }), { ...ctx, periodEntryCount: 1 }).reason).toBe("entry_cap_reached");
    expect(evaluate(facts({ transaction: { ...facts().transaction, receiptNo: null } }), rules, ctx).reason).toBe("receipt_number_unreadable");
    expect(evaluate(facts({ quality: { missing: [], warnings: [], confidence: 0.1, injectionSuspected: false } }), rules, ctx).disposition).toBe("review");
    expect(evaluate(facts({ quality: { missing: [], warnings: ["witness_receipt_no_disagreement"], confidence: null, injectionSuspected: false } }), rules, ctx).disposition).toBe("review");
  });
});
