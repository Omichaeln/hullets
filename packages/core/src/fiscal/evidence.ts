/**
 * The evidence ledger.
 *
 * Every fact about a transaction — the date, the branch, the total, the line
 * items — can be asserted by more than one source, and those sources are not
 * equal. The revenue authority's record of what the till transmitted outranks a
 * photograph of the printout, which outranks what OCR made of that photograph,
 * which outranks what a model inferred, which outranks what the participant
 * typed.
 *
 * The ledger records every assertion rather than collapsing them, so three
 * questions can be answered separately and honestly:
 *
 *   what do we believe        -> the highest-authority observation
 *   how well is it supported  -> which lower sources agree
 *   what disagrees            -> which lower sources conflict, and by how much
 *
 * The last one is the point. A lower-authority source can never overwrite a
 * higher one — but it can contradict it, and a contradiction is a finding that
 * has to be surfaced, not a value to be silently discarded. "The participant
 * says Borrowdale, the authority says Avondale" is not a data-entry problem.
 */
export type EvidenceSource = "zimra_fdms" | "receipt_image" | "ocr" | "ai" | "user";

/** Higher wins. The gaps are deliberate: they leave room to slot sources in later. */
export const SOURCE_AUTHORITY: Record<EvidenceSource, number> = {
  zimra_fdms: 100,
  receipt_image: 60,
  ocr: 40,
  ai: 30,
  user: 20,
};

export const SOURCE_LABEL: Record<EvidenceSource, string> = {
  zimra_fdms: "ZIMRA FDMS",
  receipt_image: "receipt image",
  ocr: "OCR",
  ai: "AI extraction",
  user: "participant",
};

export type EvidenceField =
  | "merchant" | "branch" | "outletId" | "date" | "time"
  | "receiptNo" | "invoiceNo" | "verificationCode"
  | "currency" | "total" | "tax" | "paymentMethod" | "lines" | "qualifyingUnits";

export type Observation = { source: EvidenceSource; value: unknown; detail?: string | null };

/** How well the resolved value is supported. */
export type EvidenceStatus =
  | "absent"         // nothing asserted it
  | "single_source"  // one source, nothing corroborating
  | "corroborated"   // an independent lower-authority source agrees
  | "verified"       // the authority asserted it and the image agrees
  | "conflicted";    // sources disagree

export type FieldEvidence = {
  field: EvidenceField;
  value: unknown;
  source: EvidenceSource | null;
  status: EvidenceStatus;
  agreedBy: EvidenceSource[];
  conflicts: Array<{ source: EvidenceSource; value: unknown }>;
};

export type Discrepancy = {
  field: EvidenceField;
  authority: EvidenceSource;
  authorityValue: unknown;
  source: EvidenceSource;
  sourceValue: unknown;
  severity: "material" | "minor";
};

/** Field-appropriate equality. Amounts tolerate rounding; text ignores case, punctuation and spacing. */
export function sameValue(field: EvidenceField, a: unknown, b: unknown): boolean {
  if (a == null || b == null) return false;
  if (field === "total" || field === "tax") return typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= 1;
  if (field === "qualifyingUnits") return Number(a) === Number(b);
  if (field === "lines") return JSON.stringify(a) === JSON.stringify(b);
  const norm = (v: unknown) => String(v).toLowerCase().replace(/[^a-z0-9]/g, "");
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // Receipt and invoice numbers are numeric identifiers that are printed,
  // padded and re-keyed inconsistently. When both sides are digits, compare
  // them as numbers so "0101" and "0000000101" are the same receipt.
  if ((field === "receiptNo" || field === "invoiceNo") && /^\d+$/.test(x) && /^\d+$/.test(y)) return x.replace(/^0+/, "") === y.replace(/^0+/, "");
  // Merchant and branch names are printed inconsistently ("Mopani Mart
  // Westgate" against "MOPANI WESTGATE BR"), so containment counts as
  // agreement for those two and nothing else.
  if (field === "merchant" || field === "branch") return x.includes(y) || y.includes(x);
  return false;
}

/** Fields where a disagreement changes whether the entry should qualify. */
const MATERIAL: ReadonlySet<EvidenceField> = new Set(["date", "total", "receiptNo", "invoiceNo", "verificationCode", "outletId", "lines", "qualifyingUnits"]);

export class EvidenceLedger {
  private readonly observations = new Map<EvidenceField, Observation[]>();

  /** Record an assertion. Null and empty values are not assertions and are dropped. */
  observe(field: EvidenceField, source: EvidenceSource, value: unknown, detail?: string | null): this {
    if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) return this;
    const list = this.observations.get(field) ?? [];
    list.push({ source, value, detail: detail ?? null });
    this.observations.set(field, list);
    return this;
  }

  observed(field: EvidenceField): Observation[] { return [...(this.observations.get(field) ?? [])]; }
  fields(): EvidenceField[] { return [...this.observations.keys()]; }

  /** Resolve one field: the highest-authority assertion, plus who agrees and who does not. */
  resolve(field: EvidenceField): FieldEvidence {
    const list = this.observations.get(field) ?? [];
    if (!list.length) return { field, value: null, source: null, status: "absent", agreedBy: [], conflicts: [] };
    const ranked = [...list].sort((a, b) => SOURCE_AUTHORITY[b.source] - SOURCE_AUTHORITY[a.source]);
    const top = ranked[0];
    const agreedBy: EvidenceSource[] = [];
    const conflicts: Array<{ source: EvidenceSource; value: unknown }> = [];
    for (const o of ranked.slice(1)) {
      if (o.source === top.source) continue;
      if (sameValue(field, top.value, o.value)) agreedBy.push(o.source);
      else conflicts.push({ source: o.source, value: o.value });
    }
    const status: EvidenceStatus = conflicts.length
      ? "conflicted"
      : top.source === "zimra_fdms" && agreedBy.length
        ? "verified"
        : agreedBy.length
          ? "corroborated"
          : "single_source";
    return { field, value: top.value, source: top.source, status, agreedBy, conflicts };
  }

  /** Resolve everything asserted. */
  resolveAll(): Record<string, FieldEvidence> {
    return Object.fromEntries(this.fields().map((f) => [f, this.resolve(f)]));
  }

  /** The value the rules engine should judge, or null when nothing established it. */
  value<T = unknown>(field: EvidenceField): T | null { return (this.resolve(field).value as T) ?? null; }

  /** Fields with no assertion at all — what the participant may legitimately be asked for. */
  missing(required: readonly EvidenceField[]): EvidenceField[] { return required.filter((f) => this.resolve(f).status === "absent"); }

  /** Every disagreement, graded by whether it can change the outcome. */
  discrepancies(): Discrepancy[] {
    const out: Discrepancy[] = [];
    for (const field of this.fields()) {
      const r = this.resolve(field);
      if (!r.source) continue;
      for (const c of r.conflicts) out.push({ field, authority: r.source, authorityValue: r.value, source: c.source, sourceValue: c.value, severity: MATERIAL.has(field) ? "material" : "minor" });
    }
    return out;
  }

  /** The strongest source that contributed anything. */
  topAuthority(): EvidenceSource | null {
    let best: EvidenceSource | null = null;
    for (const list of this.observations.values()) for (const o of list) if (!best || SOURCE_AUTHORITY[o.source] > SOURCE_AUTHORITY[best]) best = o.source;
    return best;
  }

  /** A compact, storable summary for the audit record and the reviewer. */
  summary() {
    const resolved = this.resolveAll();
    const byStatus: Record<EvidenceStatus, number> = { absent: 0, single_source: 0, corroborated: 0, verified: 0, conflicted: 0 };
    for (const r of Object.values(resolved)) byStatus[r.status]++;
    const d = this.discrepancies();
    return {
      authority: this.topAuthority(),
      fields: resolved,
      byStatus,
      discrepancies: d,
      materialDiscrepancies: d.filter((x) => x.severity === "material").length,
    };
  }
}
