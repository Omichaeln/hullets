import { sql, desc, eq, gt, and, asc } from "drizzle-orm";
import { schema, type DbOrTx, type Db } from "@promo/db";
import { canonicalJson } from "./util/json.ts";
import { sha256, hmac } from "./util/crypto.ts";
import { newId } from "./util/ids.ts";

const { auditEvents, auditCheckpoints } = schema;
const CHAIN_LOCK = 4_242_001; // advisory lock id for the audit chain head

export type AuditInput = { actorType: "staff" | "participant" | "system"; actorId: string; action: string; targetType: string; targetId?: string | null; reason?: string | null; payload?: Record<string, unknown> | null; correlationId?: string | null; campaignId?: string | null };

/**
 * Hash-chained audit log with ONE writer path. The chain head is read under a
 * transaction-scoped advisory lock, so concurrent writers serialise and the
 * chain never forks. Bodies use canonical JSON so a verifier recomputes the
 * exact bytes. Signed checkpoints let the head be retained outside the
 * database (a chain alone cannot stop a privileged operator rewriting it).
 */
export class AuditService {
  constructor(private db: Db, private signingKey: string) {}

  /** Record inside the caller's transaction (or its own). */
  async record(tx: DbOrTx, e: AuditInput): Promise<{ id: number; entryHash: string }> {
    const run = async (t: DbOrTx) => {
      await t.execute(sql`select pg_advisory_xact_lock(${CHAIN_LOCK})`);
      const head = await t.select({ h: auditEvents.entryHash }).from(auditEvents).orderBy(desc(auditEvents.id)).limit(1);
      const prev = head[0]?.h ?? "";
      const when = new Date().toISOString();
      // Normalise the payload ONCE so the column holds exactly what the body
      // signs. canonicalJson maps undefined to null and KEEPS the key; the
      // driver's JSON.stringify DROPS an undefined key on the way into jsonb. So
      // a payload like { name: undefined, status: "disabled" } was signed as
      // {"name":null,"status":"disabled"} and stored as {"status":"disabled"} —
      // the column has never been a faithful copy of the signed evidence.
      const payload = e.payload == null ? null : JSON.parse(canonicalJson(e.payload)) as Record<string, unknown>;
      const body = canonicalJson({ actorType: e.actorType, actorId: e.actorId, action: e.action, targetType: e.targetType, targetId: e.targetId ?? null, reason: e.reason ?? null, payload, when });
      const entryHash = sha256(prev + body);
      const [row] = await t.insert(auditEvents).values({ actorType: e.actorType, actorId: e.actorId, action: e.action, targetType: e.targetType, targetId: e.targetId ?? null, reason: e.reason ?? null, payload, body, prevHash: prev, entryHash, correlationId: e.correlationId ?? null, campaignId: e.campaignId ?? null, createdAt: when }).returning({ id: auditEvents.id });
      return { id: row.id, entryHash };
    };
    // an advisory *xact* lock needs a transaction; when the caller passed the root db, open one
    return tx === this.db ? this.db.transaction((t) => run(t)) : run(tx);
  }

  /**
   * Verify one bounded page of the chain.
   *
   * This used to select the whole table and hash every row on the request
   * thread. audit_events is the fastest-growing table in the system and is
   * never pruned by design, so a single click eventually became an
   * out-of-memory kill. Pages resume from the previous page's head: `nextFromId`
   * is null when the chain has been walked to its end. A full sweep belongs in
   * a job, not a request.
   */
  async verify({ fromId = 0, limit = 5_000 }: { fromId?: number; limit?: number } = {}) {
    const take = Math.max(1, Math.min(50_000, limit));
    const rows = await this.db.select({
      id: auditEvents.id, prev: auditEvents.prevHash, hash: auditEvents.entryHash, body: auditEvents.body,
      actorType: auditEvents.actorType, actorId: auditEvents.actorId, action: auditEvents.action,
      targetType: auditEvents.targetType, targetId: auditEvents.targetId, reason: auditEvents.reason,
      payload: auditEvents.payload, createdAt: auditEvents.createdAt,
    }).from(auditEvents).where(gt(auditEvents.id, fromId)).orderBy(asc(auditEvents.id)).limit(take + 1);
    const more = rows.length > take; if (more) rows.pop();
    let prev = ""; if (fromId) { const [r] = await this.db.select({ h: auditEvents.entryHash }).from(auditEvents).where(eq(auditEvents.id, fromId)); prev = r?.h ?? ""; }
    const broken: Array<{ id: number; what: string; fields?: string[] }> = [];
    for (const r of rows) {
      if (r.prev !== prev) broken.push({ id: r.id, what: "prev_mismatch" });
      if (sha256(r.prev + r.body) !== r.hash) broken.push({ id: r.id, what: "entry_mismatch" });
      // The hash covers the BODY. Every reader — audit.list(), the console, any
      // filter on actorId — reads the COLUMNS. Without this, rewriting actor_id in
      // place changed who the system said approved a draw while the chain went on
      // reporting clean: the evidence survived in the body, but nothing surfaced
      // the disagreement, so separation of duties was only provable by someone who
      // knew to parse bodies by hand.
      const fields = columnsAgreeWithBody(r);
      if (fields.length) broken.push({ id: r.id, what: "body_column_mismatch", fields });
      prev = r.hash;
    }
    return { ok: broken.length === 0, total: rows.length, brokenCount: broken.length, broken: broken.slice(0, 50), head: prev, fromId, nextFromId: more ? rows[rows.length - 1]!.id : null, complete: !more };
  }
  /** Walk the whole chain in bounded pages. For a job or a CLI, never a request. */
  async verifyAll({ pageSize = 5_000, maxPages = 10_000 } = {}) {
    let fromId = 0, total = 0, brokenCount = 0; const broken: Array<{ id: number; what: string; fields?: string[] }> = []; let head = "";
    for (let page = 0; page < maxPages; page++) {
      const r = await this.verify({ fromId, limit: pageSize });
      total += r.total; brokenCount += r.brokenCount; head = r.head;
      for (const b of r.broken) if (broken.length < 50) broken.push(b);
      if (r.nextFromId == null) return { ok: brokenCount === 0, total, brokenCount, broken, head, complete: true };
      fromId = r.nextFromId;
    }
    return { ok: brokenCount === 0, total, brokenCount, broken, head, complete: false };
  }

  async checkpoint(createdBy: string) {
    const [last] = await this.db.select({ id: auditEvents.id, h: auditEvents.entryHash }).from(auditEvents).orderBy(desc(auditEvents.id)).limit(1);
    if (!last) return null;
    const signed = !!this.signingKey; const signature = hmac(this.signingKey || "unsigned", `${last.id}|${last.h}`);
    const id = newId("ckp");
    await this.db.insert(auditCheckpoints).values({ id, uptoId: last.id, headHash: last.h, signature, signed, createdBy });
    return { id, uptoId: last.id, headHash: last.h, signature, signed };
  }

  async verifyCheckpoint(c: { uptoId: number; headHash: string; signature: string }) {
    const expected = hmac(this.signingKey || "unsigned", `${c.uptoId}|${c.headHash}`);
    const [row] = await this.db.select({ h: auditEvents.entryHash }).from(auditEvents).where(eq(auditEvents.id, c.uptoId));
    return { signatureOk: expected === c.signature, headMatches: row?.h === c.headHash };
  }

  async list({ targetType, targetId, actorId, action, campaignId, limit = 50, offset = 0 }: { targetType?: string; targetId?: string; actorId?: string; action?: string; campaignId?: string; limit?: number; offset?: number }) {
    const conds = [targetType ? eq(auditEvents.targetType, targetType) : undefined, targetId ? eq(auditEvents.targetId, targetId) : undefined, actorId ? eq(auditEvents.actorId, actorId) : undefined, action ? eq(auditEvents.action, action) : undefined, campaignId ? eq(auditEvents.campaignId, campaignId) : undefined].filter(Boolean);
    return this.db.select({ id: auditEvents.id, actorType: auditEvents.actorType, actorId: auditEvents.actorId, action: auditEvents.action, targetType: auditEvents.targetType, targetId: auditEvents.targetId, reason: auditEvents.reason, entryHash: auditEvents.entryHash, correlationId: auditEvents.correlationId, createdAt: auditEvents.createdAt, payload: auditEvents.payload }).from(auditEvents).where(conds.length ? and(...(conds as never[])) : undefined).orderBy(desc(auditEvents.id)).limit(limit).offset(offset);
  }
}

/**
 * Postgres returns timestamptz as "2026-09-16 12:11:07.067+00"; the signed body
 * carries the same instant as "2026-09-16T12:11:07.067Z". They are equal and the
 * strings are not, so they are compared as instants. The `+HH` offset Postgres
 * emits is not strict ISO 8601, which some engines refuse, so it is widened to
 * `+HH:MM` before parsing rather than relying on a lenient Date.
 */
function instant(v: string | null): number | null {
  if (!v) return null;
  const iso = v.includes("T") ? v : v.replace(" ", "T");
  const t = Date.parse(/[+-]\d{2}$/.test(iso) ? `${iso}:00` : iso);
  return Number.isFinite(t) ? t : null;
}

/** Drops null-valued keys, recursively, so an explicit null and an absent key compare equal. */
function withoutNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutNulls);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (val !== null && val !== undefined) o[k] = withoutNulls(val);
    return o;
  }
  return v;
}

type AuditRow = { body: string; actorType: string; actorId: string; action: string; targetType: string; targetId: string | null; reason: string | null; payload: Record<string, unknown> | null; createdAt: string };

/** Names the columns that disagree with the row's own signed body; empty means they agree. */
function columnsAgreeWithBody(r: AuditRow): string[] {
  let signed: Partial<AuditInput> & { when?: string };
  try { signed = JSON.parse(r.body) as typeof signed; }
  catch { return ["body_unparseable"]; }   // a body that cannot be read is itself a finding
  const out: string[] = [];
  const same = (name: string, a: unknown, b: unknown) => { if (a !== b) out.push(name); };
  same("actorType", signed.actorType, r.actorType);
  same("actorId", signed.actorId, r.actorId);
  same("action", signed.action, r.action);
  same("targetType", signed.targetType, r.targetType);
  same("targetId", signed.targetId ?? null, r.targetId);
  same("reason", signed.reason ?? null, r.reason);
  // Canonical JSON on both sides, because jsonb does not preserve key order, and
  // null-valued keys dropped first. Rows written before the writer was fixed have
  // an explicit null in the body where the column has no key at all; treating
  // those as equal keeps the check from crying wolf over every historical row,
  // and costs only the ability to notice a null being added or removed — which
  // carries no information either way. A CHANGED value is still caught, and so is
  // a real key being deleted or set to null, because then one side still holds it.
  if (canonicalJson(withoutNulls(signed.payload ?? null)) !== canonicalJson(withoutNulls(r.payload ?? null))) out.push("payload");
  const a = instant(signed.when ?? null), b = instant(r.createdAt);
  if (a === null || b === null || a !== b) out.push("createdAt");
  return out;
}
