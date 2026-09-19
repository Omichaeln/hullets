import { safeFetch, SafeFetchRefused, type SafeFetchConfig } from "../util/safe-fetch.ts";
import { FISCAL_CONTRACT, type FiscalLine, type FiscalRecord, type FiscalReference } from "./types.ts";

/**
 * Retrieval of the authoritative transaction record from ZIMRA's FDMS
 * validation service.
 *
 * The adapter boundary matters more than the implementation: the HTTP shape
 * below is a documented, configurable contract rather than a verified one (see
 * the SPEC CAVEAT in ./types.ts), so swapping it for the real endpoint — or for
 * a vendor gateway — is a change to one class. Everything downstream consumes
 * `FiscalRecord`.
 *
 * `lookup` reports a record, or throws. It never guesses: a response it cannot
 * map is an error, not an empty record, because an empty record would read
 * downstream as "the authority confirmed a receipt with no line items".
 */
export interface FdmsAdapter {
  readonly name: string;
  readonly mode: "configured" | "not_configured" | "simulated";
  lookup(ref: FiscalReference): Promise<FiscalRecord>;
  health(): Promise<{ ok: boolean; mode: string; provider: string; note?: string; error?: string }>;
}

const toMinor = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) : null;
  const s = String(v).replace(/[^\d.,-]/g, "").replace(/,(?=\d{3}\b)/g, "");
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const toInt = (v: unknown): number | null => { const n = Number(v); return Number.isInteger(n) ? n : null; };
const toStr = (v: unknown): string | null => { const s = v == null ? "" : String(v).trim(); return s ? s.slice(0, 200) : null; };
const toDate = (v: unknown): string | null => {
  const s = String(v ?? "").trim(); if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})[/-](\d{2})[/-](\d{4})/); if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const t = Date.parse(s); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
};
const pick = (o: Record<string, unknown>, names: string[]): unknown => {
  const lower = new Map(Object.entries(o).map(([k, v]) => [k.toLowerCase().replace(/[^a-z0-9]/g, ""), v]));
  for (const n of names) { const v = lower.get(n.toLowerCase().replace(/[^a-z0-9]/g, "")); if (v != null && v !== "") return v; }
  return null;
};

/** Truthiness of the authority's own validation verdict. Anything unrecognised is NOT valid. */
export function readValidated(raw: Record<string, unknown>): boolean {
  const v = pick(raw, ["validationStatus", "status", "valid", "result", "verificationStatus", "invoiceStatus"]);
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").trim().toUpperCase();
  return s === "VALID" || s === "VALIDATED" || s === "SUCCESS" || s === "TRUE" || s === "OK";
}

/** Map a validation response onto the contract. Unknown shapes surface as an error upstream. */
export function mapFiscalRecord(raw: Record<string, unknown>, ref: FiscalReference): FiscalRecord {
  const receipt = (pick(raw, ["receipt", "invoice", "transaction", "data"]) ?? raw) as Record<string, unknown>;
  const linesRaw = (pick(receipt, ["receiptLines", "lines", "items", "invoiceLines"]) ?? []) as unknown[];
  const lines: FiscalLine[] = (Array.isArray(linesRaw) ? linesRaw : []).slice(0, 200).map((l, i) => {
    const o = (l ?? {}) as Record<string, unknown>;
    return {
      n: i + 1,
      description: String(pick(o, ["receiptLineName", "description", "name", "itemName"]) ?? "").slice(0, 200),
      code: toStr(pick(o, ["receiptLineCode", "code", "itemCode", "sku", "hsCode"])),
      quantity: (() => { const q = Number(pick(o, ["receiptLineQuantity", "quantity", "qty"])); return Number.isFinite(q) ? q : null; })(),
      unitMinor: toMinor(pick(o, ["receiptLinePrice", "unitPrice", "price"])),
      amountMinor: toMinor(pick(o, ["receiptLineTotal", "total", "amount", "lineTotal"])),
      taxPercent: (() => { const t = Number(pick(o, ["taxPercent", "vatRate", "taxRate"])); return Number.isFinite(t) ? t : null; })(),
    };
  });
  const txnAtRaw = toStr(pick(receipt, ["receiptDate", "invoiceDate", "transactionDate", "dateTime", "date"]));
  return {
    validated: readValidated(raw),
    deviceId: toStr(pick(receipt, ["deviceID", "deviceId"])) ?? ref.deviceId,
    fiscalDayNo: toInt(pick(receipt, ["fiscalDayNo", "fiscalDayNumber"])) ?? ref.fiscalDayNo,
    receiptGlobalNo: toStr(pick(receipt, ["receiptGlobalNo", "receiptGlobalNumber", "globalNo"])) ?? ref.receiptGlobalNo,
    verificationCode: toStr(pick(receipt, ["receiptDeviceSignature", "verificationCode", "qrCode", "qrData"])) ?? ref.verificationCode,
    invoiceNo: toStr(pick(receipt, ["invoiceNo", "invoiceNumber", "receiptCounter", "receiptNo"])),
    merchantTin: toStr(pick(receipt, ["sellerTIN", "tin", "supplierTin", "taxpayerTIN"])),
    merchantName: toStr(pick(receipt, ["sellerName", "supplierName", "taxpayerName", "merchantName", "tradeName"])),
    branchName: toStr(pick(receipt, ["branchName", "storeName", "sellerBranchName"])),
    branchCode: toStr(pick(receipt, ["branchCode", "sellerBranchCode", "storeCode"])),
    txnAt: txnAtRaw,
    txnDate: toDate(txnAtRaw),
    currency: toStr(pick(receipt, ["currency", "currencyCode"])),
    totalMinor: toMinor(pick(receipt, ["receiptTotal", "invoiceTotal", "totalAmount", "total", "grandTotal"])),
    taxMinor: toMinor(pick(receipt, ["taxAmount", "totalTax", "vatAmount", "tax"])),
    lines,
    raw: truncate(raw),
  };
}

function truncate(o: Record<string, unknown>): Record<string, unknown> | null {
  try { const s = JSON.stringify(o); return JSON.parse(s.length > 8_000 ? `${s.slice(0, 8_000)}"}` : s) as Record<string, unknown>; } catch { return null; }
}

/**
 * The FDMS verification page is an HTML form, not an API.
 *
 * Navigating to a fiscal QR's destination lands on a page carrying a "Review
 * Invoice" form; the invoice detail only appears once that form is submitted
 * with its hidden fields. Reproduced here so the adapter can follow it.
 *
 * Only ever applied to a response already fetched from the configured,
 * allowlisted host — this parses a page, it does not decide where to go.
 */
export function reviewInvoiceUrl(html: string, base: URL): URL | null {
  for (const match of html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)) {
    const form = match[0];
    if (!/review\s+invoice/i.test(form)) continue;
    const action = form.match(/\baction\s*=\s*["']([^"']+)["']/i);
    if (!action) continue;
    let url: URL;
    try { url = new URL(decodeEntities(action[1]), base); } catch { continue; }
    for (const input of form.matchAll(/<input\b[^>]*>/gi)) {
      const name = input[0].match(/\bname\s*=\s*["']([^"']+)["']/i)?.[1];
      const value = input[0].match(/\bvalue\s*=\s*["']([^"']*)["']/i)?.[1];
      if (name && value != null) url.searchParams.set(decodeEntities(name), decodeEntities(value));
    }
    return url;
  }
  return null;
}

const decodeEntities = (t: string) => t.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
const stripTags = (html: string) => decodeEntities(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, "\n"));

/**
 * Read the authority's verdict off a verification page.
 *
 * Deliberately conservative: an explicit affirmative phrase is required. An
 * unrecognised page is NOT valid, because "we could not tell" and "the
 * authority confirmed it" must never collapse into the same answer.
 *
 * A page is only ever consulted after it was fetched from the configured host,
 * so this decides what the authority SAID — never whether to believe the host.
 */
export function readHtmlVerdict(html: string): boolean {
  const text = stripTags(html);
  if (/\b(?:invoice|receipt)\s+is\s+(?:not\s+valid|invalid)\b/i.test(text)) return false;
  return /\b(?:invoice|receipt)\s+is\s+valid\b|\bvalid(?:ated|ation)\s+(?:invoice|receipt)\b|\bfiscal\s+(?:invoice|receipt)\s+(?:is\s+)?valid\b/i.test(text);
}

/** Pull labelled values out of a verification page: "Label: value" or a two-cell table row. */
export function readHtmlFields(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => stripTags(c[1]).trim().replace(/\s+/g, " "));
    if (cells.length >= 2 && cells[0] && cells[1]) out[cells[0].replace(/:$/, "")] = cells[1];
  }
  for (const line of stripTags(html).split("\n")) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z /.()-]{2,40}?)\s*:\s*(.+?)\s*$/);
    if (m && !out[m[1]]) out[m[1]] = m[2];
  }
  return out;
}

/**
 * HTTPS adapter against a configured FDMS validation endpoint.
 *
 * The host allowlist is mandatory. Without it the adapter reports
 * `not_configured` and the pipeline falls back to OCR, which is the right
 * failure: fetching whatever host a QR code names is how a printed code turns
 * into a promotion entry.
 *
 * Two response shapes are supported, because the real service is an HTML form
 * rather than an API and a vendor gateway in front of it would not be:
 * `html` follows the "Review Invoice" form and reads the invoice page,
 * `json` maps a structured body. Both are driven by identifiers we parsed
 * ourselves, sent to a host we configured.
 */
export class HttpFdmsAdapter implements FdmsAdapter {
  readonly name = "zimra-fdms-http";
  constructor(private o: { baseUrl: string; apiKey: string; allowedHosts: string[]; timeoutMs: number; maxBytes: number; maxRedirects: number; contractMode?: "html" | "json"; fetchImpl?: typeof safeFetch }) {}
  get mode() { return this.o.baseUrl && this.o.allowedHosts.length ? ("configured" as const) : ("not_configured" as const); }

  private cfg(): SafeFetchConfig { return { timeoutMs: this.o.timeoutMs, maxBytes: this.o.maxBytes, maxRedirects: this.o.maxRedirects, allowedHosts: this.o.allowedHosts, requireAllowlist: true }; }
  private url(ref: FiscalReference) {
    const base = this.o.baseUrl.replace(/\/+$/, "");
    const q = new URLSearchParams();
    if (ref.deviceId) q.set("deviceID", ref.deviceId);
    if (ref.fiscalDayNo != null) q.set("fiscalDayNo", String(ref.fiscalDayNo));
    if (ref.receiptGlobalNo) q.set("receiptGlobalNo", ref.receiptGlobalNo);
    if (ref.verificationCode) q.set("qrCode", ref.verificationCode);
    return `${base}?${q.toString()}`;
  }

  async lookup(ref: FiscalReference): Promise<FiscalRecord> {
    const fetcher = this.o.fetchImpl ?? safeFetch;
    const headers: Record<string, string> = this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {};
    let res = await fetcher(this.url(ref), this.cfg(), headers);

    if (res.contentType.includes("json")) {
      let parsed: unknown;
      try { parsed = JSON.parse(res.body.toString("utf8")); } catch { throw new SafeFetchRefused("unsupported_content", "validation response is not JSON"); }
      if (!parsed || typeof parsed !== "object") throw new SafeFetchRefused("unsupported_content", "validation response is not an object");
      return mapFiscalRecord(parsed as Record<string, unknown>, ref);
    }

    if ((this.o.contractMode ?? "html") === "html" && (res.contentType.includes("html") || res.contentType.startsWith("text/"))) {
      // The verdict lives behind the page's "Review Invoice" form. Follow it
      // once, against the same allowlisted host, then read the invoice page.
      const review = reviewInvoiceUrl(res.body.toString("utf8"), res.url);
      if (review) { try { res = await fetcher(review.toString(), this.cfg(), headers); } catch { /* the first page is all we get */ } }
      const html = res.body.toString("utf8");
      const fields = readHtmlFields(html);
      const pick2 = (names: string[]) => { for (const [k, v] of Object.entries(fields)) if (names.some((n) => k.toLowerCase().replace(/[^a-z0-9]/g, "").includes(n))) return v; return null; };
      return {
        validated: readHtmlVerdict(html),
        deviceId: toStr(pick2(["deviceid"])) ?? ref.deviceId,
        fiscalDayNo: toInt(pick2(["fiscalday"])) ?? ref.fiscalDayNo,
        receiptGlobalNo: toStr(pick2(["globalno", "receiptglobal"])) ?? ref.receiptGlobalNo,
        verificationCode: toStr(pick2(["verificationcode", "qrcode", "devicesignature"])) ?? ref.verificationCode,
        invoiceNo: toStr(pick2(["invoiceno", "invoicenumber", "receiptno"])),
        merchantTin: toStr(pick2(["tin"])),
        merchantName: toStr(pick2(["sellername", "suppliername", "taxpayername", "tradename"])),
        branchName: toStr(pick2(["branchname", "storename"])),
        branchCode: toStr(pick2(["branchcode"])),
        txnAt: toStr(pick2(["invoicedate", "receiptdate", "date"])),
        txnDate: toDate(pick2(["invoicedate", "receiptdate", "date"])),
        currency: toStr(pick2(["currency"])),
        totalMinor: toMinor(pick2(["invoicetotal", "totalamount", "grandtotal", "total"])),
        taxMinor: toMinor(pick2(["taxamount", "totaltax", "vatamount"])),
        lines: [],
        raw: truncate({ fields, finalHost: res.url.hostname }),
      };
    }

    throw new SafeFetchRefused("unsupported_content", `validation endpoint returned ${res.contentType || "an unlabelled body"}`);
  }

  async health() {
    if (this.mode !== "configured") return { ok: false, mode: this.mode, provider: this.name, note: "set FISCAL_BASE_URL and FISCAL_ALLOWED_HOSTS; until then receipts fall back to OCR" };
    return { ok: true, mode: this.mode, provider: this.name, note: `validation endpoint ${this.o.baseUrl} (allowlist: ${this.o.allowedHosts.join(", ")}); live behaviour is proven only by a recorded round-trip against a real fiscal receipt` };
  }
}

/** No fiscal provider configured. Every submission takes the OCR path. */
export class NoFdmsAdapter implements FdmsAdapter {
  readonly name = "none";
  readonly mode = "not_configured" as const;
  async lookup(): Promise<FiscalRecord> { throw new SafeFetchRefused("fetch_failed", "no fiscal validation provider is configured"); }
  async health() { return { ok: false, mode: this.mode, provider: this.name, note: "fiscal verification is not configured; receipts are verified by OCR and AI only" }; }
}

export { FISCAL_CONTRACT };
