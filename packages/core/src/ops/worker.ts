import type { AuditService } from "../audit.ts";
import type { AuthService } from "../auth/service.ts";
import type { Db } from "@promo/db";
import type { QueueService, InboundEvent } from "./queue.ts";
import type { OutboxService } from "./outbox.ts";
import type { CrmService } from "../crm/index.ts";
import type { WhatsAppTransport } from "../whatsapp/transport.ts";
import type { ConversationEngine } from "../conversation/engine.ts";
import type { ReceiptPipeline } from "../receipt/pipeline.ts";
import type { WinnerService } from "../winner/service.ts";
import type { MediaService } from "../media/service.ts";
import type { CampaignService } from "../campaign/service.ts";
import type { OpsSignals } from "./alerts.ts";
import type { Config } from "../config.ts";
import type { Logger } from "../util/log.ts";
import { SendError } from "../whatsapp/transport.ts";

/**
 * Durable worker: inbound events -> conversation -> outbox; jobs (extraction,
 * expiries, retention); WhatsApp outbox with recipient/template policy at
 * dispatch; CRM outbox. Bounded per tick; leases make a crash safe; several
 * worker processes may run concurrently (SKIP LOCKED).
 */
export class Worker {
  private timer: NodeJS.Timeout | null = null; private running = false; private ticks = 0; private lastTickAt: string | null = null;
  constructor(private d: { db: Db; cfg: Config; environment: string; queue: QueueService; outbox: OutboxService; crm: CrmService; transport: WhatsAppTransport; conversation: ConversationEngine; pipeline: ReceiptPipeline; winners: WinnerService; media: MediaService; campaigns: CampaignService; signals: OpsSignals; audit: AuditService; auth: AuthService; log: Logger; intervalMs?: number }) {}
  start() { if (!this.timer) this.timer = setInterval(() => void this.tick(), this.d.intervalMs ?? this.d.cfg.WORKER_POLL_MS); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  health() { return { running: !!this.timer, ticks: this.ticks, lastTickAt: this.lastTickAt }; }

  async tick({ maxEvents = this.d.cfg.WORKER_EVENT_BATCH, maxJobs = this.d.cfg.WORKER_JOB_BATCH, maxOutbound = this.d.cfg.WORKER_EVENT_BATCH, maxCrm = this.d.cfg.WORKER_JOB_BATCH } = {}) {
    if (this.running) return; this.running = true; this.ticks++;
    try {
      for (let i = 0; i < maxEvents; i++) if (!(await this.processEvent())) break;
      for (let i = 0; i < maxJobs; i++) if (!(await this.processJob())) break;
      for (let i = 0; i < maxOutbound; i++) if (!(await this.dispatchOutbound())) break;
      for (let i = 0; i < maxCrm; i++) { const r = await this.d.crm.deliverOne(); if (!r) break; }
      if (this.ticks % 40 === 0) await this.housekeeping();
      this.lastTickAt = new Date().toISOString();
    } catch (e) { this.d.log.error({ err: (e as Error).message }, "worker tick failed"); } finally { this.running = false; }
  }
  /** Drain everything now (tests, simulator, seed). */
  async drain(max = 500) { let n = 0; for (let i = 0; i < max && (await this.processEvent()); i++) n++; for (let i = 0; i < max && (await this.processJob()); i++) n++; for (let i = 0; i < max && (await this.dispatchOutbound()); i++) n++; for (let i = 0; i < max; i++) { const r = await this.d.crm.deliverOne(); if (!r) break; n++; } return n; }

  async processEvent(): Promise<boolean> {
    const ev = await this.d.queue.leaseEvent(); if (!ev) return false;
    try {
      const p = ev.payload as { text?: string; mediaId?: string | null; inlineMediaB64?: string | null; mime?: string | null; status?: string | null; errorCode?: string | null; timestamp?: string | null };
      if (ev.kind.startsWith("delivery.status:")) { await this.d.outbox.markDelivery(ev.providerMessageId, ev.kind.split(":")[1], { errorCode: p.errorCode ?? null, at: p.timestamp ?? null }); await this.d.queue.completeEvent(ev.id, { delivery: true }); return true; }
      if (!ev.channelUid) { await this.d.queue.ignoreEvent(ev.id, "no channel identity"); return true; }
      let mediaBytes: Buffer | null = null; const isImage = ev.kind === "message.image" || ev.kind === "message.document";
      if (isImage) { if (p.inlineMediaB64) mediaBytes = Buffer.from(p.inlineMediaB64, "base64"); else if (p.mediaId) { try { mediaBytes = await this.d.transport.downloadMedia(p.mediaId); } catch (e) { const x = e as Error & { permanent?: boolean }; if (!x.permanent) throw Object.assign(new Error(`media download failed: ${x.message}`), { transient: true }); mediaBytes = null; } } }
      const result = await this.d.conversation.handle({ eventId: ev.id, providerMessageId: ev.providerMessageId, uid: ev.channelUid, kind: isImage ? "image" : ev.kind === "message.unsupported" ? "unsupported" : "text", text: p.text ?? "", mediaBytes, mime: p.mime ?? null, correlationId: ev.correlationId, eventAt: p.timestamp ?? null });
      await this.d.db.transaction(async (tx) => { for (const [i, body] of result.replies.entries()) await this.d.outbox.enqueue(tx, { channelUid: ev.channelUid!, purpose: "reply", campaignId: result.campaignId, payload: body, idempotencyKey: `reply:${ev.id}:${i}`, correlationId: ev.correlationId }); });
      await this.d.queue.completeEvent(ev.id, { state: result.state, replies: result.replies.length, submissionId: result.submissionId ?? null, participantId: result.participantId ?? null });
      await this.d.signals.metric("inbound.processed", 1, { kind: ev.kind });
      return true;
    } catch (e) {
      const dead = await this.d.queue.failEvent(ev as InboundEvent, (e as Error).message);
      this.d.log.error({ eventId: ev.id, err: (e as Error).message }, "inbound event failed");
      if (dead) await this.d.signals.raise({ kind: "inbound.dead_letter", severity: "critical", message: `inbound event ${ev.id} dead-lettered: ${(e as Error).message}`, runbook: "docs/runbooks/queue-replay.md" });
      return true;
    }
  }
  async processJob(): Promise<boolean> {
    const job = await this.d.queue.leaseJob(); if (!job) return false;
    try {
      const p = job.payload as { submissionId?: string };
      if (job.kind === "submission.process") {
        const r = await this.d.pipeline.process(p.submissionId!);
        const s = await this.d.pipeline.get(p.submissionId!);
        if (s && !["received", "processing", "delayed"].includes(s.status)) {
          const part = await this.d.db.query.participants.findFirst({ where: (t, { eq }) => eq(t.id, s.participantId) });
          if (part) {
            // A submission that still needs the participant opens a
            // confirmation on their conversation instead of clearing it — but
            // only when they are idle, so a background job never interrupts a
            // registration or a support conversation mid-sentence.
            if (s.status === "awaiting_participant") {
              const opened = await this.d.conversation.requestConfirmation(s.campaignId, part.channelUid, s.id, r.pendingFields ?? []);
              // Nobody to ask — the participant is with support or mid-flow.
              // Escalate rather than leave the submission unattended.
              if (!opened.opened) await this.d.pipeline.escalateStalledQuestions({ olderThanMs: -1, limit: 1 });
            }
            else await this.d.conversation.onSubmissionOutcome(s.campaignId, part.channelUid, s.id);
          }
        }
      }
      else if (job.kind === "winners.expire") await this.d.winners.expireDue();
      else if (job.kind === "audit.checkpoint") await this.d.audit.checkpoint("system:housekeeping");
      else if (job.kind === "media.purge") await this.d.media.purgeExpired();
      else if (job.kind === "auth.sweep") { await this.d.auth.sweepExpired(); await this.d.queue.sweepJobs(); }
      else if (job.kind === "questions.escalate") await this.d.pipeline.escalateStalledQuestions();
      else throw Object.assign(new Error(`unknown job kind ${job.kind}`), { permanent: true });
      await this.d.queue.completeJob(job.id); return true;
    } catch (e) {
      const x = e as Error & { permanent?: boolean }; const dead = await this.d.queue.failJob(job, x.message, !!x.permanent);
      this.d.log.error({ jobId: job.id, kind: job.kind, err: x.message }, "job failed");
      if (dead) await this.d.signals.raise({ kind: "jobs.dead_letter", severity: "critical", message: `job ${job.id} (${job.kind}) dead: ${x.message}`, runbook: "docs/runbooks/queue-replay.md" });
      return true;
    }
  }
  /** Recipient allowlist (non-production), campaign outbound pause and template eligibility are checked at dispatch time. */
  async dispatchOutbound(): Promise<boolean> {
    const row = await this.d.outbox.lease(); if (!row) return false;
    const allow = this.d.cfg.outboundAllowlist;
    if (this.d.environment !== "production" && allow.length && !allow.includes(row.channelUid)) { await this.d.outbox.markBlocked(row, "RECIPIENT_NOT_ALLOWED", "non-production: recipient is not a designated test number", false); return true; }
    if (row.campaignId) { const c = await this.d.campaigns.controls(row.campaignId); if (c.pauseOutbound) { await this.d.outbox.markBlocked(row, "OUTBOUND_PAUSED", "campaign outbound messages are paused", true); return true; } }
    if (row.purpose === "winner_contact" && row.kind === "text" && this.d.transport.requiresTemplateOutsideWindow) { const last = await this.d.queue.lastInboundAt(row.channelUid); if (!last || Date.now() - Date.parse(last) > 24 * 3_600_000) { await this.d.outbox.markBlocked(row, "TEMPLATE_REQUIRED", "outside the 24-hour service window: configure an approved winner template", true); return true; } }
    const payload = row.payload as { body?: string; name?: string };
    try { const res = await this.d.transport.send(row.kind === "text" ? { kind: "text", to: row.channelUid, body: payload.body ?? "" } : row.kind === "template" ? { kind: "template", to: row.channelUid, template: payload } : { kind: "interactive", to: row.channelUid, interactive: payload }); await this.d.outbox.markSent(row.id, res.providerMessageId); await this.d.signals.metric("outbound.sent", 1, { purpose: row.purpose }); }
    catch (e) { const x = e as SendError; const st = await this.d.outbox.markFailed(row, { message: x.message, code: x.code, permanent: x.permanent, unknownOutcome: x.unknownOutcome }); if (st !== "retryable_failure") await this.d.signals.raise({ kind: "outbound.failure", severity: "warning", message: `outbound ${row.id} ${st}: ${x.message}`, runbook: "docs/runbooks/provider-outage.md" }); }
    return true;
  }
  async housekeeping() {
    try {
      const st = await this.d.queue.stats(); if (st.oldestEvent && Date.now() - Date.parse(st.oldestEvent) > 5 * 60_000) await this.d.signals.raise({ kind: "inbound.backlog", severity: "warning", message: `inbound backlog: oldest event ${st.oldestEvent}`, runbook: "docs/runbooks/queue-replay.md" });
      const rq = await this.d.pipeline.reviewQueueStats(); if (rq.overdue) await this.d.signals.raise({ kind: "review.backlog", severity: "warning", message: `${rq.overdue} submissions past the review target; oldest ${rq.oldest}`, runbook: "docs/runbooks/review-operations.md" });
      const ob = await this.d.outbox.stats(); if ((ob.byStatus.unknown_outcome ?? 0) + (ob.byStatus.permanent_failure ?? 0) > 0) await this.d.signals.raise({ kind: "outbound.failures", severity: "warning", message: `outbound failures: ${JSON.stringify(ob.byStatus)}`, runbook: "docs/runbooks/provider-outage.md" });
      const hour = new Date().toISOString().slice(0, 13);
      await this.d.queue.enqueueJob(this.d.db, "winners.expire", {}, { dedupeKey: `winners.expire:${hour}` });
      await this.d.queue.enqueueJob(this.d.db, "audit.checkpoint", {}, { dedupeKey: `audit.checkpoint:${new Date().toISOString().slice(0, 10)}` }); // a signed chain head every day
      await this.d.queue.enqueueJob(this.d.db, "media.purge", {}, { dedupeKey: `media.purge:${new Date().toISOString().slice(0, 10)}` });
      await this.d.queue.enqueueJob(this.d.db, "auth.sweep", {}, { dedupeKey: `auth.sweep:${hour}` });
      await this.d.queue.enqueueJob(this.d.db, "questions.escalate", {}, { dedupeKey: `questions.escalate:${hour}` });
      const retention = await this.d.media.retentionBacklog();
      if (retention.due > 10_000) await this.d.signals.raise({ kind: "media.retention_backlog", severity: "warning", message: `${retention.due} media assets are past their retention date; oldest ${retention.oldest}`, runbook: "docs/runbooks/media-and-extraction.md" });
    } catch (e) { this.d.log.error({ err: (e as Error).message }, "housekeeping failed"); }
  }
}
