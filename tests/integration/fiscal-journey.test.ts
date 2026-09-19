// The ZIMRA-first path end to end: QR on the image -> FDMS lookup -> authoritative
// record -> reconciliation against the photograph -> tier decision -> ledger.
// Uses the simulated fiscal authority (refused outside local/test) and the
// labelled simulated extractor.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@promo/db";
import { buildApp, type Harness } from "../helpers.ts";

// Packed ZIMRA-shaped tail: device(10) + fiscalDay(4) + receiptGlobalNo(10) +
// verificationCode(16). The verification code is unique per transaction, as it
// is in reality — it is derived from the receipt's device signature.
const CODE = (globalNo: string) => `1A2B3C4D5E6F${globalNo.slice(-4)}`;
const QR = (globalNo: string) => `https://fdms.example.test/#000001234500180${globalNo}${CODE(globalNo)}`;
const REF = (globalNo: string) => ({ deviceId: "0000012345", receiptGlobalNo: `0${globalNo}`, verificationCode: CODE(globalNo) });

describe("ZIMRA-first verification", () => {
  let h: Harness;
  const P = "263773000001", P2 = "263773000002";
  beforeAll(async () => {
    h = await buildApp({ extractor: "simulator", fiscal: true });
    await h.register(P, { first: "Fiscal", last: "One", identity: "TESTFSC1X" });
    await h.register(P2, { first: "Fiscal", last: "Two", identity: "TESTFSC2X" });
  });
  afterAll(async () => { await h.close(); });

  const fiscalFor = (id: string) => h.db.select().from(schema.fiscalVerifications).where(eq(schema.fiscalVerifications.submissionId, id)).then((r) => r[0] ?? null);

  it("tier 1: the authority confirms the invoice, the photograph agrees, the entry is awarded on FDMS authority", async () => {
    const globalNo = "000000101";
    h.fiscalSim.register(REF(globalNo), {
      validated: true, invoiceNo: "0101", merchantName: "Mopani Mart", branchName: "Westgate",
      txnAt: "2026-09-19T14:22:00Z", txnDate: "2026-09-19", currency: "USD", totalMinor: 620, taxMinor: 81,
      lines: [{ n: 1, description: "SWEETVALE BROWN SUGAR 2KG", code: null, quantity: 2, unitMinor: 310, amountMinor: 620, taxPercent: 15 }],
    });
    const text = h.simReceipt({ no: "0101", date: "19/09/2026" });
    const r = await h.submit(P, await h.fiscalImage(text, QR(globalNo)));

    expect(r.submission?.status).toBe("qualified");
    expect(r.submission?.verificationTier).toBe("tier_1");
    expect(r.submission?.authority).toBe("zimra_fdms");
    expect(r.submission?.fiscalStatus).toBe("valid");

    const fv = await fiscalFor(r.submissionId!);
    expect(fv?.status).toBe("valid");
    expect(fv?.deviceId).toBe("0000012345");
    expect(fv?.merchantName).toBe("Mopani Mart");
    // The decoded URL is never stored — only its hash.
    expect(JSON.stringify(fv)).not.toContain("fdms.example.test/#");
    expect(fv?.qrPayloadSha256).toMatch(/^[a-f0-9]{64}$/);

    // The canonical identity is the fiscal one, not outlet|date|number.
    const [canonical] = await h.db.select().from(schema.canonicalReceipts).where(eq(schema.canonicalReceipts.id, r.submission!.canonicalReceiptId!));
    expect(canonical.receiptKey).toMatch(/^zimra:0000012345:18:/);
  });

  it("the same fiscal transaction from another phone is refused on the authority's identifiers alone", async () => {
    const globalNo = "000000101";
    // A different photograph of the same till slip: different bytes, different
    // OCR, same transaction. Nothing about the image is what catches it.
    const r = await h.submit(P2, await h.fiscalImage(h.simReceipt({ no: "0101", date: "19/09/2026", extra: "PLASTIC BAG 0.10\n" }), QR(globalNo)));
    expect(r.submission?.status).toBe("duplicate");
    const cands = await h.db.select().from(schema.duplicateCandidates).where(eq(schema.duplicateCandidates.submissionId, r.submissionId!));
    expect(cands.some((c) => c.kind === "fiscal_identity")).toBe(true);
  });

  it("tier 2: the authority confirms the invoice but the photograph disagrees materially, so a human looks", async () => {
    const globalNo = "000000102";
    h.fiscalSim.register(REF(globalNo), {
      validated: true, invoiceNo: "0102", merchantName: "Mopani Mart", branchName: "Westgate",
      txnAt: "2026-09-19T15:00:00Z", txnDate: "2026-09-19", currency: "USD", totalMinor: 620,
      lines: [{ n: 1, description: "SWEETVALE BROWN SUGAR 2KG", code: null, quantity: 2, unitMinor: 310, amountMinor: 620, taxPercent: 15 }],
    });
    // The paper says a very different total from the one the till transmitted.
    const r = await h.submit(P, await h.fiscalImage(h.simReceipt({ no: "0102", date: "19/09/2026", packs: 9 }), QR(globalNo)));
    expect(r.submission?.status).toBe("review");
    expect(r.submission?.verificationTier).toBe("tier_2");
    expect(r.submission?.reasonCode).toBe("fiscal_receipt_mismatch");

    const [outcome] = await h.db.select().from(schema.verificationOutcomes).where(eq(schema.verificationOutcomes.submissionId, r.submissionId!));
    expect(outcome.automatedTier).toBe("tier_2");
    expect((outcome.discrepancies as unknown[]).length).toBeGreaterThan(0);
    expect((outcome.evidence as { receiptMatch?: string }).receiptMatch).toBe("DISPUTED");
  });

  it("an invoice the authority will not confirm is never awarded automatically", async () => {
    const globalNo = "000000103";
    h.fiscalSim.register(REF(globalNo), { validated: false, invoiceNo: "0103" });
    const r = await h.submit(P, await h.fiscalImage(h.simReceipt({ no: "0103" }), QR(globalNo)));
    expect(r.submission?.status).toBe("review");
    expect(r.submission?.reasonCode).toBe("fiscal_invalid");
    expect(r.submission?.fiscalStatus).toBe("invalid");
  });

  it("an authority outage degrades to the image evidence rather than stopping intake", async () => {
    const globalNo = "000000104";
    h.fiscalSim.fail(REF(globalNo), "simulated FDMS outage");
    const r = await h.submit(P, await h.fiscalImage(h.simReceipt({ no: "0104" }), QR(globalNo)));
    expect(r.submission?.fiscalStatus).toBe("unavailable");
    // Still decided, on the strength of the photograph alone.
    expect(r.submission?.status).toBe("qualified");
    expect(r.submission?.verificationTier).toBe("tier_3");
    expect(r.submission?.authority).toBe("ocr");
  });

  it("a receipt with no fiscal code takes the OCR path and says so", async () => {
    const r = await h.submit(P, await h.simImage(h.simReceipt({ no: "0105" })));
    expect(r.submission?.fiscalStatus).toBe("no_code");
    expect(r.submission?.status).toBe("qualified");
    expect(r.submission?.verificationTier).toBe("tier_3");
  });

  it("a QR that is not a fiscal reference is reported as such and never fetched", async () => {
    const r = await h.submit(P, await h.fiscalImage(h.simReceipt({ no: "0106" }), "https://attacker.example/pretend-receipt"));
    expect(r.submission?.fiscalStatus).toBe("unsupported_code");
    const fv = await fiscalFor(r.submissionId!);
    expect(fv?.status).toBe("unsupported_code");
    expect(fv?.merchantName).toBeNull();
    expect(fv?.totalMinor).toBeNull();
  });

  it("the reviewer is handed the whole evidence chain, with each value's source named", async () => {
    const globalNo = "000000107";
    h.fiscalSim.register(REF(globalNo), {
      validated: true, merchantName: "Mopani Mart", branchName: "Westgate", txnDate: "2026-09-19",
      currency: "USD", totalMinor: 620,
      lines: [{ n: 1, description: "SWEETVALE BROWN SUGAR 2KG", code: null, quantity: 2, unitMinor: 310, amountMinor: 620, taxPercent: 15 }],
    });
    const r = await h.submit(P, await h.fiscalImage(h.simReceipt({ no: "0107", date: "19/09/2026" }), QR(globalNo)));
    const [x] = await h.db.select().from(schema.extractions).where(eq(schema.extractions.submissionId, r.submissionId!));
    const facts = x.facts as { ledger?: { fields?: Record<string, { source: string; status: string }>; authority?: string }; report?: Record<string, unknown> };

    expect(facts.ledger?.authority).toBe("zimra_fdms");
    expect(facts.ledger?.fields?.total?.source).toBe("zimra_fdms");
    expect(facts.ledger?.fields?.total?.status).toBe("verified"); // the photograph agrees
    expect(facts.report).toMatchObject({ status: "QUALIFIED", source: "zimra_fdms", fiscalStatus: "valid", receiptMatch: "CONFIRMED", duplicateCheck: "PASS" });
    // The verdict is a set of stated components, not one opaque score.
    expect(Array.isArray((facts.report as { rationale?: string[] }).rationale)).toBe(true);
    expect(facts.report).not.toHaveProperty("confidence");
  });
});
