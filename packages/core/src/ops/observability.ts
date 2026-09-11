import crypto from "node:crypto";
import os from "node:os";
import { and, desc, eq, gt, isNull, like, lt, sql, type SQL } from "drizzle-orm";
import { schema, type Db } from "@promo/db";
import { newId } from "../util/ids.ts";
const { errorEvents, healthSamples, inboundEvents, outboundMessages, metrics } = schema;

/**
 * Operational visibility: an error log every failure the platform handled is
 * written to (redacted, fingerprinted, resolvable), and health samples the
 * worker writes once a minute so uptime, throughput and backlog have a history.
 * Nothing here is on the request path's critical section: a failed insert is
 * logged and swallowed, never re-thrown into the failure it is describing.
 */
export type ErrorSource = "http" | "trpc" | "webhook" | "worker.event" | "worker.job" | "worker.outbound" | "worker.tick" | "housekeeping" | "console";
export const ERROR_SOURCES: ErrorSource[] = ["http", "trpc", "webhook", "worker.event", "worker.job", "worker.outbound", "worker.tick", "housekeeping", "console"];
export const SAMPLE_INTERVAL_SEC = 60;
export const SAMPLE_RETENTION_DAYS = 30;
export const ERROR_RETENTION_DAYS = 90;
const COVERAGE_FACTOR = 2.5; // a sample vouches for at most this many intervals; beyond it the service was not reporting

const SENSITIVE_KEY = /identity|phone|password|token|secret|authorization|ocr|text|body|payload|email|name/i;

/** Free-text error messages may quote anything; strip what could identify a person or leak internals before storing. */
export function redactMessage(m: unknown): string {
  return String(m ?? "error").replace(/\s+/g, " ")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]")
    .replace(/\b(bearer|token|secret|password|api[_-]?key)\b(\s*[:=]?\s*)\S+/gi, "$1$2[redacted]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, (d) => { const digits = d.replace(/\D/g, ""); return digits.length >= 9 ? `***${digits.slice(-4)}` : d; })
    .replace(/(?:\/[\w.-]+){3,}/g, "[path]")
    .trim().slice(0, 500) || "error";
}
/** Detail objects are stored shallowly, with sensitive keys dropped and every string redacted. */
export function sanitiseDetail(d: Record<string, unknown> | undefined | null): Record<string, unknown> | null {
  if (!d) return null; const out: Record<string, unknown> = {}; let n = 0;
  for (const [k, v] of Object.entries(d)) { if (SENSITIVE_KEY.test(k) || n >= 20) continue; n++; out[k] = typeof v === "string" ? redactMessage(v) : typeof v === "number" || typeof v === "boolean" || v === null ? v : Array.isArray(v) ? `[array ${v.length}]` : typeof v === "object" ? "[object]" : String(v); }
  return out;
}
/** Stable identity of a failure across occurrences: identifiers and numbers vary, the shape does not. */
export function fingerprintOf(e: { source: string; code: string; path?: string | null; message: string }): string {
  const norm = redactMessage(e.message).toLowerCase().replace(/\b[a-z]{2,4}_[a-z0-9*_-]{6,}\b/g, "<id>").replace(/[0-9a-f*]{16,}/g, "<hex>").replace(/\*+\d+/g, "<num>").replace(/\d+/g, "#");
  return crypto.createHash("sha256").update(`${e.source}|${e.code}|${e.path ?? ""}|${norm}`).digest("hex").slice(0, 16);
}

export type Availability = { observedFrom: string | null; availabilityPct: number | null; downtimeSec: number; degradedSec: number; observedSec: number; samples: number; gaps: Array<{ from: string; to: string; seconds: number; kind: "no_samples" | "degraded"; ongoing: boolean }> };
/**
 * Availability from samples: each sample vouches for its status until the next one, up to
 * COVERAGE_FACTOR intervals; time beyond that is a gap (the service was not reporting). The
 * window starts at the first sample inside it, so a service deployed yesterday is not
 * charged for the days before it existed.
 */
export function availability(samples: Array<{ at: string; ok: boolean }>, untilIso: string, intervalSec = SAMPLE_INTERVAL_SEC): Availability {
  const rows = [...samples].map((s) => ({ t: Date.parse(s.at), ok: s.ok })).filter((s) => Number.isFinite(s.t)).sort((a, b) => a.t - b.t);
  const until = Date.parse(untilIso); const cover = intervalSec * COVERAGE_FACTOR * 1000;
  if (!rows.length) return { observedFrom: null, availabilityPct: null, downtimeSec: 0, degradedSec: 0, observedSec: 0, samples: 0, gaps: [] };
  const gaps: Availability["gaps"] = []; let down = 0, degraded = 0; let degradedFrom: number | null = null;
  const closeDegraded = (to: number) => { if (degradedFrom != null) { degraded += to - degradedFrom; gaps.push({ from: new Date(degradedFrom).toISOString(), to: new Date(to).toISOString(), seconds: Math.round((to - degradedFrom) / 1000), kind: "degraded", ongoing: false }); degradedFrom = null; } };
  for (let i = 0; i < rows.length; i++) {
    const s = rows[i]; const next = i + 1 < rows.length ? rows[i + 1].t : until; const span = Math.max(0, next - s.t); const vouched = Math.min(span, cover);
    if (!s.ok && degradedFrom == null) degradedFrom = s.t; if (s.ok) closeDegraded(s.t);
    if (span > cover) { closeDegraded(s.t + vouched); const from = s.t + vouched; down += next - from; gaps.push({ from: new Date(from).toISOString(), to: new Date(next).toISOString(), seconds: Math.round((next - from) / 1000), kind: "no_samples", ongoing: i + 1 >= rows.length }); }
  }
  const last = rows[rows.length - 1]; if (degradedFrom != null) { const to = Math.min(until, last.t + cover); degraded += to - degradedFrom; gaps.push({ from: new Date(degradedFrom).toISOString(), to: new Date(to).toISOString(), seconds: Math.round((to - degradedFrom) / 1000), kind: "degraded", ongoing: to >= until }); }
  const observed = Math.max(0, until - rows[0].t); const pct = observed > 0 ? Math.max(0, 100 * (1 - (down + degraded) / observed)) : null;
  return { observedFrom: new Date(rows[0].t).toISOString(), availabilityPct: pct == null ? null : Math.round(pct * 1000) / 1000, downtimeSec: Math.round(down / 1000), degradedSec: Math.round(degraded / 1000), observedSec: Math.round(observed / 1000), samples: rows.length, gaps: gaps.sort((a, b) => a.from.localeCompare(b.from)) };
}

export type ErrorInput = { source: ErrorSource; code: string; message: unknown; path?: string | null; correlationId?: string | null; actorId?: string | null; ref?: Record<string, string | null | undefined> | null; detail?: Record<string, unknown> | null };
export type SampleDeps = { queue: { stats(): Promise<{ events: Record<string, number>; jobs: Record<string, number> }> }; outbox: { stats(): Promise<{ byStatus: Record<string, number> }> }; review: { reviewQueue(): Promise<{ overdue: number }> }; checks: () => Promise<Record<string, { ok: boolean; [k: string]: unknown }>>; worker: { lastTickAt: string | null; intervalMs: number } };

export class Observability {
  private startedAt = Date.now(); private sampleCount = 0; readonly processName = `${os.hostname()}:${process.pid}`;
  constructor(private db: Db, private log: { warn: (o: object, m: string) => void }) {}

  /** Record a handled failure. Never throws. */
  async record(e: ErrorInput): Promise<string | null> {
    try {
      const message = redactMessage(e.message); const code = String(e.code || "ERROR").slice(0, 64); const path = e.path ? String(e.path).slice(0, 200) : null;
      const ref = e.ref ? Object.fromEntries(Object.entries(e.ref).filter(([k, v]) => v && !SENSITIVE_KEY.test(k)).map(([k, v]) => [k, String(v).slice(0, 120)])) : null;
      const id = newId("err");
      await this.db.insert(errorEvents).values({ id, source: e.source, code, message, fingerprint: fingerprintOf({ source: e.source, code, path, message }), path, correlationId: e.correlationId?.slice(0, 64) ?? null, actorId: e.actorId ?? null, ref: ref && Object.keys(ref).length ? ref : null, detail: sanitiseDetail(e.detail) });
      return id;
    } catch (err) { this.log.warn({ err: (err as Error).message, source: e.source, code: e.code }, "error event not recorded"); return null; }
  }
  async list(f: { since: string; source?: string | null; code?: string | null; fingerprint?: string | null; open?: boolean; limit?: number }) {
    const w: SQL[] = [gt(errorEvents.occurredAt, f.since)]; if (f.source) w.push(eq(errorEvents.source, f.source)); if (f.code) w.push(eq(errorEvents.code, f.code)); if (f.fingerprint) w.push(eq(errorEvents.fingerprint, f.fingerprint)); if (f.open) w.push(isNull(errorEvents.resolvedAt));
    return this.db.select().from(errorEvents).where(and(...w)).orderBy(desc(errorEvents.occurredAt)).limit(Math.min(f.limit ?? 100, 500));
  }
  async get(id: string) { const [r] = await this.db.select().from(errorEvents).where(eq(errorEvents.id, id)); return r ?? null; }
  /** Grouped by fingerprint: what is failing, how often, and whether anyone has dealt with it. */
  async summary(since: string, { open = false } = {}) {
    const w: SQL[] = [gt(errorEvents.occurredAt, since)]; if (open) w.push(isNull(errorEvents.resolvedAt));
    const rows = await this.db.select({ fingerprint: errorEvents.fingerprint, source: errorEvents.source, code: errorEvents.code, path: errorEvents.path, message: sql<string>`min(${errorEvents.message})`, count: sql<number>`count(*)::int`, open: sql<number>`count(*) filter (where ${errorEvents.resolvedAt} is null)::int`, firstAt: sql<string>`min(${errorEvents.occurredAt})`, lastAt: sql<string>`max(${errorEvents.occurredAt})` })
      .from(errorEvents).where(and(...w)).groupBy(errorEvents.fingerprint, errorEvents.source, errorEvents.code, errorEvents.path).orderBy(sql`max(${errorEvents.occurredAt}) desc`).limit(200);
    return rows.map((r) => ({ ...r, firstAt: new Date(r.firstAt).toISOString(), lastAt: new Date(r.lastAt).toISOString() }));
  }
  async countSince(since: string) { const [r] = await this.db.select({ n: sql<number>`count(*)::int`, open: sql<number>`count(*) filter (where ${errorEvents.resolvedAt} is null)::int` }).from(errorEvents).where(gt(errorEvents.occurredAt, since)); return { total: r?.n ?? 0, open: r?.open ?? 0 }; }
  /** Mark occurrences as dealt with (by id, or every open occurrence of a fingerprint). Returns how many were closed. */
  async resolve(sel: { id?: string | null; fingerprint?: string | null }, actorId: string) {
    const w: SQL[] = [isNull(errorEvents.resolvedAt)]; if (sel.id) w.push(eq(errorEvents.id, sel.id)); else if (sel.fingerprint) w.push(eq(errorEvents.fingerprint, sel.fingerprint)); else return 0;
    const r = await this.db.update(errorEvents).set({ resolvedAt: new Date().toISOString(), resolvedBy: actorId }).where(and(...w)).returning({ id: errorEvents.id }); return r.length;
  }

  /** One health sample: checks, backlog gauges, and counters since the previous sample (from any process). */
  async sample(deps: SampleDeps) {
    const now = new Date(); const [prev] = await this.db.select({ at: sql<string>`max(${healthSamples.at})` }).from(healthSamples);
    const sinceIso = prev?.at ? new Date(prev.at).toISOString() : new Date(now.getTime() - SAMPLE_INTERVAL_SEC * 1000).toISOString();
    const [checks, q, ob, rq] = await Promise.all([deps.checks().catch((e: Error) => ({ checks: { ok: false, error: redactMessage(e.message) } })), deps.queue.stats(), deps.outbox.stats(), deps.review.reviewQueue()]);
    const n = async (q: Promise<Array<{ n: number }>>) => (await q)[0]?.n ?? 0; const c = sql<number>`count(*)::int`;
    const [inbound, processed, outbound, errors] = await Promise.all([
      n(this.db.select({ n: c }).from(inboundEvents).where(and(gt(inboundEvents.receivedAt, sinceIso), like(inboundEvents.kind, "message.%")))),
      n(this.db.select({ n: c }).from(metrics).where(and(eq(metrics.name, "inbound.processed"), gt(metrics.at, sinceIso)))),
      n(this.db.select({ n: c }).from(outboundMessages).where(gt(outboundMessages.sentAt, sinceIso))),
      n(this.db.select({ n: c }).from(errorEvents).where(gt(errorEvents.occurredAt, sinceIso))),
    ]);
    const ok = Object.values(checks).every((c) => c && (c as { ok?: boolean }).ok !== false);
    const lag = deps.worker.lastTickAt ? Math.max(0, now.getTime() - Date.parse(deps.worker.lastTickAt) - deps.worker.intervalMs) : 0;
    const row = { at: now.toISOString(), process: this.processName, ok, uptimeSec: Math.round((now.getTime() - this.startedAt) / 1000), inbound, processed, outbound, errors,
      waitingEvents: (q.events.received ?? 0) + (q.events.failed ?? 0), waitingJobs: (q.jobs.pending ?? 0) + (q.jobs.failed ?? 0), deadLetters: (q.events.dead ?? 0) + (q.jobs.dead ?? 0),
      outboundFailures: (ob.byStatus.permanent_failure ?? 0) + (ob.byStatus.unknown_outcome ?? 0) + (ob.byStatus.retryable_failure ?? 0), reviewOverdue: rq.overdue, tickLagMs: Math.round(lag), memoryMb: Math.round(process.memoryUsage().rss / 1048576 * 10) / 10, checks: checks as Record<string, unknown> };
    await this.db.insert(healthSamples).values(row);
    if (++this.sampleCount % 60 === 1) await this.purge();
    return row;
  }
  /** Samples in a window, bucketed for charting (counters summed, gauges at their maximum), plus availability over the raw samples. */
  async history(sinceIso: string, bucketSec: number) {
    const rows = await this.db.select().from(healthSamples).where(gt(healthSamples.at, sinceIso)).orderBy(healthSamples.at).limit(50_000);
    const b = new Map<number, { at: string; samples: number; okSamples: number; inbound: number; processed: number; outbound: number; errors: number; waitingEvents: number; waitingJobs: number; deadLetters: number; outboundFailures: number; reviewOverdue: number; tickLagMs: number; memoryMb: number }>();
    for (const r of rows) {
      const t = Math.floor(Date.parse(r.at) / (bucketSec * 1000)) * bucketSec * 1000; let x = b.get(t);
      if (!x) { x = { at: new Date(t).toISOString(), samples: 0, okSamples: 0, inbound: 0, processed: 0, outbound: 0, errors: 0, waitingEvents: 0, waitingJobs: 0, deadLetters: 0, outboundFailures: 0, reviewOverdue: 0, tickLagMs: 0, memoryMb: 0 }; b.set(t, x); }
      x.samples++; if (r.ok) x.okSamples++; x.inbound += r.inbound; x.processed += r.processed; x.outbound += r.outbound; x.errors += r.errors;
      x.waitingEvents = Math.max(x.waitingEvents, r.waitingEvents); x.waitingJobs = Math.max(x.waitingJobs, r.waitingJobs); x.deadLetters = Math.max(x.deadLetters, r.deadLetters); x.outboundFailures = Math.max(x.outboundFailures, r.outboundFailures); x.reviewOverdue = Math.max(x.reviewOverdue, r.reviewOverdue); x.tickLagMs = Math.max(x.tickLagMs, r.tickLagMs); x.memoryMb = Math.max(x.memoryMb, r.memoryMb);
    }
    const latest = rows[rows.length - 1] ?? null;
    return { buckets: [...b.values()], availability: availability(rows.map((r) => ({ at: r.at, ok: r.ok })), new Date().toISOString()), latest: latest ? { at: latest.at, ok: latest.ok, process: latest.process, uptimeSec: latest.uptimeSec, checks: latest.checks, memoryMb: latest.memoryMb, tickLagMs: latest.tickLagMs } : null, processes: [...new Set(rows.slice(-30).map((r) => r.process))] };
  }
  async purge() {
    await this.db.delete(healthSamples).where(lt(healthSamples.at, new Date(Date.now() - SAMPLE_RETENTION_DAYS * 86_400_000).toISOString()));
    await this.db.delete(errorEvents).where(lt(errorEvents.occurredAt, new Date(Date.now() - ERROR_RETENTION_DAYS * 86_400_000).toISOString()));
  }
}
