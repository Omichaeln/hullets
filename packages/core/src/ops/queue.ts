import { sql, eq, and, lt, or, isNull, inArray, desc, asc } from "drizzle-orm";
import { schema, type Db, type DbOrTx } from "@promo/db";
import { newId } from "../util/ids.ts";
import { backoffMs } from "../util/time.ts";

const { inboundEvents, jobs } = schema;
export type InboundEvent = typeof inboundEvents.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type NormalisedEvent = { provider: string; providerAccount?: string; providerMessageId: string; kind: "message.text" | "message.image" | "message.document" | "message.unsupported" | "delivery.status"; channelUid: string | null; text?: string; mediaId?: string | null; mime?: string | null; inlineMediaB64?: string | null; status?: string | null; errorCode?: string | null; timestamp?: string | null; raw?: Record<string, unknown> | null };

/**
 * Durable queues on PostgreSQL: inbound provider events (unique per provider,
 * account, message and kind) and background jobs. Leasing uses
 * FOR UPDATE SKIP LOCKED, so several workers can drain safely; a crashed
 * worker's lease expires and the item is re-taken; bounded attempts, then
 * dead letter (visible and replayable).
 */
export class QueueService {
  constructor(private db: Db) {}
  /** Persist before acknowledging. Returns duplicate=true for a replay. */
  async receive(ev: NormalisedEvent, correlationId = newId("corr")) {
    const kind = ev.kind === "delivery.status" ? `delivery.status:${ev.status ?? "unknown"}` : ev.kind;
    const id = newId("evt");
    const r = await this.db.insert(inboundEvents).values({ id, provider: ev.provider, providerAccount: ev.providerAccount ?? "default", providerMessageId: ev.providerMessageId, kind, channelUid: ev.channelUid, payload: { text: ev.text ?? "", mediaId: ev.mediaId ?? null, mime: ev.mime ?? null, inlineMediaB64: ev.inlineMediaB64 ?? null, status: ev.status ?? null, errorCode: ev.errorCode ?? null, timestamp: ev.timestamp ?? null, raw: ev.raw ? truncate(ev.raw) : null }, correlationId }).onConflictDoNothing().returning({ id: inboundEvents.id });
    if (!r.length) { const [ex] = await this.db.select({ id: inboundEvents.id }).from(inboundEvents).where(and(eq(inboundEvents.provider, ev.provider), eq(inboundEvents.providerAccount, ev.providerAccount ?? "default"), eq(inboundEvents.providerMessageId, ev.providerMessageId), eq(inboundEvents.kind, kind))); return { accepted: false, duplicate: true, id: ex?.id ?? null, correlationId: null }; }
    return { accepted: true, duplicate: false, id, correlationId };
  }
  /** Lease the oldest runnable event. Returns null when the queue is empty. */
  async leaseEvent(leaseSeconds = 90, maxAttempts = 5): Promise<InboundEvent | null> {
    return this.db.transaction(async (tx) => {
      const now = new Date().toISOString();
      const [row] = await tx.select().from(inboundEvents).where(and(or(and(inArray(inboundEvents.status, ["received", "failed"]), or(isNull(inboundEvents.leaseUntil), lt(inboundEvents.leaseUntil, now))), and(eq(inboundEvents.status, "processing"), lt(inboundEvents.leaseUntil, now))), lt(inboundEvents.attempts, maxAttempts))).orderBy(asc(inboundEvents.receivedAt)).limit(1).for("update", { skipLocked: true });
      if (!row) return null;
      await tx.update(inboundEvents).set({ status: "processing", leaseUntil: new Date(Date.now() + leaseSeconds * 1000).toISOString(), attempts: row.attempts + 1 }).where(eq(inboundEvents.id, row.id));
      return { ...row, attempts: row.attempts + 1 };
    });
  }
  async completeEvent(id: string, result: Record<string, unknown>) { await this.db.update(inboundEvents).set({ status: "processed", processedAt: new Date().toISOString(), leaseUntil: null, result, error: null }).where(eq(inboundEvents.id, id)); }
  async ignoreEvent(id: string, why: string) { await this.db.update(inboundEvents).set({ status: "ignored", processedAt: new Date().toISOString(), leaseUntil: null, result: { ignored: why } }).where(eq(inboundEvents.id, id)); }
  async failEvent(ev: InboundEvent, error: string, maxAttempts = 5) { const dead = ev.attempts >= maxAttempts; await this.db.update(inboundEvents).set({ status: dead ? "dead" : "failed", leaseUntil: dead ? null : new Date(Date.now() + backoffMs(ev.attempts, 2000, 60_000)).toISOString(), error: error.slice(0, 400) }).where(eq(inboundEvents.id, ev.id)); return dead; }
  async replayEvent(id: string) { const r = await this.db.update(inboundEvents).set({ status: "received", attempts: 0, leaseUntil: null, error: null }).where(and(eq(inboundEvents.id, id), inArray(inboundEvents.status, ["dead", "failed"]))).returning({ id: inboundEvents.id }); return r.length > 0; }

  async enqueueJob(tx: DbOrTx, kind: string, payload: Record<string, unknown>, { runAfter, correlationId, dedupeKey, maxAttempts = 6 }: { runAfter?: string; correlationId?: string | null; dedupeKey?: string | null; maxAttempts?: number } = {}) {
    const id = newId("job");
    const r = await tx.insert(jobs).values({ id, kind, payload, runAfter: runAfter ?? new Date().toISOString(), correlationId: correlationId ?? null, dedupeKey: dedupeKey ?? null, maxAttempts }).onConflictDoNothing().returning({ id: jobs.id });
    return r[0]?.id ?? null;
  }
  async leaseJob(leaseSeconds = 120): Promise<Job | null> {
    return this.db.transaction(async (tx) => {
      const now = new Date().toISOString();
      const [row] = await tx.select().from(jobs).where(and(or(and(inArray(jobs.status, ["pending", "failed"]), or(isNull(jobs.leaseUntil), lt(jobs.leaseUntil, now))), and(eq(jobs.status, "processing"), lt(jobs.leaseUntil, now))), sql`${jobs.runAfter} <= ${now}`, sql`${jobs.attempts} < ${jobs.maxAttempts}`)).orderBy(asc(jobs.runAfter), asc(jobs.createdAt)).limit(1).for("update", { skipLocked: true });
      if (!row) return null;
      await tx.update(jobs).set({ status: "processing", leaseUntil: new Date(Date.now() + leaseSeconds * 1000).toISOString(), attempts: row.attempts + 1 }).where(eq(jobs.id, row.id));
      return { ...row, attempts: row.attempts + 1 };
    });
  }
  /**
   * Completing a job KEEPS its dedupe key.
   *
   * Clearing it meant the partial unique index no longer matched, so
   * housekeeping re-enqueued the same hourly and daily jobs on every cycle —
   * roughly once a minute. The audit checkpoint documented as "a signed chain
   * head every day" was being written 1,440 times a day per worker. Keys are
   * time-scoped by their callers, so retaining them is what makes the schedule
   * mean anything; `sweepJobs` reclaims them once the window has passed.
   */
  async completeJob(id: string) { await this.db.update(jobs).set({ status: "done", finishedAt: new Date().toISOString(), leaseUntil: null }).where(eq(jobs.id, id)); }
  /** Drop finished jobs old enough that their dedupe window cannot still apply. */
  async sweepJobs(olderThanMs = 7 * 86_400_000) {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const r = await this.db.delete(jobs).where(and(inArray(jobs.status, ["done"]), lt(jobs.createdAt, cutoff))).returning({ id: jobs.id });
    return r.length;
  }
  async failJob(job: Job, error: string, permanent = false) { const dead = permanent || job.attempts >= job.maxAttempts; await this.db.update(jobs).set({ status: dead ? "dead" : "failed", leaseUntil: null, lastError: error.slice(0, 400), runAfter: dead ? job.runAfter : new Date(Date.now() + backoffMs(job.attempts, 3000, 120_000)).toISOString() }).where(eq(jobs.id, job.id)); return dead; }
  async retryJob(id: string) { const r = await this.db.update(jobs).set({ status: "pending", attempts: 0, leaseUntil: null, runAfter: new Date().toISOString() }).where(and(eq(jobs.id, id), inArray(jobs.status, ["dead", "failed"]))).returning({ id: jobs.id }); return r.length > 0; }

  async stats() {
    const ev = await this.db.select({ status: inboundEvents.status, n: sql<number>`count(*)::int` }).from(inboundEvents).groupBy(inboundEvents.status);
    const jb = await this.db.select({ status: jobs.status, n: sql<number>`count(*)::int` }).from(jobs).groupBy(jobs.status);
    const [oe] = await this.db.select({ t: inboundEvents.receivedAt }).from(inboundEvents).where(inArray(inboundEvents.status, ["received", "failed"])).orderBy(asc(inboundEvents.receivedAt)).limit(1);
    const [oj] = await this.db.select({ t: jobs.createdAt }).from(jobs).where(inArray(jobs.status, ["pending", "failed"])).orderBy(asc(jobs.createdAt)).limit(1);
    return { events: Object.fromEntries(ev.map((r) => [r.status, r.n])), jobs: Object.fromEntries(jb.map((r) => [r.status, r.n])), oldestEvent: oe?.t ?? null, oldestJob: oj?.t ?? null };
  }
  async deadLetters() { return { events: await this.db.select().from(inboundEvents).where(inArray(inboundEvents.status, ["dead", "failed"])).orderBy(desc(inboundEvents.receivedAt)).limit(50), jobs: await this.db.select().from(jobs).where(inArray(jobs.status, ["dead", "failed"])).orderBy(desc(jobs.createdAt)).limit(50) };
  }
  async eventsFor(uid: string, limit = 60) { return this.db.select().from(inboundEvents).where(eq(inboundEvents.channelUid, uid)).orderBy(desc(inboundEvents.receivedAt)).limit(limit); }
  async event(id: string) { const [e] = await this.db.select().from(inboundEvents).where(eq(inboundEvents.id, id)); return e ?? null; }
  async lastInboundAt(uid: string) { const [e] = await this.db.select({ t: inboundEvents.receivedAt }).from(inboundEvents).where(and(eq(inboundEvents.channelUid, uid), sql`${inboundEvents.kind} like 'message.%'`)).orderBy(desc(inboundEvents.receivedAt)).limit(1); return e?.t ?? null; }
}
function truncate(raw: Record<string, unknown>) { try { const s = JSON.stringify(raw); return JSON.parse(s.length > 4000 ? s.slice(0, 4000) + '"' : s); } catch { return null; } }
