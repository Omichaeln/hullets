import { sql, eq, and, lt, or, isNull, inArray, desc, asc } from "drizzle-orm";
import { schema, type Db, type DbOrTx } from "@promo/db";
import { newId } from "../util/ids.ts";
import { backoffMs } from "../util/time.ts";

const { outboundMessages } = schema;
export type OutboundMessage = typeof outboundMessages.$inferSelect;
export const OUTBOUND_STATES = ["pending", "sending", "sent", "delivered", "read", "retryable_failure", "permanent_failure", "unknown_outcome"] as const;
const MAX_ATTEMPTS = 6;

/**
 * Transactional outbox for WhatsApp sends. Rows are written in the same
 * transaction as the domain change; a worker leases and dispatches them.
 * `unknown_outcome` (a timeout after the provider may have accepted the
 * message) is held for reconciliation, never blindly re-sent.
 */
export class OutboxService {
  constructor(private db: Db) {}
  async enqueue(tx: DbOrTx, m: { channelUid: string; kind?: "text" | "template" | "interactive"; purpose: string; campaignId?: string | null; payload: Record<string, unknown> | string; idempotencyKey: string; correlationId?: string | null }) {
    const id = newId("out");
    const payload = typeof m.payload === "string" ? { body: m.payload } : m.payload;
    const r = await tx.insert(outboundMessages).values({ id, channelUid: m.channelUid, kind: m.kind ?? "text", purpose: m.purpose, campaignId: m.campaignId ?? null, payload, idempotencyKey: m.idempotencyKey, correlationId: m.correlationId ?? null }).onConflictDoNothing().returning({ id: outboundMessages.id });
    return { id: r[0]?.id ?? null, existed: !r.length };
  }
  async lease(leaseSeconds = 60): Promise<OutboundMessage | null> {
    return this.db.transaction(async (tx) => {
      const now = new Date().toISOString();
      const [row] = await tx.select().from(outboundMessages).where(and(or(isNull(outboundMessages.nextAttemptAt), lt(outboundMessages.nextAttemptAt, now)), or(and(inArray(outboundMessages.status, ["pending", "retryable_failure"]), or(isNull(outboundMessages.leaseUntil), lt(outboundMessages.leaseUntil, now))), and(eq(outboundMessages.status, "sending"), lt(outboundMessages.leaseUntil, now))))).orderBy(asc(outboundMessages.createdAt)).limit(1).for("update", { skipLocked: true });
      if (!row) return null;
      await tx.update(outboundMessages).set({ status: "sending", leaseUntil: new Date(Date.now() + leaseSeconds * 1000).toISOString(), attempts: row.attempts + 1 }).where(eq(outboundMessages.id, row.id));
      return { ...row, attempts: row.attempts + 1 };
    });
  }
  async markSent(id: string, providerMessageId: string | null) { await this.db.update(outboundMessages).set({ status: "sent", providerMessageId, sentAt: new Date().toISOString(), leaseUntil: null, lastError: null, errorCode: null }).where(eq(outboundMessages.id, id)); }
  async markBlocked(row: OutboundMessage, code: string, message: string, retryable: boolean) { await this.db.update(outboundMessages).set({ status: retryable ? "retryable_failure" : "permanent_failure", errorCode: code, lastError: message.slice(0, 300), leaseUntil: null, nextAttemptAt: retryable ? new Date(Date.now() + backoffMs(row.attempts, 5000, 300_000)).toISOString() : null }).where(eq(outboundMessages.id, row.id)); }
  async markFailed(row: OutboundMessage, e: { message: string; code?: string; permanent?: boolean; unknownOutcome?: boolean }) {
    const status = e.unknownOutcome ? "unknown_outcome" : e.permanent || row.attempts >= MAX_ATTEMPTS ? "permanent_failure" : "retryable_failure";
    await this.db.update(outboundMessages).set({ status, errorCode: e.code ?? null, lastError: e.message.slice(0, 300), leaseUntil: null, nextAttemptAt: status === "retryable_failure" ? new Date(Date.now() + backoffMs(row.attempts, 5000, 300_000)).toISOString() : null }).where(eq(outboundMessages.id, row.id));
    return status;
  }
  /** Provider delivery callback keyed by provider message id; out-of-order callbacks never regress state. */
  async markDelivery(providerMessageId: string, status: string, { errorCode, at }: { errorCode?: string | null; at?: string | null }) {
    const [row] = await this.db.select({ id: outboundMessages.id, status: outboundMessages.status }).from(outboundMessages).where(eq(outboundMessages.providerMessageId, providerMessageId)); if (!row) return false;
    const ts = at ?? new Date().toISOString();
    if (status === "delivered") await this.db.update(outboundMessages).set({ status: sql`case when ${outboundMessages.status} = 'read' then ${outboundMessages.status} else 'delivered' end`, deliveredAt: sql`coalesce(${outboundMessages.deliveredAt}, ${ts})` }).where(eq(outboundMessages.id, row.id));
    else if (status === "read") await this.db.update(outboundMessages).set({ status: "read", readAt: sql`coalesce(${outboundMessages.readAt}, ${ts})`, deliveredAt: sql`coalesce(${outboundMessages.deliveredAt}, ${ts})` }).where(eq(outboundMessages.id, row.id));
    else if (status === "failed") await this.db.update(outboundMessages).set({ status: "permanent_failure", errorCode: errorCode ?? "provider_failed", lastError: "provider reported failure" }).where(eq(outboundMessages.id, row.id));
    else if (status === "sent") await this.db.update(outboundMessages).set({ sentAt: sql`coalesce(${outboundMessages.sentAt}, ${ts})` }).where(eq(outboundMessages.id, row.id));
    return true;
  }
  async retry(id: string) { const r = await this.db.update(outboundMessages).set({ status: "pending", nextAttemptAt: null, leaseUntil: null, attempts: 0 }).where(and(eq(outboundMessages.id, id), inArray(outboundMessages.status, ["retryable_failure", "permanent_failure", "unknown_outcome"]))).returning({ id: outboundMessages.id }); return r.length > 0; }
  async get(id: string) { const [m] = await this.db.select().from(outboundMessages).where(eq(outboundMessages.id, id)); return m ?? null; }
  async byKeyPrefix(prefix: string) { return this.db.select().from(outboundMessages).where(sql`${outboundMessages.idempotencyKey} like ${prefix + "%"}`).orderBy(asc(outboundMessages.createdAt)); }
  async forUid(uid: string, limit = 60) { return this.db.select().from(outboundMessages).where(eq(outboundMessages.channelUid, uid)).orderBy(desc(outboundMessages.createdAt)).limit(limit); }
  async list({ status, limit = 100 }: { status?: string | null; limit?: number }) { return this.db.select().from(outboundMessages).where(status ? eq(outboundMessages.status, status) : undefined).orderBy(desc(outboundMessages.createdAt)).limit(limit); }
  async stats() { const rows = await this.db.select({ status: outboundMessages.status, n: sql<number>`count(*)::int` }).from(outboundMessages).groupBy(outboundMessages.status); const [o] = await this.db.select({ t: outboundMessages.createdAt }).from(outboundMessages).where(inArray(outboundMessages.status, ["pending", "retryable_failure"])).orderBy(asc(outboundMessages.createdAt)).limit(1); const [ls] = await this.db.select({ t: sql<string | null>`max(${outboundMessages.sentAt})` }).from(outboundMessages); return { byStatus: Object.fromEntries(rows.map((r) => [r.status, r.n])), oldestPending: o?.t ?? null, lastSentAt: ls?.t ?? null }; }
}
