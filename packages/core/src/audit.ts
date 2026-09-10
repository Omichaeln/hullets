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
      const body = canonicalJson({ actorType: e.actorType, actorId: e.actorId, action: e.action, targetType: e.targetType, targetId: e.targetId ?? null, reason: e.reason ?? null, payload: e.payload ?? null, when });
      const entryHash = sha256(prev + body);
      const [row] = await t.insert(auditEvents).values({ actorType: e.actorType, actorId: e.actorId, action: e.action, targetType: e.targetType, targetId: e.targetId ?? null, reason: e.reason ?? null, payload: e.payload ?? null, body, prevHash: prev, entryHash, correlationId: e.correlationId ?? null, campaignId: e.campaignId ?? null, createdAt: when }).returning({ id: auditEvents.id });
      return { id: row.id, entryHash };
    };
    // an advisory *xact* lock needs a transaction; when the caller passed the root db, open one
    return tx === this.db ? this.db.transaction((t) => run(t)) : run(tx);
  }

  async verify({ fromId = 0 } = {}) {
    const rows = await this.db.select({ id: auditEvents.id, prev: auditEvents.prevHash, hash: auditEvents.entryHash, body: auditEvents.body }).from(auditEvents).where(gt(auditEvents.id, fromId)).orderBy(asc(auditEvents.id));
    let prev = ""; if (fromId) { const [r] = await this.db.select({ h: auditEvents.entryHash }).from(auditEvents).where(eq(auditEvents.id, fromId)); prev = r?.h ?? ""; }
    const broken: Array<{ id: number; what: string }> = [];
    for (const r of rows) { if (r.prev !== prev) broken.push({ id: r.id, what: "prev_mismatch" }); if (sha256(r.prev + r.body) !== r.hash) broken.push({ id: r.id, what: "entry_mismatch" }); prev = r.hash; }
    return { ok: broken.length === 0, total: rows.length, brokenCount: broken.length, broken: broken.slice(0, 50), head: prev };
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
