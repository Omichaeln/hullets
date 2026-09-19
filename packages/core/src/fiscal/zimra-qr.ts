import { sha256 } from "../util/crypto.ts";
import type { FiscalReference } from "./types.ts";

/**
 * Read the identifiers out of a ZIMRA fiscal QR value.
 *
 * Two forms are accepted, in this order:
 *
 * 1. **Explicit parameters.** A URL carrying the identifiers as query
 *    parameters. This is unambiguous and is what the parser prefers.
 * 2. **Packed tail.** A URL whose path or fragment ends in a fixed-width
 *    concatenation of device id, fiscal day, receipt global number and
 *    verification code. The widths come from `layout` rather than being
 *    hard-coded, because the authoritative specification was not available when
 *    this was written and getting a width wrong silently mis-identifies every
 *    receipt.
 *
 * Nothing here fetches anything, and nothing here trusts the code: the parsed
 * identifiers are only ever used to ASK the authority about a transaction. The
 * QR value never supplies transaction data directly — an earlier design let a
 * fetched document fill in merchant, date, receipt number and line items when
 * OCR read nothing, which made any printable QR code a way to dictate the
 * facts a promotion entry was judged on.
 */
export type QrLayout = { deviceId: number; fiscalDayNo: number; receiptGlobalNo: number; verificationCode: number };
export const DEFAULT_QR_LAYOUT: QrLayout = { deviceId: 10, fiscalDayNo: 4, receiptGlobalNo: 10, verificationCode: 16 };

const PARAM_ALIASES: Record<keyof QrLayout | "qrDate", string[]> = {
  deviceId: ["deviceid", "device_id", "devid", "device"],
  fiscalDayNo: ["fiscaldayno", "fiscal_day_no", "fiscalday", "day"],
  receiptGlobalNo: ["receiptglobalno", "receipt_global_no", "globalno", "receiptno", "receipt"],
  verificationCode: ["qrcode", "qrdata", "verificationcode", "verification_code", "code", "vc"],
  qrDate: ["receiptdate", "date", "txndate", "invoicedate"],
};

const digits = (v: string | null | undefined) => (v && /^\d+$/.test(v) ? v : null);
const normaliseCode = (v: string | null | undefined) => {
  const s = String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length >= 8 ? s : null;
};
const normaliseDate = (v: string | null | undefined) => {
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})[/-](\d{2})[/-](\d{4})/); if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
};

function fromParams(url: URL): Partial<FiscalReference> {
  const lookup = (names: string[]) => {
    for (const [k, v] of url.searchParams) if (names.includes(k.toLowerCase())) return v;
    return null;
  };
  const fiscalDay = digits(lookup(PARAM_ALIASES.fiscalDayNo));
  return {
    deviceId: digits(lookup(PARAM_ALIASES.deviceId)),
    fiscalDayNo: fiscalDay ? Number(fiscalDay) : null,
    receiptGlobalNo: digits(lookup(PARAM_ALIASES.receiptGlobalNo)),
    verificationCode: normaliseCode(lookup(PARAM_ALIASES.verificationCode)),
    qrDate: normaliseDate(lookup(PARAM_ALIASES.qrDate)),
  };
}

/** The packed form: the identifiers run together at the end of the path or fragment. */
export function unpackTail(tail: string, layout: QrLayout): Partial<FiscalReference> {
  const s = tail.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const width = layout.deviceId + layout.fiscalDayNo + layout.receiptGlobalNo + layout.verificationCode;
  if (s.length < width) return {};
  const packed = s.slice(s.length - width);
  let at = 0;
  const take = (n: number) => { const out = packed.slice(at, at + n); at += n; return out; };
  const deviceId = take(layout.deviceId), fiscalDayNo = take(layout.fiscalDayNo), receiptGlobalNo = take(layout.receiptGlobalNo), verificationCode = take(layout.verificationCode);
  // The three numeric groups must actually be numeric, or the widths are wrong
  // and everything after them is misaligned. Better to report the code as
  // unsupported than to invent a transaction identity from a bad offset.
  if (!digits(deviceId) || !digits(fiscalDayNo) || !digits(receiptGlobalNo)) return {};
  return { deviceId, fiscalDayNo: Number(fiscalDayNo), receiptGlobalNo, verificationCode: normaliseCode(verificationCode) };
}

/**
 * Parse a decoded QR/barcode value. Returns null when it is not a plausible
 * fiscal reference — a loyalty barcode, a marketing URL, a phone number.
 */
export function parseFiscalQr(raw: string, { layout = DEFAULT_QR_LAYOUT, format = "QR_CODE" }: { layout?: QrLayout; format?: string } = {}): FiscalReference | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  const base: FiscalReference = { raw: value, sha256: sha256(value), format, host: null, deviceId: null, fiscalDayNo: null, receiptGlobalNo: null, verificationCode: null, qrDate: null };

  let url: URL | null = null;
  try { url = new URL(value); } catch { url = null; }
  if (url && url.protocol !== "https:" && url.protocol !== "http:") return null;

  let parts: Partial<FiscalReference> = {};
  if (url) {
    base.host = url.hostname.toLowerCase();
    parts = fromParams(url);
    if (!parts.deviceId || !parts.receiptGlobalNo) {
      const tail = (url.hash || url.pathname || "").replace(/^[#/]+/, "");
      parts = { ...parts, ...unpackTail(tail, layout) };
    }
  } else {
    parts = unpackTail(value, layout);
  }

  const ref = { ...base, ...parts };
  // A reference is only useful if it identifies a receipt. Either the device
  // plus its global receipt number, or a verification code, will do; neither
  // means this is not a fiscal QR and the submission falls back to OCR.
  const identified = Boolean((ref.deviceId && ref.receiptGlobalNo) || ref.verificationCode);
  return identified ? ref : null;
}

/** Stable identity for duplicate detection: the strongest identifier the reference carries. */
export function fiscalIdentity(ref: Pick<FiscalReference, "deviceId" | "fiscalDayNo" | "receiptGlobalNo" | "verificationCode">): string | null {
  if (ref.deviceId && ref.receiptGlobalNo) return `zimra:${ref.deviceId}:${ref.fiscalDayNo ?? "x"}:${ref.receiptGlobalNo}`;
  if (ref.verificationCode) return `zimra-vc:${ref.verificationCode}`;
  return null;
}
