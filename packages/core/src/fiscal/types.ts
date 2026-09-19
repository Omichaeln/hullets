/**
 * Fiscal verification contract (zimra-fdms/1).
 *
 * A fiscal receipt in Zimbabwe carries a QR code that resolves to the revenue
 * authority's own record of the transaction. When that record can be retrieved
 * and says VALID, it is a better source than anything read off the paper: the
 * paper is a printout, the FDMS record is what the till actually transmitted.
 *
 * This module returns EVIDENCE, never a decision. It says what the authority
 * reported, what it could not report, and why — including every failure case,
 * because "we asked and the authority did not answer" is itself a fact the
 * rules engine and a reviewer both need.
 *
 * SPEC CAVEAT: the QR layout and the validation endpoint shape below are
 * configurable because they were implemented without access to ZIMRA's
 * published FDMS specification or a test device. The parser and adapter are
 * deliberately defensive and driven by configuration; the layout must be
 * confirmed against the real specification, and `FISCAL_QR_LAYOUT` /
 * `FISCAL_BASE_URL` adjusted, before this path is trusted in production. Until
 * a host allowlist is configured the adapter reports `not_configured` and the
 * system falls back to OCR — it never fetches an arbitrary URL from a QR code.
 */
export const FISCAL_CONTRACT = "zimra-fdms/1";

/** Why a submission does or does not have an authoritative record behind it. */
export type FiscalStatus =
  | "not_attempted"      // fiscal verification is switched off
  | "no_code"            // no QR/barcode found on the image
  | "unsupported_code"   // a code was found but is not a ZIMRA fiscal reference
  | "not_configured"     // no adapter or no host allowlist: we did not look
  | "unavailable"        // we looked and the authority did not answer
  | "invalid"            // the authority answered and did not confirm the invoice
  | "valid";             // the authority confirmed the invoice

export const FISCAL_AUTHORITATIVE: readonly FiscalStatus[] = ["valid"];

/** A line as the authority reports it. Amounts are integer minor units. */
export type FiscalLine = {
  n: number;
  description: string;
  code: string | null;
  quantity: number | null;
  unitMinor: number | null;
  amountMinor: number | null;
  taxPercent: number | null;
};

/** The identifiers carried in the QR code, before any lookup. */
export type FiscalReference = {
  raw: string;
  sha256: string;
  format: string;
  host: string | null;
  deviceId: string | null;
  fiscalDayNo: number | null;
  receiptGlobalNo: string | null;
  verificationCode: string | null;
  qrDate: string | null;
};

/** The transaction as the authority reports it. */
export type FiscalRecord = {
  validated: boolean;
  deviceId: string | null;
  fiscalDayNo: number | null;
  receiptGlobalNo: string | null;
  verificationCode: string | null;
  invoiceNo: string | null;
  merchantTin: string | null;
  merchantName: string | null;
  branchName: string | null;
  branchCode: string | null;
  txnAt: string | null;
  txnDate: string | null;
  currency: string | null;
  totalMinor: number | null;
  taxMinor: number | null;
  lines: FiscalLine[];
  raw: Record<string, unknown> | null;
};

export type FiscalVerification = {
  status: FiscalStatus;
  adapter: string;
  contractVersion: string;
  errorCode: string | null;
  warnings: string[];
  latencyMs: number;
  fetchedAt: string | null;
  reference: FiscalReference | null;
  record: FiscalRecord | null;
};

export const emptyVerification = (status: FiscalStatus, adapter: string, extra: Partial<FiscalVerification> = {}): FiscalVerification => ({
  status, adapter, contractVersion: FISCAL_CONTRACT, errorCode: null, warnings: [], latencyMs: 0, fetchedAt: null, reference: null, record: null, ...extra,
});

/** True when this verification may be treated as the authoritative dataset. */
export const isAuthoritative = (v: FiscalVerification | null | undefined): v is FiscalVerification =>
  !!v && FISCAL_AUTHORITATIVE.includes(v.status) && !!v.record?.validated;

export class FiscalUnavailable extends Error {
  transient = true;
  constructor(message: string, public code = "FISCAL_UNAVAILABLE") { super(message); }
}
