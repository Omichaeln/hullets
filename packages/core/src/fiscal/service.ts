import { eq, and, ne, or, sql } from "drizzle-orm";
import { schema, type Db, type DbOrTx } from "@promo/db";
import { newId } from "../util/ids.ts";
import { SafeFetchRefused } from "../util/safe-fetch.ts";
import { decodeReceiptCodes, type QrDecodedCode } from "../extraction/qr.ts";
import { parseFiscalQr, fiscalIdentity, DEFAULT_QR_LAYOUT, type QrLayout } from "./zimra-qr.ts";
import { emptyVerification, FISCAL_CONTRACT, type FiscalReference, type FiscalVerification } from "./types.ts";
import type { FdmsAdapter } from "./fdms.ts";

const { fiscalVerifications } = schema;
export type FiscalVerificationRow = typeof fiscalVerifications.$inferSelect;

/**
 * Fiscal verification for one submission: decode, identify, ask the authority,
 * persist the answer.
 *
 * The order matters. Decoding happens on OUR side from the image bytes; the
 * decoded value is only ever a set of identifiers to look up, and the lookup
 * only ever goes to a configured, allowlisted validation endpoint. At no point
 * does a URL found on a receipt decide where we send a request or what we
 * believe about a transaction.
 */
export class FiscalService {
  constructor(private db: Db, private adapter: FdmsAdapter, private opts: { enabled: boolean; required: boolean; layout?: QrLayout; decoder?: (bytes: Buffer) => Promise<QrDecodedCode[]> }) {}

  get name() { return this.adapter.name; }
  get mode() { return this.opts.enabled ? this.adapter.mode : ("not_configured" as const); }
  get required() { return this.opts.required; }
  async health() {
    if (!this.opts.enabled) return { ok: !this.opts.required, mode: "disabled", provider: this.adapter.name, note: "fiscal verification is switched off; receipts are verified by OCR and AI only" };
    return this.adapter.health();
  }

  /** Decode the image and, when it carries a fiscal reference, ask the authority about it. */
  async verify(original: Buffer): Promise<FiscalVerification> {
    if (!this.opts.enabled) return emptyVerification("not_attempted", this.adapter.name);
    const started = Date.now();

    let codes: QrDecodedCode[] = [];
    try { codes = await (this.opts.decoder ?? decodeReceiptCodes)(original); }
    catch { return emptyVerification("no_code", this.adapter.name, { warnings: ["decoder_error"], latencyMs: Date.now() - started }); }
    if (!codes.length) return emptyVerification("no_code", this.adapter.name, { latencyMs: Date.now() - started });

    let reference: FiscalReference | null = null;
    for (const c of codes) { reference = parseFiscalQr(c.text, { layout: this.opts.layout ?? DEFAULT_QR_LAYOUT, format: c.format }); if (reference) break; }
    if (!reference) return emptyVerification("unsupported_code", this.adapter.name, { warnings: ["code_is_not_a_fiscal_reference"], latencyMs: Date.now() - started });

    if (this.adapter.mode === "not_configured") return emptyVerification("not_configured", this.adapter.name, { reference, latencyMs: Date.now() - started });

    try {
      const record = await this.adapter.lookup(reference);
      return {
        status: record.validated ? "valid" : "invalid",
        adapter: this.adapter.name, contractVersion: FISCAL_CONTRACT, errorCode: null, warnings: [],
        latencyMs: Date.now() - started, fetchedAt: new Date().toISOString(), reference, record,
      };
    } catch (e) {
      const refused = e instanceof SafeFetchRefused ? e.code : "fetch_failed";
      return emptyVerification("unavailable", this.adapter.name, { reference, errorCode: refused, warnings: [String((e as Error).message).slice(0, 160)], latencyMs: Date.now() - started });
    }
  }

  /** Persist the verification alongside its submission, inside the caller's transaction. */
  async record(tx: DbOrTx, submissionId: string, campaignId: string, v: FiscalVerification) {
    const r = v.record;
    await tx.insert(fiscalVerifications).values({
      id: newId("fsc"), submissionId, campaignId,
      status: v.status, adapter: v.adapter, contractVersion: v.contractVersion, errorCode: v.errorCode, latencyMs: v.latencyMs,
      qrPayloadSha256: v.reference?.sha256 ?? null, qrFormat: v.reference?.format ?? null, qrHost: v.reference?.host ?? null,
      deviceId: r?.deviceId ?? v.reference?.deviceId ?? null,
      fiscalDayNo: r?.fiscalDayNo ?? v.reference?.fiscalDayNo ?? null,
      receiptGlobalNo: r?.receiptGlobalNo ?? v.reference?.receiptGlobalNo ?? null,
      verificationCode: r?.verificationCode ?? v.reference?.verificationCode ?? null,
      invoiceNo: r?.invoiceNo ?? null, merchantTin: r?.merchantTin ?? null, merchantName: r?.merchantName ?? null,
      branchName: r?.branchName ?? null, branchCode: r?.branchCode ?? null,
      txnAt: r?.txnAt && r.txnAt.includes("T") ? r.txnAt : null, txnDate: r?.txnDate ?? null,
      currency: r?.currency ?? null, totalMinor: r?.totalMinor ?? null, taxMinor: r?.taxMinor ?? null,
      lines: r?.lines ?? null, raw: r?.raw ?? null, fetchedAt: v.fetchedAt,
    }).onConflictDoNothing();
  }

  async forSubmission(submissionId: string) {
    const [row] = await this.db.select().from(fiscalVerifications).where(eq(fiscalVerifications.submissionId, submissionId));
    return row ?? null;
  }

  /**
   * Other submissions in this campaign that carry the same fiscal identity.
   *
   * Where a fiscal record exists this is the single strongest duplicate signal
   * available: the device and its global receipt number, or the verification
   * code, name one transaction at one till. It does not depend on reading the
   * paper correctly, so it catches a re-photograph that OCR would read
   * differently every time.
   */
  async duplicatesOf(campaignId: string, submissionId: string, v: FiscalVerification) {
    const ref = { deviceId: v.record?.deviceId ?? v.reference?.deviceId ?? null, fiscalDayNo: v.record?.fiscalDayNo ?? v.reference?.fiscalDayNo ?? null, receiptGlobalNo: v.record?.receiptGlobalNo ?? v.reference?.receiptGlobalNo ?? null, verificationCode: v.record?.verificationCode ?? v.reference?.verificationCode ?? null };
    if (!fiscalIdentity(ref) && !v.reference?.sha256) return [];
    const identity = [
      ref.deviceId && ref.receiptGlobalNo ? and(eq(fiscalVerifications.deviceId, ref.deviceId), eq(fiscalVerifications.receiptGlobalNo, ref.receiptGlobalNo)) : undefined,
      ref.verificationCode ? eq(fiscalVerifications.verificationCode, ref.verificationCode) : undefined,
      v.reference?.sha256 ? eq(fiscalVerifications.qrPayloadSha256, v.reference.sha256) : undefined,
    ].filter(Boolean);
    if (!identity.length) return [];
    return this.db.select({ submissionId: fiscalVerifications.submissionId, status: fiscalVerifications.status, verificationCode: fiscalVerifications.verificationCode })
      .from(fiscalVerifications)
      .where(and(eq(fiscalVerifications.campaignId, campaignId), ne(fiscalVerifications.submissionId, submissionId), or(...(identity as never[]))))
      .limit(10);
  }

  /** The canonical receipt key for a fiscally identified purchase. Stronger than outlet|date|number. */
  canonicalKey(v: FiscalVerification): string | null {
    const ref = { deviceId: v.record?.deviceId ?? v.reference?.deviceId ?? null, fiscalDayNo: v.record?.fiscalDayNo ?? v.reference?.fiscalDayNo ?? null, receiptGlobalNo: v.record?.receiptGlobalNo ?? v.reference?.receiptGlobalNo ?? null, verificationCode: v.record?.verificationCode ?? v.reference?.verificationCode ?? null };
    return fiscalIdentity(ref);
  }

  async stats(campaignId: string) {
    const rows = await this.db.select({ status: fiscalVerifications.status, n: sql<number>`count(*)::int` }).from(fiscalVerifications).where(eq(fiscalVerifications.campaignId, campaignId)).groupBy(fiscalVerifications.status);
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }
}
