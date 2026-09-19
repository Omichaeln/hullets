import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { decodeReceiptCodes } from "@promo/core/extraction/qr.ts";
import { parseFiscalQr, unpackTail, fiscalIdentity, DEFAULT_QR_LAYOUT } from "@promo/core/fiscal/zimra-qr.ts";
import { mapFiscalRecord, readValidated, readHtmlVerdict, readHtmlFields, reviewInvoiceUrl, HttpFdmsAdapter, NoFdmsAdapter } from "@promo/core/fiscal/fdms.ts";
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

// The real FDMS endpoint is a verification PAGE, not an API: the invoice detail
// sits behind a "Review Invoice" form carrying hidden fields. These cover the
// three things that page has to be read for without ever deciding WHERE to go —
// the host is configured, and these functions only read what came back.
describe("FDMS HTML verification page", () => {
  const page = (body: string) => `<html><body>${body}</body></html>`;

  it("follows the Review Invoice form, carrying its hidden fields, against the same base", () => {
    const url = reviewInvoiceUrl(page(`
      <form method="post" action="/Invoice/Details">
        <input type="hidden" name="deviceID" value="0000012345" />
        <input type="hidden" name="receiptGlobalNo" value="0000000077" />
        <input type="hidden" name="token" value="a&amp;b" />
        <button type="submit">Review Invoice</button>
      </form>`), new URL("https://fdms.example.test/verify?x=1"));
    expect(url).not.toBeNull();
    expect(url!.origin).toBe("https://fdms.example.test");
    expect(url!.pathname).toBe("/Invoice/Details");
    expect(url!.searchParams.get("deviceID")).toBe("0000012345");
    expect(url!.searchParams.get("token")).toBe("a&b");
  });

  it("ignores forms that are not the Review Invoice form", () => {
    expect(reviewInvoiceUrl(page('<form action="/search"><input name="q" value="1"><button>Search</button></form>'), new URL("https://fdms.example.test/"))).toBeNull();
    expect(reviewInvoiceUrl(page("<p>Review Invoice</p>"), new URL("https://fdms.example.test/"))).toBeNull();
  });

  it("requires an explicit affirmative verdict, and reads a negative as negative", () => {
    expect(readHtmlVerdict(page("<h2>This invoice is valid</h2>"))).toBe(true);
    expect(readHtmlVerdict(page("<h2>This invoice is not valid</h2>"))).toBe(false);
    expect(readHtmlVerdict(page("<h2>This invoice is invalid</h2>"))).toBe(false);
    // Silence, an error page, or a redesign must never read as confirmation.
    expect(readHtmlVerdict(page("<p>Service temporarily unavailable</p>"))).toBe(false);
    expect(readHtmlVerdict(page("<p>Enter your verification code</p>"))).toBe(false);
    expect(readHtmlVerdict("")).toBe(false);
  });

  it("reads labelled values from table rows and from Label: value lines", () => {
    const fields = readHtmlFields(page(`
      <table>
        <tr><th>Seller Name:</th><td>Mopani Mart</td></tr>
        <tr><td>Invoice Total</td><td>USD&nbsp;14.98</td></tr>
      </table>
      <div>Invoice Date: 19/09/2026</div>`));
    expect(fields["Seller Name"]).toBe("Mopani Mart");
    expect(fields["Invoice Total"]).toBe("USD 14.98");
    expect(fields["Invoice Date"]).toBe("19/09/2026");
  });

  it("maps a fetched verification page onto the contract", async () => {
    const pages: Record<string, string> = {
      "https://fdms.example.test/verify?deviceID=0000012345&fiscalDayNo=18&receiptGlobalNo=0000000077&qrCode=1A2B3C4D5E6F7A8B":
        page('<form action="/Details"><input name="id" value="77"><button>Review Invoice</button></form>'),
      "https://fdms.example.test/Details?id=77": page(`
        <h2>This invoice is valid</h2>
        <table>
          <tr><td>Seller Name</td><td>Mopani Mart</td></tr>
          <tr><td>Branch Name</td><td>Westgate</td></tr>
          <tr><td>Invoice No</td><td>INV-4512</td></tr>
          <tr><td>Invoice Date</td><td>19/09/2026</td></tr>
          <tr><td>Currency</td><td>USD</td></tr>
          <tr><td>Invoice Total</td><td>14.98</td></tr>
        </table>`),
    };
    const adapter = new HttpFdmsAdapter({
      baseUrl: "https://fdms.example.test/verify", apiKey: "", allowedHosts: ["fdms.example.test"],
      timeoutMs: 1000, maxBytes: 100_000, maxRedirects: 0, contractMode: "html",
      fetchImpl: async (url: string) => {
        const body = pages[url];
        if (body == null) throw new Error(`unexpected fetch: ${url}`);
        return { url: new URL(url), status: 200, contentType: "text/html", body: Buffer.from(body) };
      },
    });
    expect(adapter.mode).toBe("configured");
    const rec = await adapter.lookup(ref() as never);
    expect(rec.validated).toBe(true);
    expect(rec.merchantName).toBe("Mopani Mart");
    expect(rec.branchName).toBe("Westgate");
    expect(rec.invoiceNo).toBe("INV-4512");
    expect(rec.txnDate).toBe("2026-09-19");
    expect(rec.totalMinor).toBe(1498);
    // Identifiers we sent are echoed back, never invented by the page.
    expect(rec.deviceId).toBe("0000012345");
  });

  it("refuses an HTML body when the contract is configured as json", async () => {
    const adapter = new HttpFdmsAdapter({
      baseUrl: "https://fdms.example.test/verify", apiKey: "", allowedHosts: ["fdms.example.test"],
      timeoutMs: 1000, maxBytes: 100_000, maxRedirects: 0, contractMode: "json",
      fetchImpl: async (url: string) => ({ url: new URL(url), status: 200, contentType: "text/html", body: Buffer.from("<p>This invoice is valid</p>") }),
    });
    await expect(adapter.lookup(ref() as never)).rejects.toBeInstanceOf(SafeFetchRefused);
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
