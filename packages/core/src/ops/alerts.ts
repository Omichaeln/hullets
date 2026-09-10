import { eq, and, isNull, gt, desc, sql } from "drizzle-orm";
import { schema, type Db } from "@promo/db";
import { newId } from "../util/ids.ts";
import type { AlertSink } from "../receipt/pipeline.ts";
const { alerts, metrics } = schema;
/** Actionable alerts (de-duplicated per kind within an hour, each linked to a runbook) and business metrics. */
export class OpsSignals implements AlertSink {
  constructor(private db: Db) {}
  async raise(a: { kind: string; severity: "info" | "warning" | "critical"; message: string; runbook?: string; detail?: Record<string, unknown> }) {
    const [open] = await this.db.select({ id: alerts.id }).from(alerts).where(and(eq(alerts.kind, a.kind), isNull(alerts.ackedAt), gt(alerts.createdAt, new Date(Date.now() - 3_600_000).toISOString())));
    if (open) return;
    await this.db.insert(alerts).values({ id: newId("alr"), kind: a.kind, severity: a.severity, message: a.message.slice(0, 500), runbook: a.runbook ?? null, detail: a.detail ?? null });
  }
  async metric(name: string, value = 1, labels?: Record<string, unknown>) { await this.db.insert(metrics).values({ name, value, labels: labels ?? null }); }
  async open() { return this.db.select().from(alerts).where(isNull(alerts.ackedAt)).orderBy(desc(alerts.createdAt)).limit(100); }
  async all() { return this.db.select().from(alerts).orderBy(desc(alerts.createdAt)).limit(200); }
  async ack(id: string, actorId: string) { const r = await this.db.update(alerts).set({ ackedBy: actorId, ackedAt: new Date().toISOString() }).where(and(eq(alerts.id, id), isNull(alerts.ackedAt))).returning({ id: alerts.id }); return r.length > 0; }
  async metricSeries(name: string, sinceIso: string) { return this.db.select({ at: metrics.at, value: metrics.value, labels: metrics.labels }).from(metrics).where(and(eq(metrics.name, name), gt(metrics.at, sinceIso))).orderBy(metrics.at).limit(5000); }
  async counts(sinceIso: string) { return this.db.select({ name: metrics.name, n: sql<number>`count(*)::int`, sum: sql<number>`sum(${metrics.value})::float` }).from(metrics).where(gt(metrics.at, sinceIso)).groupBy(metrics.name); }
}
