import { createRequire } from "node:module";
import dns from "node:dns/promises";
import net from "node:net";
import { request } from "node:https";
import { URL } from "node:url";
import { BinaryBitmap, BarcodeFormat, DecodeHintType, HybridBinarizer, MultiFormatReader, RGBLuminanceSource } from "@zxing/library";
import sharp from "sharp";
import { sha256 } from "../util/crypto.ts";
import { parseReceiptText } from "./parser.ts";
import type { ExtractionContext, Facts, QrEvidence } from "./types.ts";

const require = createRequire(import.meta.url);
const DECODER_VERSION = `zxing-js@${require("@zxing/library/package.json").version as string}`;
const jsQR = require("jsqr") as (data: Uint8ClampedArray, width: number, height: number, options?: { inversionAttempts?: "dontInvert" | "onlyInvert" | "attemptBoth" | "invertFirst" }) => { data: string } | null;
const MAX_SCAN_PIXELS = 16_000_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const DEFAULT_ALLOWED_FORMATS = new Set([
  BarcodeFormat.QR_CODE,
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
]);
type SharpPipeline = ReturnType<typeof sharp>;

export type QrFetchConfig = { timeoutMs: number; maxBytes: number; maxRedirects: number; allowedHosts: string[]; authoritativeHosts?: string[] };
export type QrDecodedCode = { format: string; text: string; rawSha256: string };

type QrResult = { facts: Facts; evidence: QrEvidence };

class QrFailure extends Error {
  constructor(public code: QrEvidence["status"], message: string) { super(message); }
}

function hostAllowed(host: string, allowed: string[]) {
  return !allowed.length || allowed.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

function isPrivateAddress(address: string) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || a >= 224 || a === 240 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && b >= 18 && b <= 19);
  }
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return isPrivateAddress(normalized.slice(7));
  return normalized === "::1" || normalized === "::" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("ff") || normalized.startsWith("2001:db8:");
}

async function safeAddresses(hostname: string) {
  if (net.isIP(hostname)) { if (isPrivateAddress(hostname)) throw new QrFailure("blocked_url", "fiscal host resolves to a private or reserved address"); return [hostname]; }
  let addresses: string[];
  try { addresses = (await dns.lookup(hostname, { all: true })).map((x) => x.address); }
  catch { throw new QrFailure("blocked_url", "fiscal host DNS lookup failed"); }
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new QrFailure("blocked_url", "fiscal host resolves to a private or reserved address");
  return addresses;
}

export async function validateFiscalReceiptUrl(raw: string, allowedHosts: string[]) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new QrFailure("invalid_url", "QR value is not a valid URL"); }
  if (url.protocol !== "https:") throw new QrFailure("blocked_url", "fiscal URL must use HTTPS");
  if (url.username || url.password) throw new QrFailure("blocked_url", "fiscal URL credentials are not allowed");
  if (url.port && url.port !== "443") throw new QrFailure("blocked_url", "non-standard fiscal URL ports are not allowed");
  if (!hostAllowed(url.hostname.toLowerCase(), allowedHosts)) throw new QrFailure("blocked_url", "fiscal host is not on the configured allowlist");
  await safeAddresses(url.hostname);
  return url;
}

function queryKeys(url: URL) { return Array.from(new Set(Array.from(url.searchParams.keys()).map((x) => x.slice(0, 64)))).slice(0, 20); }

function requestOnce(url: URL, address: string, cfg: QrFetchConfig): Promise<{ status: number; headers: Record<string, string | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    let settled = false; let total = 0; const chunks: Buffer[] = [];
    const finish = (err?: Error, result?: { status: number; headers: Record<string, string | undefined>; body: Buffer }) => { if (settled) return; settled = true; if (err) reject(err); else if (result) resolve(result); else reject(new Error("fiscal response ended without a result")); };
    const req = request({ protocol: "https:", hostname: address, port: 443, method: "GET", path: `${url.pathname || "/"}${url.search}`, servername: url.hostname, headers: { host: url.host, accept: "application/json,text/html,application/xhtml+xml,text/plain;q=0.9", "user-agent": "HulettsPromotionsReceiptVerifier/1.0" }, rejectUnauthorized: true, timeout: cfg.timeoutMs }, (res) => {
      const headers: Record<string, string | undefined> = {}; for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
      const advertised = Number(headers["content-length"] ?? 0); if (advertised > cfg.maxBytes) { res.resume(); finish(new Error("fiscal response exceeds byte limit")); return; }
      res.on("data", (chunk: Buffer) => { total += chunk.length; if (total > cfg.maxBytes) { req.destroy(new Error("fiscal response exceeds byte limit")); return; } chunks.push(Buffer.from(chunk)); });
      res.on("end", () => finish(undefined, { status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) }));
      res.on("error", (e) => finish(e));
    });
    req.on("timeout", () => req.destroy(new Error("fiscal fetch timeout")));
    req.on("error", (e) => finish(e));
    req.end();
  });
}

export type QrFetchedDocument = { url: URL; contentType: string; body: Buffer };
async function fetchFiscalUrl(rawUrl: string, cfg: QrFetchConfig): Promise<QrFetchedDocument> {
  let url = await validateFiscalReceiptUrl(rawUrl, cfg.allowedHosts); let redirects = 0;
  while (true) {
    const [address] = await safeAddresses(url.hostname); const res = await requestOnce(url, address, cfg);
    if (REDIRECTS.has(res.status)) {
      if (redirects++ >= cfg.maxRedirects) throw new QrFailure("fetch_failed", "fiscal URL redirect limit exceeded");
      const location = res.headers.location; if (!location) throw new QrFailure("fetch_failed", "fiscal redirect omitted Location");
      url = await validateFiscalReceiptUrl(new URL(location, url).toString(), cfg.allowedHosts); continue;
    }
    if (res.status < 200 || res.status >= 300) throw new QrFailure("fetch_failed", `fiscal endpoint returned HTTP ${res.status}`);
    return { url, contentType: (res.headers["content-type"] ?? "").split(";", 1)[0].toLowerCase(), body: res.body };
  }
}

function reviewInvoiceUrl(body: Buffer, contentType: string, base: URL) {
  if (!contentType.includes("html")) return null;
  const html = body.toString("utf8");
  for (const match of html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)) {
    const form = match[0];
    if (!/review\s+invoice/i.test(form)) continue;
    const actionMatch = form.match(/\baction\s*=\s*["']([^"']+)["']/i);
    if (!actionMatch) continue;
    const url = new URL(decodeEntities(actionMatch[1]), base);
    for (const input of form.matchAll(/<input\b[^>]*>/gi)) {
      const tag = input[0];
      const name = tag.match(/\bname\s*=\s*["']([^"']+)["']/i)?.[1];
      const value = tag.match(/\bvalue\s*=\s*["']([^"']*)["']/i)?.[1];
      if (name && value != null) url.searchParams.set(decodeEntities(name), decodeEntities(value));
    }
    return url;
  }
  return null;
}

type FiscalFetchResult = { document: QrFetchedDocument; warning: string | null; authoritativeHost: string | null };
function hasZimraVerificationMarker(body: Buffer, contentType: string) {
  if (!contentType.includes("html") && !contentType.includes("json") && !contentType.startsWith("text/")) return false;
  const text = body.toString("utf8").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  return /invoice\s+is\s+valid|valid(?:ated|ation)\s+(?:invoice|receipt)|fiscal\s+(?:invoice|receipt)\s+(?:is\s+)?valid/i.test(text);
}
function authoritativeHost(url: URL, body: Buffer, contentType: string, cfg: QrFetchConfig) {
  const hosts = cfg.authoritativeHosts ?? ["fdms.zimra.co.zw"];
  return hostAllowed(url.hostname.toLowerCase(), hosts) && hasZimraVerificationMarker(body, contentType) ? url.hostname.toLowerCase() : null;
}
async function fetchFiscalDocument(rawUrl: string, cfg: QrFetchConfig, fetcher: (url: string, cfg: QrFetchConfig) => Promise<QrFetchedDocument>): Promise<FiscalFetchResult> {
  const initial = await fetcher(rawUrl, cfg);
  const review = reviewInvoiceUrl(initial.body, initial.contentType, initial.url);
  const initialAuthority = authoritativeHost(initial.url, initial.body, initial.contentType, cfg);
  if (!review) return { document: initial, warning: null as string | null, authoritativeHost: initialAuthority };
  try {
    const document = await fetcher(review.toString(), cfg);
    return { document, warning: null as string | null, authoritativeHost: initialAuthority ?? authoritativeHost(document.url, document.body, document.contentType, cfg) };
  }
  catch { return { document: initial, warning: "review_fetch_failed", authoritativeHost: initialAuthority }; }
}

function decodeEntities(text: string) { return text.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))); }
function digitalText(body: Buffer, contentType: string) {
  const text = body.toString("utf8");
  if (contentType.includes("json") || /^[\s\uFEFF]*(?:\{|\[)/.test(text)) {
    try { return JSON.stringify(JSON.parse(text), null, 1).replace(/[{}[\],]/g, "\n"); } catch { throw new QrFailure("unsupported_content", "fiscal JSON could not be parsed"); }
  }
  if (contentType.includes("html") || /<html|<body|<table|<div/i.test(text)) return decodeEntities(text.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, "\n"));
  if (contentType.startsWith("text/")) return text;
  throw new QrFailure("unsupported_content", "fiscal document is not JSON, HTML, or text");
}

export async function decodeReceiptCodes(bytes: Buffer): Promise<QrDecodedCode[]> {
  const rotated = sharp(bytes, { limitInputPixels: MAX_SCAN_PIXELS }).rotate(); const meta = await rotated.metadata(); const width = meta.width ?? 0; const height = meta.height ?? 0;
  if (!width || !height || width * height > MAX_SCAN_PIXELS) return [];
  const crops = [{ top: 0, height }, { top: Math.floor(height * 0.25), height: Math.ceil(height * 0.75) }, { top: Math.floor(height * 0.5), height: Math.ceil(height * 0.5) }, { top: Math.floor(height * 0.65), height: Math.ceil(height * 0.35) }].map((x) => ({ left: 0, top: Math.max(0, x.top), width, height: Math.min(height - Math.max(0, x.top), x.height) })).filter((x) => x.height >= 80);
  const hints = new Map<DecodeHintType, unknown>([[DecodeHintType.POSSIBLE_FORMATS, Array.from(DEFAULT_ALLOWED_FORMATS)], [DecodeHintType.TRY_HARDER, true]]);
  const variants = [
    (x: SharpPipeline) => x.ensureAlpha(),
    (x: SharpPipeline) => x.grayscale(),
    (x: SharpPipeline) => x.grayscale().normalise(),
    (x: SharpPipeline) => x.grayscale().normalise().threshold(160),
  ];
  for (const crop of crops) for (const variant of variants) {
    try {
      const { data, info } = await variant(rotated.clone().extract(crop).resize({ width: 2200 })).raw().toBuffer({ resolveWithObject: true });
      let source: RGBLuminanceSource;
      if (info.channels === 1) source = new RGBLuminanceSource(new Uint8ClampedArray(data), info.width, info.height);
      else { const pixels = new Int32Array(info.width * info.height); for (let i = 0, p = 0; i < pixels.length; i++, p += info.channels) pixels[i] = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2]; source = new RGBLuminanceSource(pixels, info.width, info.height); }
      try { const result = new MultiFormatReader().decode(new BinaryBitmap(new HybridBinarizer(source)), hints); const text = result.getText().trim(); if (text) return [{ format: BarcodeFormat[result.getBarcodeFormat()] ?? String(result.getBarcodeFormat()), text: text.slice(0, 2048), rawSha256: sha256(text) }]; } catch { /* use jsQR below for RGBA variants */ }
      if (info.channels === 4) { const result = jsQR(new Uint8ClampedArray(data), info.width, info.height, { inversionAttempts: "attemptBoth" }); if (result?.data?.trim()) { const text = result.data.trim(); return [{ format: "QR_CODE", text: text.slice(0, 2048), rawSha256: sha256(text) }]; } }
    } catch { /* try the next bounded crop/normalization */ }
  }
  return [];
}

function baseEvidence(): QrEvidence { return { attempted: true, status: "no_code", authority: "none", authorityHost: null, decoder: DECODER_VERSION, format: null, codeSha256: null, urlHost: null, urlPath: null, queryKeys: [], finalHost: null, finalPath: null, contentType: null, documentSha256: null, fetchedAt: null, fields: [], warnings: [], errorCode: null }; }

function mergeFacts(ocr: Facts, digital: Facts, evidence: QrEvidence): Facts {
  const authoritative = evidence.authority === "zimra_verified";
  const warnings = [...ocr.quality.warnings]; const tx = { ...ocr.transaction };
  for (const key of ["receiptNo", "receiptNoRaw", "till", "date", "dateRaw", "time", "currency", "totalMinor", "totalRaw"] as const) {
    const current = tx[key]; const incoming = digital.transaction[key];
    if (authoritative && incoming != null) {
      if (current != null && current !== incoming) warnings.push(`qr_authoritative_${key}_override`);
      (tx as Record<string, unknown>)[key] = incoming;
    } else if (current == null && incoming != null) (tx as Record<string, unknown>)[key] = incoming;
    else if (current != null && incoming != null && current !== incoming) warnings.push(`qr_${key}_disagreement`);
  }
  const merchant = authoritative && (digital.merchant.text || digital.merchant.candidates.length) ? digital.merchant : (ocr.merchant.text || ocr.merchant.candidates.length ? ocr.merchant : digital.merchant);
  const useDigitalLines = digital.lines.some((x) => x.product) && (authoritative || !ocr.lines.length || !ocr.lines.some((x) => x.product));
  if (useDigitalLines && digital.lines.length) warnings.push("qr_lines_used");
  const missing = ocr.quality.missing.filter((field) => {
    if (field === "receipt_number") return !tx.receiptNo;
    if (field === "transaction_date") return !tx.date;
    if (field === "total") return tx.totalMinor == null;
    if (field === "line_items") return !(useDigitalLines ? digital.lines.length : ocr.lines.length);
    return true;
  });
  const digitalFields = [tx.receiptNo && "receipt_number", tx.date && "transaction_date", tx.totalMinor != null && "total", useDigitalLines && digital.lines.length && "line_items"].filter(Boolean) as string[];
  evidence.fields = digitalFields;
  evidence.status = "parsed";
  const document = authoritative ? digital.document : (ocr.document.kind === "non_receipt" ? digital.document : { ...ocr.document, score: Math.max(ocr.document.score, digital.document.score), kind: ocr.document.kind === "unknown" ? digital.document.kind : ocr.document.kind });
  return { ...ocr, document, merchant, transaction: { ...tx, dateAmbiguous: authoritative ? digital.transaction.dateAmbiguous : (ocr.transaction.date != null ? ocr.transaction.dateAmbiguous : digital.transaction.dateAmbiguous) }, lines: useDigitalLines && digital.lines.length ? digital.lines : ocr.lines, quality: { ...ocr.quality, missing, warnings, confidence: authoritative ? 1 : ocr.quality.confidence }, evidence: { ...ocr.evidence, qr: evidence }, raw: { ...(ocr.raw ?? {}), qr: evidence } };
}

export async function enrichWithQrFallback(input: { facts: Facts; original: Buffer; context: ExtractionContext; enabled: boolean; fetch: QrFetchConfig; decoder?: (bytes: Buffer) => Promise<QrDecodedCode[]>; fetcher?: (url: string, cfg: QrFetchConfig) => Promise<QrFetchedDocument> }): Promise<QrResult> {
  const evidence = baseEvidence();
  const attach = (facts: Facts): Facts => ({ ...facts, evidence: { ...facts.evidence, qr: evidence }, raw: { ...(facts.raw ?? {}), qr: evidence } });
  if (!input.enabled) { evidence.attempted = false; evidence.status = "not_attempted"; return { facts: attach(input.facts), evidence }; }
  const shouldTry = input.facts.document.kind !== "receipt" || input.facts.lines.length === 0 || input.facts.quality.missing.length > 0 || (input.facts.quality.confidence != null && input.facts.quality.confidence < 0.6);
  if (!shouldTry) { evidence.attempted = false; evidence.status = "not_attempted"; evidence.warnings.push("ocr_sufficient"); return { facts: attach(input.facts), evidence }; }
  let codes: QrDecodedCode[];
  try { codes = await (input.decoder ?? decodeReceiptCodes)(input.original); }
  catch { evidence.status = "no_code"; evidence.warnings.push("decoder_error"); return { facts: attach(input.facts), evidence }; }
  const candidate = codes.find((c) => /^https:\/\//i.test(c.text));
  if (!candidate) { evidence.status = "no_code"; if (codes.length) evidence.warnings.push("barcode_without_https_fiscal_url"); return { facts: attach(input.facts), evidence }; }
  evidence.format = candidate.format; evidence.codeSha256 = candidate.rawSha256;
  try {
    const fetchedResult = await fetchFiscalDocument(candidate.text, input.fetch, input.fetcher ?? fetchFiscalUrl); const fetched = fetchedResult.document; if (fetchedResult.warning) evidence.warnings.push(fetchedResult.warning); const text = digitalText(fetched.body, fetched.contentType); const digital = parseReceiptText(text, input.context, { provider: "qr-fiscal", model: `${DECODER_VERSION}/text-parser`, promptVersion: "qr-fiscal/1", confidence: 1, raw: { documentSha256: sha256(fetched.body), contentType: fetched.contentType } });
    evidence.urlHost = new URL(candidate.text).hostname; evidence.urlPath = new URL(candidate.text).pathname.slice(0, 512); evidence.queryKeys = queryKeys(new URL(candidate.text)); evidence.finalHost = fetched.url.hostname; evidence.finalPath = fetched.url.pathname.slice(0, 512); evidence.contentType = fetched.contentType; evidence.documentSha256 = sha256(fetched.body); evidence.fetchedAt = new Date().toISOString();
    evidence.authorityHost = fetchedResult.authoritativeHost;
    evidence.authority = fetchedResult.authoritativeHost && digital.document.kind !== "non_receipt" && Boolean(digital.transaction.date || digital.transaction.receiptNo || digital.lines.length) ? "zimra_verified" : fetchedResult.authoritativeHost ? "digital_fiscal" : "none";
    return { facts: mergeFacts(input.facts, digital, evidence), evidence };
  } catch (e) {
    const err = e instanceof QrFailure ? e : new QrFailure("fetch_failed", (e as Error).message);
    evidence.status = err.code; evidence.errorCode = err.code; evidence.warnings.push(err.message.slice(0, 160));
    try { const parsed = new URL(candidate.text); evidence.urlHost = parsed.hostname; evidence.urlPath = parsed.pathname.slice(0, 512); evidence.queryKeys = queryKeys(parsed); } catch { /* candidate was URL-validated by the caller path */ }
    return { facts: attach(input.facts), evidence };
  }
}
