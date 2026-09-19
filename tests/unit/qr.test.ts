import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { decodeReceiptCodes, enrichWithQrFallback, validateFiscalReceiptUrl, type QrFetchConfig } from "@promo/core/extraction/qr.ts";
import { emptyFacts } from "@promo/core/extraction/types.ts";

const context = {
  outlets: [{ id: "out-1", retailer: "N Richards", branch: "Masvingo", town: "Masvingo", aliases: ["n richards", "masvingo"] }],
  products: [{ code: "HULETTS-BROWN-2KG", name: "Huletts Brown Sugar 2KG", aliases: ["huletts brown sugar", "huletts brown sugar 2kg"], packGrams: 2000, qualifying: true }],
  dateOrder: "DMY" as const,
};
const fetchConfig: QrFetchConfig = { timeoutMs: 2_000, maxBytes: 100_000, maxRedirects: 2, allowedHosts: [] };

const code = (text: string) => ({ format: "QR_CODE", text, rawSha256: "code-hash" });

 describe("QR fiscal receipt fallback", () => {
  it("decodes a real QR image fixture", async () => {
    const image = await fs.readFile("tests/fixtures/fiscal-receipt-qr.png");
    const found = await decodeReceiptCodes(image);
    expect(found).toHaveLength(1);
    expect(found[0].format).toBe("QR_CODE");
    expect(new URL(found[0].text).hostname).toBe("receipts.example.test");
  });

  it("fills unreadable OCR fields from fetched fiscal HTML and records provenance", async () => {
    const result = await enrichWithQrFallback({
      facts: emptyFacts("tesseract", "test"), original: Buffer.from("receipt"), context, enabled: true, fetch: fetchConfig,
      decoder: async () => [code("https://receipts.example.test/fiscal/receipt-170?token=secret")],
      fetcher: async () => ({ url: new URL("https://receipts.example.test/fiscal/receipt-170?token=secret"), contentType: "text/html", body: Buffer.from("<html><body>N Richards Masvingo<br>Receipt No: R-12345<br>Date: 27/08/2026<br>HULETTS BROWN SUGAR 2KG<br>2 x 43.52 = 87.04<br>TOTAL 100.00</body></html>") }),
    });
    expect(result.evidence.status).toBe("parsed");
    expect(result.evidence.urlHost).toBe("receipts.example.test");
    expect(result.evidence.queryKeys).toEqual(["token"]);
    expect(result.facts.evidence.qr?.documentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.facts.transaction.receiptNo).toBe("R12345");
    expect(result.facts.transaction.date).toBe("2026-08-27");
    expect(result.facts.lines[0]?.product?.code).toBe("HULETTS-BROWN-2KG");
    expect(result.facts.quality.missing).not.toContain("line_items");
  });

  it("follows a fiscal portal Review invoice form to recover ZIMRA product lines", async () => {
    const calls: string[] = [];
    const result = await enrichWithQrFallback({
      facts: emptyFacts("tesseract", "test"), original: Buffer.from("receipt"), context, enabled: true, fetch: fetchConfig,
      decoder: async () => [code("https://fdms.zimra.co.zw/qr/example")],
      fetcher: async (url) => {
        calls.push(url);
        if (url.includes("/Receipt/Print")) return { url: new URL(url), contentType: "text/html", body: Buffer.from("<html><body>Invoice No: 384/151707<br>Date: 24/03/2026 18:08<br>Description<br>HULETTS BROWN SUGAR<br>2 each @ 91.20<br>Total ZWG 911.68</body></html>") };
        return { url: new URL(url), contentType: "text/html", body: Buffer.from('<html><body>Invoice is valid<form action="/Receipt/Print" method="GET"><input hidden value="27703931" name="validationId"><input hidden value="lv1O3OFg" name="validationSecurityCode"><button>Review invoice</button></form></body></html>') };
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("/Receipt/Print?");
    expect(result.evidence.status).toBe("parsed");
    expect(result.facts.lines[0]?.product?.code).toBe("HULETTS-BROWN-2KG");
    expect(result.facts.lines[0]?.quantity).toBe(2);
    expect(result.facts.transaction.date).toBe("2026-03-24");
    expect(result.facts.transaction.totalMinor).toBe(91168);
  });

  it("does not perform QR work when OCR is already sufficient", async () => {
    const facts = emptyFacts("tesseract", "test", {
      document: { kind: "receipt", score: 0.9, signals: {} },
      transaction: { receiptNo: "R1", receiptNoRaw: "R1", till: null, date: "2026-08-27", dateRaw: "27/08/2026", dateAmbiguous: false, time: null, currency: "ZAR", totalMinor: 10000, totalRaw: "TOTAL 100.00" },
      lines: [{ n: 1, raw: "2 x HULETTS BROWN SUGAR 2KG", description: "HULETTS BROWN SUGAR 2KG", quantity: 2, packGrams: 2000, unitMinor: 4300, amountMinor: 8600, voided: false, product: { code: "HULETTS-BROWN-2KG", packGrams: 2000, basis: "alias" } }],
      quality: { missing: [], warnings: [], confidence: 0.95, injectionSuspected: false },
    });
    let decoded = false;
    const result = await enrichWithQrFallback({ facts, original: Buffer.from("receipt"), context, enabled: true, fetch: fetchConfig, decoder: async () => { decoded = true; return [code("https://example.test/never")]; } });
    expect(decoded).toBe(false);
    expect(result.evidence.status).toBe("not_attempted");
    expect(result.facts.transaction.receiptNo).toBe("R1");
  });

  it("fails closed for non-HTTPS and private fiscal hosts", async () => {
    await expect(validateFiscalReceiptUrl("http://receipts.example.test/receipt", [])).rejects.toMatchObject({ code: "blocked_url" });
    await expect(validateFiscalReceiptUrl("https://127.0.0.1/receipt", [])).rejects.toMatchObject({ code: "blocked_url" });
    await expect(validateFiscalReceiptUrl("https://receipts.example.test/receipt", ["other.example.test"])).rejects.toMatchObject({ code: "blocked_url" });
  });
});
