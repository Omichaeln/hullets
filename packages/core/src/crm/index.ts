import { eq, and, lt, or, isNull, inArray, desc, asc, sql } from "drizzle-orm";
import { schema, type Db } from "@promo/db";
import { newId } from "../util/ids.ts";
import { backoffMs } from "../util/time.ts";
import type { AlertSink } from "../receipt/pipeline.ts";

const { crmEvents, crmRefs } = schema;
export const MAPPING_VERSION = "crm-map/1";
const MAX_ATTEMPTS = 8;
export type CrmRecord = Record<string, unknown>;
/** Canonical CRM contract. Identity numbers, raw receipts and OCR text are never part of the default mapping. */
export function mapEntity(type: string, p: Record<string, unknown>): CrmRecord {
  const base = { external_key: p.externalKey, source: "hullets-promo", mapping_version: MAPPING_VERSION };
  switch (type) {
    case "participant": return { ...base, first_name: p.firstName, surname: p.surname, phone_masked: p.phone, town: p.location, status: p.status };
    case "enrollment": return { ...base, participant_key: p.participantKey, campaign: p.campaignCode, terms_version: p.termsVersion, privacy_version: p.privacyVersion, marketing_consent: !!p.marketingConsent, accepted_at: p.acceptedAt };
    case "submission": return { ...base, participant_key: p.participantKey, campaign: p.campaignCode, reference: p.reference, outlet_code: p.outletCode, status: p.status, reason: p.reason, submitted_at: p.intakeAt };
    case "entry": return { ...base, participant_key: p.participantKey, campaign: p.campaignCode, period: p.period, outlet_code: p.outletCode, submission_reference: p.reference, status: p.status, awarded_at: p.awardedAt };
    case "winner": return { ...base, participant_key: p.participantKey, campaign: p.campaignCode, period: p.period, prize: p.prize, rank: p.rank, status: p.status };
    case "claim": return { ...base, winner_key: p.winnerKey, state: p.state, collection_outlet: p.collectionOutlet, fulfilled_at: p.fulfilledAt };
    default: return { ...base, ...p };
  }
}
export interface CrmAdapter { readonly name: string; upsert(e: { externalKey: string; entityType: string; entityVersion: number; record: CrmRecord }): Promise<{ externalId: string }>; read(e: { externalKey: string; entityType: string }): Promise<CrmRecord | null>; health(): Promise<{ ok: boolean; mode: "configured" | "not_configured"; provider: string; note?: string; error?: string }>; }

export class HttpContractAdapter implements CrmAdapter {
  readonly name = "http-contract";
  constructor(private base: string, private token: string, private timeoutMs = 10_000, private fetchImpl: typeof fetch = fetch) { this.base = base.replace(/\/+$/, ""); }
  private headers() { return { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }; }
  async upsert(e: { externalKey: string; entityType: string; entityVersion: number; record: CrmRecord }) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.base}/records/${encodeURIComponent(e.entityType)}/${encodeURIComponent(e.externalKey)}`, { method: "PUT", headers: this.headers(), signal: ctrl.signal, body: JSON.stringify({ entity_version: e.entityVersion, record: e.record }) });
      if (res.status === 409) throw Object.assign(new Error("older version rejected by the CRM"), { permanent: true });
      if (!res.ok) throw Object.assign(new Error(`crm http ${res.status}`), { permanent: res.status >= 400 && res.status < 500 && res.status !== 429 });
      const j = (await res.json().catch(() => ({}))) as { id?: string }; return { externalId: j.id ?? e.externalKey };
    } catch (e2) { const x = e2 as Error & { name: string }; if (x.name === "AbortError") throw Object.assign(new Error("crm timeout (outcome unknown)"), { unknownOutcome: true }); throw x; } finally { clearTimeout(t); }
  }
  async read(e: { externalKey: string; entityType: string }) { const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), this.timeoutMs); try { const res = await this.fetchImpl(`${this.base}/records/${encodeURIComponent(e.entityType)}/${encodeURIComponent(e.externalKey)}`, { headers: this.headers(), signal: ctrl.signal }); if (res.status === 404) return null; if (!res.ok) throw new Error(`crm read http ${res.status}`); return (await res.json()) as CrmRecord; } finally { clearTimeout(t); } }
  async health() { try { const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 4000); const res = await this.fetchImpl(`${this.base}/health`, { headers: this.headers(), signal: ctrl.signal }); clearTimeout(t); return { ok: res.ok, mode: "configured" as const, provider: this.name, note: `contract endpoint ${this.base}` }; } catch (e) { return { ok: false, mode: "configured" as const, provider: this.name, error: (e as Error).message }; } }
}
export class NoCrmAdapter implements CrmAdapter { readonly name = "none"; async upsert(): Promise<{ externalId: string }> { throw Object.assign(new Error("CRM provider not configured (D-19)"), { notConfigured: true }); } async read() { return null; } async health() { return { ok: false, mode: "not_configured" as const, provider: "none", note: "events queue visibly; nothing is delivered until a vendor adapter is configured" }; } }

/** Versioned CRM outbox with authoritative read-back and reconciliation. Never marks delivered on a 200 alone. */
export class CrmService {
  constructor(private db: Db, private adapter: CrmAdapter, private environment: string, private alerts: AlertSink) {}
  key(type: string, id: string) { return `${this.environment}:${type}:${id}`; }
  async emit(e: { entityType: string; entityId: string; entityVersion: number; payload: Record<string, unknown>; correlationId?: string | null }) {
    const externalKey = this.key(e.entityType, e.entityId);
    const record = mapEntity(e.entityType, { ...e.payload, externalKey, participantKey: e.payload.participantId ? this.key("participant", String(e.payload.participantId)) : undefined, winnerKey: e.payload.winnerId ? this.key("winner", String(e.payload.winnerId)) : undefined });
    const r = await this.db.insert(crmEvents).values({ id: newId("crm"), provider: this.adapter.name, entityType: e.entityType, entityId: e.entityId, entityVersion: e.entityVersion, mappingVersion: MAPPING_VERSION, externalKey, payload: record, correlationId: e.correlationId ?? null }).onConflictDoNothing().returning({ id: crmEvents.id });
    return { id: r[0]?.id ?? null, externalKey };
  }
  async deliverOne() {
    if (this.adapter.name === "none") return null;
    const job = await this.db.transaction(async (tx) => { const now = new Date().toISOString(); const [row] = await tx.select().from(crmEvents).where(and(or(isNull(crmEvents.nextAttemptAt), lt(crmEvents.nextAttemptAt, now)), or(and(inArray(crmEvents.status, ["pending", "retryable_failure"]), or(isNull(crmEvents.leaseUntil), lt(crmEvents.leaseUntil, now))), and(eq(crmEvents.status, "sending"), lt(crmEvents.leaseUntil, now))))).orderBy(asc(crmEvents.createdAt)).limit(1).for("update", { skipLocked: true }); if (!row) return null; await tx.update(crmEvents).set({ status: "sending", leaseUntil: new Date(Date.now() + 60_000).toISOString(), attempts: row.attempts + 1 }).where(eq(crmEvents.id, row.id)); return { ...row, attempts: row.attempts + 1 }; });
    if (!job) return null;
    const [ref] = await this.db.select().from(crmRefs).where(and(eq(crmRefs.entityType, job.entityType), eq(crmRefs.entityId, job.entityId), eq(crmRefs.provider, this.adapter.name)));
    if (ref && ref.lastVersion > job.entityVersion) { await this.db.update(crmEvents).set({ status: "permanent_failure", lastError: "superseded by a newer version already delivered", leaseUntil: null }).where(eq(crmEvents.id, job.id)); return { id: job.id, superseded: true }; }
    try {
      const res = await this.adapter.upsert({ externalKey: job.externalKey, entityType: job.entityType, entityVersion: job.entityVersion, record: job.payload });
      const back = await this.adapter.read({ externalKey: job.externalKey, entityType: job.entityType }).catch(() => null);
      const confirmed = !!back && Number(back.entity_version) >= job.entityVersion;
      await this.db.update(crmEvents).set({ status: confirmed ? "delivered" : "unknown_outcome", externalId: res.externalId, deliveredAt: new Date().toISOString(), leaseUntil: null, readback: back ? truncate(back) : null, readbackAt: new Date().toISOString(), lastError: confirmed ? null : "read-back did not confirm the written version" }).where(eq(crmEvents.id, job.id));
      if (confirmed) await this.db.insert(crmRefs).values({ entityType: job.entityType, entityId: job.entityId, provider: this.adapter.name, externalId: res.externalId, lastVersion: job.entityVersion }).onConflictDoUpdate({ target: [crmRefs.entityType, crmRefs.entityId, crmRefs.provider], set: { externalId: res.externalId, lastVersion: sql`greatest(${crmRefs.lastVersion}, ${job.entityVersion})`, updatedAt: new Date().toISOString() } });
      return { id: job.id, delivered: confirmed };
    } catch (e) {
      const x = e as Error & { permanent?: boolean; unknownOutcome?: boolean };
      const status = x.unknownOutcome ? "unknown_outcome" : x.permanent || job.attempts >= MAX_ATTEMPTS ? "permanent_failure" : "retryable_failure";
      await this.db.update(crmEvents).set({ status, lastError: x.message.slice(0, 300), leaseUntil: null, nextAttemptAt: status === "retryable_failure" ? new Date(Date.now() + backoffMs(job.attempts, 2000, 600_000)).toISOString() : null }).where(eq(crmEvents.id, job.id));
      if (status !== "retryable_failure") await this.alerts.raise({ kind: "crm.delivery", severity: "warning", message: `CRM event ${job.id} ${status}: ${x.message}`, runbook: "docs/runbooks/crm-reconciliation.md" });
      return { id: job.id, status, error: x.message };
    }
  }
  /** Compare undelivered/unknown events with the vendor's actual records. */
  async reconcile(limit = 100) {
    const rows = await this.db.select().from(crmEvents).where(inArray(crmEvents.status, ["unknown_outcome", "permanent_failure", "retryable_failure"])).orderBy(asc(crmEvents.createdAt)).limit(limit);
    const out = { checked: 0, reconciled: 0, requeued: 0, differences: [] as Array<Record<string, unknown>> };
    for (const job of rows) {
      out.checked++; let back: CrmRecord | null = null; try { back = await this.adapter.read({ externalKey: job.externalKey, entityType: job.entityType }); } catch { continue; }
      if (back && Number(back.entity_version) >= job.entityVersion) { await this.db.update(crmEvents).set({ status: "reconciled", readback: truncate(back), readbackAt: new Date().toISOString(), leaseUntil: null }).where(eq(crmEvents.id, job.id)); await this.db.insert(crmRefs).values({ entityType: job.entityType, entityId: job.entityId, provider: this.adapter.name, externalId: String(back.id ?? job.externalKey), lastVersion: job.entityVersion }).onConflictDoUpdate({ target: [crmRefs.entityType, crmRefs.entityId, crmRefs.provider], set: { lastVersion: sql`greatest(${crmRefs.lastVersion}, ${job.entityVersion})`, updatedAt: new Date().toISOString() } }); out.reconciled++; }
      else if (job.status === "unknown_outcome") { await this.db.update(crmEvents).set({ status: "pending", nextAttemptAt: null }).where(eq(crmEvents.id, job.id)); out.requeued++; }
      else out.differences.push({ id: job.id, entity: `${job.entityType}:${job.entityId}`, vendorVersion: back?.entity_version ?? null, ourVersion: job.entityVersion, status: job.status });
    }
    return out;
  }
  async retry(id: string) { const r = await this.db.update(crmEvents).set({ status: "pending", nextAttemptAt: null, leaseUntil: null, attempts: 0 }).where(and(eq(crmEvents.id, id), inArray(crmEvents.status, ["retryable_failure", "permanent_failure", "unknown_outcome"]))).returning({ id: crmEvents.id }); return r.length > 0; }
  async summary() { const rows = await this.db.select({ status: crmEvents.status, n: sql<number>`count(*)::int` }).from(crmEvents).groupBy(crmEvents.status); const [o] = await this.db.select({ t: crmEvents.createdAt }).from(crmEvents).where(inArray(crmEvents.status, ["pending", "retryable_failure"])).orderBy(asc(crmEvents.createdAt)).limit(1); return { provider: this.adapter.name, byStatus: Object.fromEntries(rows.map((r) => [r.status, r.n])), oldestPending: o?.t ?? null }; }
  async list({ status, limit = 100 }: { status?: string | null; limit?: number }) { return this.db.select().from(crmEvents).where(status ? eq(crmEvents.status, status) : undefined).orderBy(desc(crmEvents.createdAt)).limit(limit); }
  health() { return this.adapter.health(); }
  preview(type: string, sample: Record<string, unknown>) { return mapEntity(type, { ...sample, externalKey: this.key(type, String(sample.id ?? "example")), participantKey: sample.participantId ? this.key("participant", String(sample.participantId)) : undefined }); }
}
function truncate(o: CrmRecord) { try { const s = JSON.stringify(o); return JSON.parse(s.length > 4000 ? s.slice(0, 4000) + '"}' : s); } catch { return null; } }
