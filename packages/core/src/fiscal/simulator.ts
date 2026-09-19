import type { FdmsAdapter } from "./fdms.ts";
import type { FiscalRecord, FiscalReference } from "./types.ts";

/**
 * A scripted FDMS adapter for tests and the staff simulator.
 *
 * It answers only from records that were explicitly registered against a
 * reference, and refuses anything it was not told about — so a test that
 * expects an authoritative record has to say so, and a test that forgets gets
 * the unavailable path rather than a convenient invention. Refused outside
 * local and test by the application wiring.
 */
export class SimulatorFdmsAdapter implements FdmsAdapter {
  readonly name = "zimra-fdms-simulator";
  readonly mode = "simulated" as const;
  private records = new Map<string, FiscalRecord>();
  private failures = new Map<string, string>();

  private key(ref: Pick<FiscalReference, "deviceId" | "receiptGlobalNo" | "verificationCode">) {
    return ref.deviceId && ref.receiptGlobalNo ? `${ref.deviceId}:${ref.receiptGlobalNo}` : `vc:${ref.verificationCode ?? ""}`;
  }

  /** Register what the authority will say about one transaction. */
  register(ref: Pick<FiscalReference, "deviceId" | "receiptGlobalNo" | "verificationCode">, record: Partial<FiscalRecord> & { validated: boolean }) {
    this.records.set(this.key(ref), {
      deviceId: ref.deviceId ?? null, fiscalDayNo: null, receiptGlobalNo: ref.receiptGlobalNo ?? null, verificationCode: ref.verificationCode ?? null,
      invoiceNo: null, merchantTin: null, merchantName: null, branchName: null, branchCode: null,
      txnAt: null, txnDate: null, currency: null, totalMinor: null, taxMinor: null, lines: [], raw: null,
      ...record,
    });
    return this;
  }
  /** Make one transaction fail the lookup, for the unavailable path. */
  fail(ref: Pick<FiscalReference, "deviceId" | "receiptGlobalNo" | "verificationCode">, message = "simulated outage") { this.failures.set(this.key(ref), message); return this; }
  reset() { this.records.clear(); this.failures.clear(); return this; }

  async lookup(ref: FiscalReference): Promise<FiscalRecord> {
    const k = this.key(ref);
    const failure = this.failures.get(k); if (failure) throw new Error(failure);
    const record = this.records.get(k);
    if (!record) throw new Error("no simulated fiscal record registered for this reference");
    return record;
  }
  async health() { return { ok: true, mode: this.mode, provider: this.name, note: `simulated fiscal authority with ${this.records.size} registered transaction(s); never used outside local or test` }; }
}
