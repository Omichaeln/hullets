import crypto from "node:crypto";
import { eq, and, inArray, desc, asc, sql, notInArray } from "drizzle-orm";
import { schema, type Db } from "@promo/db";
import { newId } from "../util/ids.ts";
import { hashOf } from "../util/json.ts";
import { conflict, notFound, err, invalid } from "../util/errors.ts";
import type { AuditService } from "../audit.ts";
import type { CampaignService } from "../campaign/service.ts";
import { PrizePlan } from "../campaign/types.ts";
import { ALGORITHM, VERIFIER_VERSION, computeOutput, planFrom, seedCommitment, type Candidate, type Plan } from "./engine.ts";

const { draws, drawCandidates, drawAttempts, entries, participants, submissions, winners, auditEvents, campaignPeriods } = schema;
export type Draw = typeof draws.$inferSelect;
const DRAW_LOCK = 4_242_100;

/**
 * Auditable draws. freeze(): cutoff barrier -> immutable ordered snapshot +
 * randomness committed (seed generated from the OS CSPRNG, its hash recorded
 * with the snapshot) BEFORE any result exists. execute(): one durable
 * reservation; the result is a pure function of (snapshot, seed, plan), so a
 * crashed or repeated execution resumes to the same result. approve(): a
 * different person, verifying the stored output hash they reviewed. An
 * approved draw is never edited; a permitted replacement is a new linked draw.
 */
export class DrawService {
  constructor(private db: Db, private deps: { campaigns: CampaignService; audit: AuditService }) {}

  async barrier(campaignId: string, periodId: string) {
    const period = await this.deps.campaigns.period(periodId); if (!period || period.campaignId !== campaignId) throw notFound("period");
    const campaign = (await this.deps.campaigns.get(campaignId))!; const version = await this.deps.campaigns.activeVersion(campaignId);
    const plan: Plan = planFrom(period.prizePlan ? PrizePlan.parse(period.prizePlan) : this.deps.campaigns.planOf(version));
    const blockers: Array<{ code: string; detail?: unknown }> = [];
    if (Date.parse(period.endsAt) > Date.now()) blockers.push({ code: "PERIOD_OPEN", detail: { endsAt: period.endsAt } });
    const unresolved = await this.db.select({ status: submissions.status, n: sql<number>`count(*)::int` }).from(submissions).where(and(eq(submissions.campaignId, campaignId), eq(submissions.periodCode, period.code), sql`${submissions.intakeAt} < ${period.endsAt}`, inArray(submissions.status, ["received", "processing", "delayed", "review"]))).groupBy(submissions.status);
    if (unresolved.length) blockers.push({ code: "UNRESOLVED_SUBMISSIONS", detail: Object.fromEntries(unresolved.map((u) => [u.status, u.n])) });
    const [existing] = await this.db.select({ id: draws.id, status: draws.status }).from(draws).where(and(eq(draws.periodId, periodId), sql`${draws.status} <> 'voided'`)).orderBy(desc(draws.createdAt)).limit(1);
    if (existing) blockers.push({ code: "DRAW_EXISTS", detail: existing });
    if (!plan.totalWinners) blockers.push({ code: "NO_PRIZE_PLAN" });
    const rows = await this.db.select({ id: entries.id, participantId: entries.participantId, units: entries.units }).from(entries).innerJoin(participants, eq(participants.id, entries.participantId)).where(and(eq(entries.campaignId, campaignId), eq(entries.periodCode, period.code), eq(entries.status, "active"), eq(participants.status, "active"))).orderBy(asc(entries.id));
    const exclusions: Array<{ entryId: string; participantId: string; reason: string }> = []; let eligible = rows;
    if (this.deps.campaigns.rulesOf(version).eligibility.priorWinnerExclusion === "campaign") {
      const prior = new Set((await this.db.select({ p: winners.participantId }).from(winners).innerJoin(draws, eq(draws.id, winners.drawId)).where(and(eq(draws.campaignId, campaignId), inArray(draws.status, ["approved", "published"]), eq(winners.kind, "winner"), notInArray(winners.status, ["replaced", "ineligible", "expired", "declined"])))).map((r) => r.p));
      eligible = rows.filter((r) => { if (prior.has(r.participantId)) { exclusions.push({ entryId: r.id, participantId: r.participantId, reason: "prior_winner" }); return false; } return true; });
    }
    const distinct = new Set(eligible.map((r) => r.participantId)).size;
    if (!eligible.length) blockers.push({ code: "NO_CANDIDATES" });
    else if (plan.onePrizePerParticipant ? distinct < plan.totalWinners : eligible.length < plan.totalWinners) blockers.push({ code: "INSUFFICIENT_CANDIDATES", detail: { eligibleEntries: eligible.length, distinctParticipants: distinct, required: plan.totalWinners } });
    return { period, campaign, plan, blockers, ok: blockers.length === 0, eligible: eligible.map((r) => ({ entryId: r.id, participantId: r.participantId, units: r.units })) as Candidate[], exclusions, distinctParticipants: distinct, rulesVersionHash: version?.configHash ?? null };
  }

  async freeze({ campaignId, periodId, actorId, override }: { campaignId: string; periodId: string; actorId: string; override?: { allow: string[]; reason: string } | null }) {
    const controls = await this.deps.campaigns.controls(campaignId); if (controls.pauseDraws) throw conflict("draws are paused for this campaign");
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${DRAW_LOCK})`); // freeze is serialised: the barrier and the snapshot are one consistent read
      const b = await this.barrier(campaignId, periodId);
      const allowed = new Set<string>((override?.allow ?? []).filter((c) => c === "UNRESOLVED_SUBMISSIONS"));
      const blocking = b.blockers.filter((x) => !allowed.has(x.code));
      if (blocking.length) throw err("BLOCKED", `draw blocked: ${blocking.map((x) => x.code).join(", ")}`, { blockers: blocking });
      if (allowed.size && !override?.reason) throw invalid("an override needs a reason");
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(draws).where(eq(draws.periodId, periodId));
      const id = newId("drw"); const seedHex = crypto.randomBytes(32).toString("hex");
      const snapshot = { drawId: id, campaignId, periodCode: b.period.code, rulesVersionHash: b.rulesVersionHash, plan: b.plan, candidates: b.eligible, exclusions: b.exclusions, seedCommitment: seedCommitment(seedHex) };
      const snapshotHash = hashOf(snapshot);
      await tx.insert(draws).values({ id, campaignId, periodId, sequenceNo: n + 1, status: "frozen", rulesVersionHash: b.rulesVersionHash, prizePlan: b.plan, snapshot, snapshotHash, seedCommitment: snapshot.seedCommitment, seedHex, algorithm: ALGORITHM, barrier: { checkedAt: new Date().toISOString(), blockers: b.blockers, override: override ?? null }, officerId: actorId, verifierVersion: VERIFIER_VERSION });
      if (b.eligible.length) await tx.insert(drawCandidates).values(b.eligible.map((c, i) => ({ drawId: id, position: i, entryId: c.entryId, participantId: c.participantId, units: c.units, status: "eligible" })));
      if (b.exclusions.length) await tx.insert(drawCandidates).values(b.exclusions.map((x, i) => ({ drawId: id, position: 100_000 + i, entryId: x.entryId, participantId: x.participantId, units: 0, status: "excluded", exclusionReason: x.reason })));
      await this.deps.campaigns.setPeriodStatus(tx, periodId, "closed");
      await this.deps.audit.record(tx, { actorType: "staff", actorId, action: "draw.frozen", targetType: "draw", targetId: id, campaignId, reason: override?.reason ?? null, payload: { periodCode: b.period.code, candidates: b.eligible.length, exclusions: b.exclusions.length, snapshotHash, seedCommitment: snapshot.seedCommitment, override: override ?? null } });
      return (await tx.select().from(draws).where(eq(draws.id, id)))[0];
    });
  }

  async execute(drawId: string, actorId: string) {
    const d = await this.get(drawId); if (!d) throw notFound("draw");
    if (["executed", "approved", "published"].includes(d.status)) return d;
    if (!["frozen", "executing"].includes(d.status)) throw conflict(`draw cannot be executed (status=${d.status})`);
    const reserved = await this.db.update(draws).set({ status: "executing", executionAttempts: sql`${draws.executionAttempts} + 1` }).where(and(eq(draws.id, drawId), eq(draws.status, "frozen"))).returning({ id: draws.id });
    await this.db.insert(drawAttempts).values({ id: newId("dat"), drawId, actorId, outcome: reserved.length ? "reserved" : "resumed", detail: reserved.length ? null : "reservation already held; recomputing deterministically from the committed seed" });
    const output = computeOutput(d.snapshot as { candidates: Candidate[]; plan: Plan }, d.seedHex); const outputHash = hashOf(output);
    return this.db.transaction(async (tx) => {
      const [cur] = await tx.select().from(draws).where(eq(draws.id, drawId)).for("update");
      if (cur.status !== "executing") return cur;
      await tx.update(draws).set({ status: "executed", output, outputHash, executedAt: new Date().toISOString(), executedBy: actorId }).where(eq(draws.id, drawId));
      await tx.update(drawAttempts).set({ outcome: "completed" }).where(and(eq(drawAttempts.drawId, drawId), eq(drawAttempts.actorId, actorId), inArray(drawAttempts.outcome, ["reserved", "resumed"])));
      await this.deps.audit.record(tx, { actorType: "staff", actorId, action: "draw.executed", targetType: "draw", targetId: drawId, campaignId: d.campaignId, payload: { outputHash, winners: output.winners.length, alternates: output.alternates.length } });
      return (await tx.select().from(draws).where(eq(draws.id, drawId)))[0];
    });
  }

  async approve(drawId: string, approverId: string, { expectedOutputHash, note }: { expectedOutputHash?: string | null; note?: string | null }) {
    return this.db.transaction(async (tx) => {
      const [d] = await tx.select().from(draws).where(eq(draws.id, drawId)).for("update"); if (!d) throw notFound("draw");
      if (d.status === "approved" && d.approverId === approverId) return d; // idempotent replay
      if (d.status !== "executed") throw conflict(`draw cannot be approved (status=${d.status})`);
      if (d.officerId === approverId || d.executedBy === approverId) throw err("SOD", "the person who froze or executed the draw cannot approve it");
      if (expectedOutputHash && expectedOutputHash !== d.outputHash) throw conflict("the result changed since you reviewed it; reload");
      const check = await this.verifyStored(d); if (!check.ok) throw err("INTEGRITY", `integrity check failed: ${check.problems.join("; ")}`);
      await tx.update(draws).set({ status: "approved", approverId, approvedAt: new Date().toISOString(), approvalNote: note ?? null }).where(and(eq(draws.id, drawId), eq(draws.status, "executed")));
      await this.deps.audit.record(tx, { actorType: "staff", actorId: approverId, action: "draw.approved", targetType: "draw", targetId: drawId, campaignId: d.campaignId, payload: { outputHash: d.outputHash, note } });
      return (await tx.select().from(draws).where(eq(draws.id, drawId)))[0];
    });
  }
  async reject(drawId: string, approverId: string, reason: string) {
    if (!reason) throw invalid("reason required");
    return this.db.transaction(async (tx) => {
      const [d] = await tx.select().from(draws).where(eq(draws.id, drawId)).for("update"); if (!d || d.status !== "executed") throw conflict("only executed draws can be rejected");
      await tx.update(draws).set({ status: "voided", voidedAt: new Date().toISOString(), voidedBy: approverId, voidReason: reason }).where(eq(draws.id, drawId));
      await this.deps.campaigns.setPeriodStatus(tx, d.periodId, "closed");
      await this.deps.audit.record(tx, { actorType: "staff", actorId: approverId, action: "draw.rejected", targetType: "draw", targetId: drawId, campaignId: d.campaignId, reason });
      return (await tx.select().from(draws).where(eq(draws.id, drawId)))[0];
    });
  }
  async publish(drawId: string, actorId: string) {
    return this.db.transaction(async (tx) => {
      const [d] = await tx.select().from(draws).where(eq(draws.id, drawId)).for("update"); if (!d) throw notFound("draw");
      if (d.status === "published") return d; if (d.status !== "approved") throw conflict(`draw cannot be published (status=${d.status})`);
      await tx.update(draws).set({ status: "published", publishedAt: new Date().toISOString(), publishedBy: actorId }).where(eq(draws.id, drawId));
      await this.deps.campaigns.setPeriodStatus(tx, d.periodId, "drawn");
      await this.deps.audit.record(tx, { actorType: "staff", actorId, action: "draw.published", targetType: "draw", targetId: drawId, campaignId: d.campaignId });
      return (await tx.select().from(draws).where(eq(draws.id, drawId)))[0];
    });
  }
  /** Void an approved/published draw (second, different approver) and freeze a linked replacement. Original evidence is retained. */
  async voidAndRerun(drawId: string, actorId: string, reason: string, approvedBy: string) {
    if (!reason) throw invalid("reason required");
    const d = await this.get(drawId); if (!d) throw notFound("draw");
    if (["approved", "published"].includes(d.status) && (!approvedBy || approvedBy === actorId)) throw err("SOD", "voiding an approved draw requires a second, different approver");
    await this.db.transaction(async (tx) => {
      await tx.update(draws).set({ status: "voided", voidedAt: new Date().toISOString(), voidedBy: actorId, voidApprovedBy: approvedBy, voidReason: reason }).where(eq(draws.id, drawId));
      await tx.update(winners).set({ status: "replaced", publication: sql`case when ${winners.publication} = 'published' then 'withdrawn' else ${winners.publication} end`, version: sql`${winners.version} + 1` }).where(and(eq(winners.drawId, drawId), notInArray(winners.status, ["collected"])));
      await this.deps.campaigns.setPeriodStatus(tx, d.periodId, "closed");
      await this.deps.audit.record(tx, { actorType: "staff", actorId, action: "draw.voided", targetType: "draw", targetId: drawId, campaignId: d.campaignId, reason, payload: { approvedBy } });
    });
    const n = await this.freeze({ campaignId: d.campaignId, periodId: d.periodId, actorId });
    await this.db.update(draws).set({ supersedesId: drawId }).where(eq(draws.id, n.id));
    await this.deps.audit.record(this.db, { actorType: "staff", actorId, action: "draw.rerun", targetType: "draw", targetId: n.id, campaignId: d.campaignId, reason, payload: { supersedes: drawId } });
    return (await this.get(n.id))!;
  }
  /** Recompute everything from stored evidence. */
  async verifyStored(d: Draw) {
    const problems: string[] = []; const snapshot = d.snapshot as { candidates: Candidate[]; plan: Plan; seedCommitment: string };
    if (hashOf(snapshot) !== d.snapshotHash) problems.push("snapshot hash mismatch");
    if (seedCommitment(d.seedHex) !== snapshot.seedCommitment || d.seedCommitment !== snapshot.seedCommitment) problems.push("seed commitment mismatch");
    const stored = (await this.db.select({ e: drawCandidates.entryId }).from(drawCandidates).where(and(eq(drawCandidates.drawId, d.id), eq(drawCandidates.status, "eligible"))).orderBy(asc(drawCandidates.position))).map((r) => r.e);
    if (JSON.stringify(stored) !== JSON.stringify(snapshot.candidates.map((c) => c.entryId))) problems.push("candidate rows differ from snapshot");
    if (d.output) { const out = computeOutput(snapshot, d.seedHex); if (hashOf(out) !== d.outputHash) problems.push("output hash mismatch"); if (JSON.stringify(out.winners.map((w) => w.entryId)) !== JSON.stringify((d.output as { winners: Array<{ entryId: string }> }).winners.map((w) => w.entryId))) problems.push("winner order mismatch"); }
    if (d.approverId && (d.approverId === d.officerId || d.approverId === d.executedBy)) problems.push("approver equals officer");
    return { ok: problems.length === 0, problems };
  }
  /** Audit bundle for the independent verifier. Randomness of a frozen draw is never exported. */
  async bundle(drawId: string, actorId: string) {
    const d = await this.get(drawId); if (!d) throw notFound("draw");
    const period = await this.deps.campaigns.period(d.periodId);
    const checkpoint = await this.deps.audit.checkpoint(actorId);
    const events = await this.db.select({ id: auditEvents.id, actorId: auditEvents.actorId, action: auditEvents.action, reason: auditEvents.reason, prevHash: auditEvents.prevHash, entryHash: auditEvents.entryHash, body: auditEvents.body, createdAt: auditEvents.createdAt }).from(auditEvents).where(and(eq(auditEvents.targetType, "draw"), eq(auditEvents.targetId, drawId))).orderBy(asc(auditEvents.id));
    await this.deps.audit.record(this.db, { actorType: "staff", actorId, action: "draw.bundle_exported", targetType: "draw", targetId: drawId, campaignId: d.campaignId });
    const executed = d.status !== "frozen" && d.status !== "executing";
    return { bundleVersion: VERIFIER_VERSION, exportedAt: new Date().toISOString(), exportedBy: actorId, draw: { id: d.id, campaignId: d.campaignId, periodCode: period?.code ?? null, sequenceNo: d.sequenceNo, status: d.status, algorithm: d.algorithm, snapshotHash: d.snapshotHash, seedCommitment: d.seedCommitment, outputHash: d.outputHash, officerId: d.officerId, executedBy: d.executedBy, approverId: d.approverId, executedAt: d.executedAt, approvedAt: d.approvedAt, publishedAt: d.publishedAt, rulesVersionHash: d.rulesVersionHash, supersedesId: d.supersedesId }, snapshot: d.snapshot, seedHex: executed ? d.seedHex : null, output: executed ? d.output : null, attempts: await this.db.select({ actorId: drawAttempts.actorId, outcome: drawAttempts.outcome, detail: drawAttempts.detail, createdAt: drawAttempts.createdAt }).from(drawAttempts).where(eq(drawAttempts.drawId, drawId)).orderBy(asc(drawAttempts.createdAt)), auditEvents: events, auditCheckpoint: checkpoint };
  }
  async get(id: string) { const [d] = await this.db.select().from(draws).where(eq(draws.id, id)); return d ?? null; }
  async list(campaignId: string) { return this.db.select({ d: draws, periodCode: campaignPeriods.code, periodLabel: campaignPeriods.label }).from(draws).innerJoin(campaignPeriods, eq(campaignPeriods.id, draws.periodId)).where(eq(draws.campaignId, campaignId)).orderBy(desc(draws.createdAt)); }
  async attempts(drawId: string) { return this.db.select().from(drawAttempts).where(eq(drawAttempts.drawId, drawId)).orderBy(asc(drawAttempts.createdAt)); }
  async candidateCount(drawId: string) { const [{ n }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(drawCandidates).where(and(eq(drawCandidates.drawId, drawId), eq(drawCandidates.status, "eligible"))); return n; }
}
