import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { decodeReceiptCodes } from "@promo/core/extraction/qr.ts";
import { parseFiscalQr, unpackTail, fiscalIdentity, DEFAULT_QR_LAYOUT } from "@promo/core/fiscal/zimra-qr.ts";
import { mapFiscalRecord, readValidated, HttpFdmsAdapter, NoFdmsAdapter } from "@promo/core/fiscal/fdms.ts";
import { validateOutboundUrl, SafeFetchRefused } from "@promo/core/util/safe-fetch.ts";
import { FIXTURE_VALUE } from "../../tools/gen-qr-fixture.ts";

const ref = (over: Record<string, unknown> = {}) => ({ raw: "x", sha256: "h", format: "QR_CODE", host: "fdms.example.test", deviceId: "0000012345", fiscalDayNo: 18, receiptGlobalNo: "0000000077", verificationCode: "1A2B3C4D5E6F7A8B", qrDate: null, ...over });

describe("ZIMRA fiscal QR references", () => {
  it("decodes the fiscal QR fixture off a real image", async () => {
    const image = await fs.readFile("tests/fixtures/zimra-fiscal-qr.png");
    const found = await decodeReceiptCodes(image);
    expect(found).toHaveLength(1);
    expect(found[0].text).toBe(FIXTURE_VALUE);
  });

  it("parses the packed tail into transaction identifiers", () => {
    const r = parseFiscalQr(FIXTURE_VALUE);
    expect(r).not.toBeNull();
    expect(r!.deviceId).toBe("0000012345");
    expect(r!.fiscalDayNo).toBe(18);
    expect(r!.receiptGlobalNo).toBe("0000000077");
    expect(r!.verificationCode).toBe("1A2B3C4D5E6F7A8B");
    expect(r!.host).toBe("fdms.example.test");
  });

  it("prefers explicit query parameters over the packed tail", () => {
    const r = parseFiscalQr("https://fdms.example.test/verify?deviceID=0000099999&fiscalDayNo=7&receiptGlobalNo=0000000042&qrCode=DEADBEEFDEADBEEF");
    expect(r!.deviceId).toBe("0000099999");
    expect(r!.fiscalDayNo).toBe(7);
    expect(r!.receiptGlobalNo).toBe("0000000042");
    expect(r!.verificationCode).toBe("DEADBEEFDEADBEEF");
  });

  it("refuses a code that is not a fiscal reference", () => {
    expect(parseFiscalQr("https://example.test/promo/win")).toBeNull();
    expect(parseFiscalQr("6001234567890")).toBeNull();
    expect(parseFiscalQr("")).toBeNull();
  });

  it("refuses a packed tail whose numeric groups are not numeric, rather than mis-slicing it", () => {
    // If the configured widths are wrong every identifier is offset, and a
    // silently misaligned identity is worse than no identity at all.
    expect(unpackTail("ABCDEFGHIJ0018000000007712345678", DEFAULT_QR_LAYOUT)).toEqual({});
  });

  it("builds a stable identity for duplicate detection", () => {
    expect(fiscalIdentity({ deviceId: "1", fiscalDayNo: 2, receiptGlobalNo: "3", verificationCode: "X" })).toBe("zimra:1:2:3");
    expect(fiscalIdentity({ deviceId: null, fiscalDayNo: null, receiptGlobalNo: null, verificationCode: "ABC" })).toBe("zimra-vc:ABC");
    expect(fiscalIdentity({ deviceId: null, fiscalDayNo: null, receiptGlobalNo: null, verificationCode: null })).toBeNull();
  });
});

describe("FDMS response mapping", () => {
  it("treats only an explicit affirmative as validated", () => {
    expect(readValidated({ validationStatus: "VALID" })).toBe(true);
    expect(readValidated({ status: "Invalid" })).toBe(false);
    expect(readValidated({ status: "PENDING" })).toBe(false);
    expect(readValidated({})).toBe(false);
  });

  it("maps a validation response onto the contract, in minor units", () => {
    const rec = mapFiscalRecord({
      validationStatus: "VALID",
      receipt: {
        receiptGlobalNo: "0000000077", fiscalDayNo: 18, deviceID: "0000012345", invoiceNo: "INV-4512",
        sellerName: "Mopani Mart", branchName: "Westgate", receiptDate: "2026-09-19T14:22:00Z",
        currency: "USD", receiptTotal: "14.98", taxAmount: 1.95,
        receiptLines: [{ receiptLineName: "SWEETVALE BROWN SUGAR 2KG", receiptLineQuantity: 2, receiptLinePrice: "3.10", receiptLineTotal: "6.20" }],
      },
    }, ref() as never);
    expect(rec.validated).toBe(true);
    expect(rec.totalMinor).toBe(1498);
    expect(rec.taxMinor).toBe(195);
    expect(rec.txnDate).toBe("2026-09-19");
    expect(rec.merchantName).toBe("Mopani Mart");
    expect(rec.lines[0].amountMinor).toBe(620);
    expect(rec.lines[0].quantity).toBe(2);
  });
});

describe("outbound fetch policy", () => {
  it("refuses any host when the allowlist is empty", async () => {
    // This is the control. An empty allowlist must mean "we did not look",
    // never "look wherever the receipt says".
    await expect(validateOutboundUrl("https://attacker.example/x", [], true)).rejects.toBeInstanceOf(SafeFetchRefused);
  });
  it("refuses non-HTTPS, credentials, odd ports and private addresses", async () => {
    for (const url of ["http://fdms.example.test/x", "https://u:p@fdms.example.test/x", "https://fdms.example.test:8443/x", "https://127.0.0.1/x", "https://10.0.0.5/x", "https://[::1]/x"]) {
      await expect(validateOutboundUrl(url, ["fdms.example.test", "127.0.0.1", "10.0.0.5", "::1"], true)).rejects.toBeInstanceOf(SafeFetchRefused);
    }
  });
  it("reports not_configured rather than fetching when no allowlist is set", async () => {
    const adapter = new HttpFdmsAdapter({ baseUrl: "https://fdms.example.test/verify", apiKey: "", allowedHosts: [], timeoutMs: 100, maxBytes: 1000, maxRedirects: 0 });
    expect(adapter.mode).toBe("not_configured");
    expect((await adapter.health()).ok).toBe(false);
  });
  it("never resolves a lookup when no provider is configured", async () => {
    await expect(new NoFdmsAdapter().lookup()).rejects.toThrow();
  });
});
