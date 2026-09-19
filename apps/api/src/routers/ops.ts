import { z } from "zod";
import { router, guard, publicProcedure, sessionProcedure } from "../trpc.ts";
import { validateActivation, notFound, ROLES, permissionMatrix, DEFINITIONS, csvCell, conflict, can } from "@promo/core";
import { eq, and, desc } from "drizzle-orm";
import { schema } from "@promo/db";
const { conversations } = schema;
export const supportRouter = router({
  queue: guard("support.read").query(async ({ ctx }) => { const rows = await ctx.app.conversation.handoffQueue(); return Promise.all(rows.map(async (r) => { const p = r.participantId ? await ctx.app.participants.get(r.participantId) : null; return { conversationId: r.id, campaignId: r.campaignId, phone: `***${r.channelUid.slice(-4)}`, uid: r.channelUid, state: r.state, handoffOwner: r.handoffOwner, handoffSince: r.handoffSince, name: p ? `${p.firstName} ${p.surname}`.trim() : null }; })); }),
  conversation: guard("support.read").input(z.object({ phone: z.string() })).query(async ({ ctx, input }) => {
    const uid = ctx.app.participants.uid(input.phone) ?? input.phone; const c = await ctx.app.campaigns.current(); const s = c ? await ctx.app.conversation.session(c.id, uid) : null; const p = await ctx.app.participants.byUid(uid);
    const inbound = (await ctx.app.queue.eventsFor(uid)).map((e) => ({ dir: "in" as const, id: e.id, kind: e.kind, text: (e.payload as { text?: string }).text ?? "", status: e.status, at: e.receivedAt }));
    const outbound = (await ctx.app.outbox.forUid(uid)).map((o) => ({ dir: "out" as const, id: o.id, purpose: o.purpose, text: (o.payload as { body?: string }).body ?? "[template]", status: o.status, at: o.createdAt }));
    return { phone: `***${uid.slice(-4)}`, uid, session: s ? { state: s.state, handoffOwner: s.handoffOwner, handoffSince: s.handoffSince, updatedAt: s.updatedAt } : null, participant: ctx.app.participants.mask(p), transcript: [...inbound, ...outbound].sort((a, b) => a.at.localeCompare(b.at)) };
  }),
  claim: guard("support.handoff").input(z.object({ phone: z.string() })).mutation(async ({ ctx, input }) => { const c = await ctx.app.campaigns.current(); if (!c) throw conflict("no campaign"); await ctx.app.conversation.claimHandoff(c.id, ctx.app.participants.uid(input.phone) ?? input.phone, ctx.user.id); return { ok: true }; }),
  release: guard("support.handoff").input(z.object({ phone: z.string() })).mutation(async ({ ctx, input }) => { const c = await ctx.app.campaigns.current(); if (!c) throw conflict("no campaign"); await ctx.app.conversation.releaseHandoff(c.id, ctx.app.participants.uid(input.phone) ?? input.phone, ctx.user.id); return { ok: true }; }),
  send: guard("support.handoff").input(z.object({ phone: z.string(), text: z.string().min(1).max(2000) })).mutation(async ({ ctx, input }) => { const uid = ctx.app.participants.uid(input.phone) ?? input.phone; const c = await ctx.app.campaigns.current(); const s = c ? await ctx.app.conversation.session(c.id, uid) : null; if (!s?.handoffOwner) throw conflict("claim the conversation before sending"); await ctx.app.db.transaction(async (tx) => { await ctx.app.outbox.enqueue(tx, { channelUid: uid, purpose: "support", campaignId: c?.id ?? null, payload: input.text, idempotencyKey: `support:${ctx.user.id}:${Date.now()}` }); await ctx.app.audit.record(tx, { actorType: "staff", actorId: ctx.user.id, action: "support.message", targetType: "conversation", targetId: `***${uid.slice(-4)}`, campaignId: c?.id ?? null, payload: { length: input.text.length } }); }); return { ok: true }; }),
});
export const opsRouter = router({
  integrations: guard("ops.read").query(async ({ ctx }) => ({ environment: ctx.app.environment, transport: ctx.app.transport.health(), extractor: await ctx.app.extractor.health(), crm: await ctx.app.crm.health(), storage: await ctx.app.storage.health(), database: { ok: true, url: ctx.app.cfg.DATABASE_URL.replace(/\/\/.*@/, "//***@") }, worker: ctx.app.worker.health(), workerMode: ctx.app.cfg.WORKER_MODE, queues: await ctx.app.queue.stats(), outbound: await ctx.app.outbox.stats(), crmQueue: await ctx.app.crm.summary(), outboundAllowlist: ctx.app.cfg.outboundAllowlist.map((n) => `***${n.slice(-4)}`) })),
  outbound: guard("ops.read").input(z.object({ status: z.string().optional() })).query(({ ctx, input }) => ctx.app.outbox.list({ status: input.status ?? null }).then((rows) => rows.map((m) => ({ ...m, channelUid: `***${m.channelUid.slice(-4)}`, payload: undefined })))),
  retryOutbound: guard("ops.retry").input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => { const ok = await ctx.app.outbox.retry(input.id); if (ok) await ctx.app.audit.record(ctx.app.db, { actorType: "staff", actorId: ctx.user.id, action: "outbound.retry", targetType: "outbound_message", targetId: input.id }); return { ok }; }),
  crmEvents: guard("ops.read").input(z.object({ status: z.string().optional() })).query(({ ctx, input }) => ctx.app.crm.list({ status: input.status ?? null })),
  retryCrm: guard("ops.retry").input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => { const ok = await ctx.app.crm.retry(input.id); if (ok) await ctx.app.audit.record(ctx.app.db, { actorType: "staff", actorId: ctx.user.id, action: "crm.retry", targetType: "crm_event", targetId: input.id }); return { ok }; }),
  reconcileCrm: guard("ops.retry").mutation(async ({ ctx }) => { const r = await ctx.app.crm.reconcile(); await ctx.app.audit.record(ctx.app.db, { actorType: "staff", actorId: ctx.user.id, action: "crm.reconcile", targetType: "crm", targetId: "all", payload: { checked: r.checked, reconciled: r.reconciled, requeued: r.requeued } }); return r; }),
  crmPreview: guard("ops.read").input(z.object({ type: z.string() })).query(({ ctx, input }) => { const samples: Record<string, Record<string, unknown>> = { participant: { id: "ptc_example", firstName: "Sample", surname: "Person", phone: "***0000", location: "Town", status: "active" }, entry: { id: "ent_example", participantId: "ptc_example", campaignCode: "CODE", period: "W1", outletCode: "OUT-01", reference: "R-XXXX-XXXX", status: "active" }, winner: { id: "win_example", participantId: "ptc_example", campaignCode: "CODE", period: "W1", prize: "Prize", rank: 1, status: "selected" }, submission: { id: "sub_example", participantId: "ptc_example", campaignCode: "CODE", reference: "R-XXXX-XXXX", outletCode: "OUT-01", status: "qualified", reason: "ok" }, claim: { id: "win_example", winnerId: "win_example", state: "collected", collectionOutlet: "OUT-01" }, enrollment: { id: "ptc_example:cmp", participantId: "ptc_example", campaignCode: "CODE", termsVersion: "T1", privacyVersion: "P1", marketingConsent: false } }; return { type: input.type, excludedByDefault: ["identity number", "raw receipt image", "OCR text", "full phone number"], record: ctx.app.crm.preview(input.type, samples[input.type] ?? samples.participant) }; }),
  queues: guard("ops.read").query(async ({ ctx }) => ({ stats: await ctx.app.queue.stats(), ...(await ctx.app.queue.deadLetters()) })),
  replayEvent: guard("ops.retry").input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => { const ok = await ctx.app.queue.replayEvent(input.id); if (ok) await ctx.app.audit.record(ctx.app.db, { actorType: "staff", actorId: ctx.user.id, action: "inbound.replay", targetType: "inbound_event", targetId: input.id }); return { ok }; }),
  retryJob: guard("ops.retry").input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => { const ok = await ctx.app.queue.retryJob(input.id); if (ok) await ctx.app.audit.record(ctx.app.db, { actorType: "staff", actorId: ctx.user.id, action: "job.retry", targetType: "job", targetId: input.id }); return { ok }; }),
  alerts: guard("ops.read").input(z.object({ all: z.boolean().optional() })).query(({ ctx, input }) => (input.all ? ctx.app.signals.all() : ctx.app.signals.open())),
  ackAlert: guard("ops.alerts.ack").input(z.object({ id: z.string() })).mutation(({ ctx, input }) => ctx.app.signals.ack(input.id, ctx.user.id).then((ok) => ({ ok }))),
  /** Every row in the settings store, so an administrator can see what is set rather than guess keys. */
  settings: guard("ops.read").query(({ ctx }) => ctx.app.db.select().from(schema.settings).orderBy(schema.settings.key)),
  setting: guard("ops.read").input(z.object({ key: z.string().regex(/^[a-z0-9_.:-]{1,80}$/) })).query(({ ctx, input }) => ctx.app.campaigns.setting(input.key, null)),
  setSetting: guard("settings.write").input(z.object({ key: z.string().regex(/^[a-z0-9_.:-]{1,80}$/), value: z.unknown() })).mutation(async ({ ctx, input }) => { await ctx.app.campaigns.setSetting(input.key, input.value, ctx.user.id); return { ok: true }; }),
  recordEvidence: guard("evidence.record").input(z.object({ kind: z.enum(["receipt_benchmark_accepted", "restore_rehearsal", "client_uat_signoff", "load_benchmark"]), detail: z.record(z.string(), z.unknown()).optional() })).mutation(async ({ ctx, input }) => { const v = { ...(input.detail ?? {}), at: new Date().toISOString(), recordedBy: ctx.user.id }; await ctx.app.campaigns.setSetting(`evidence.${input.kind}`, v, ctx.user.id); await ctx.app.audit.record(ctx.app.db, { actorType: "staff", actorId: ctx.user.id, action: "evidence.recorded", targetType: "evidence", targetId: input.kind, payload: v }); return v; }),
  metrics: guard("ops.read").input(z.object({ sinceHours: z.number().min(1).max(720).default(24) })).query(({ ctx, input }) => ctx.app.signals.counts(new Date(Date.now() - input.sinceHours * 3_600_000).toISOString())),
});
export const staffRouter = router({
  list: guard("staff.manage").query(async ({ ctx }) => ({ users: await ctx.app.auth.list(), roles: ROLES, matrix: permissionMatrix() })),
  create: guard("staff.manage").input(z.object({ email: z.string().email(), name: z.string().min(1).max(80), roles: z.array(z.string()).min(1) })).mutation(({ ctx, input }) => ctx.app.auth.createUser({ ...input, createdBy: ctx.user.id })),
  update: guard("staff.manage").input(z.object({ userId: z.string(), roles: z.array(z.string()).optional(), status: z.enum(["active", "disabled"]).optional(), name: z.string().optional() })).mutation(({ ctx, input }) => { if (input.userId === ctx.user.id && input.status === "disabled") throw conflict("you cannot disable yourself"); return ctx.app.auth.updateUser(input.userId, input, ctx.user.id); }),
  resetPassword: guard("staff.manage").input(z.object({ userId: z.string() })).mutation(({ ctx, input }) => ctx.app.auth.resetPassword(input.userId, ctx.user.id)),
});
export const auditRouter = router({
  list: guard("audit.read").input(z.object({ targetType: z.string().optional(), targetId: z.string().optional(), actorId: z.string().optional(), action: z.string().optional(), campaignId: z.string().optional(), limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) })).query(({ ctx, input }) => ctx.app.audit.list(input)),
  verify: guard("audit.read").input(z.object({ fromId: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(20_000).default(5_000) }).default({ fromId: 0, limit: 5_000 })).query(({ ctx, input }) => ctx.app.audit.verify(input)),
  checkpoint: guard("audit.read").mutation(({ ctx }) => ctx.app.audit.checkpoint(ctx.user.id)),
});
export const reportsRouter = router({
  summary: guard("report.read").input(z.object({ campaignId: z.string().optional(), since: z.string().optional(), until: z.string().optional() })).query(async ({ ctx, input }) => { const cid = input.campaignId ?? (await ctx.app.campaigns.current())?.id; if (!cid) throw notFound("campaign"); return ctx.app.reports.summary(cid, { since: input.since ?? null, until: input.until ?? null }); }),
  definitions: guard("report.read").query(() => DEFINITIONS),
  export: guard("report.export").input(z.object({ scope: z.enum(["submissions", "entries", "winners", "participants", "outlets"]), campaignId: z.string().optional(), format: z.enum(["json", "csv"]).default("json") })).query(async ({ ctx, input }) => {
    const cid = input.campaignId ?? (await ctx.app.campaigns.current())?.id; if (!cid) throw notFound("campaign");
    const [rows, total] = await Promise.all([ctx.app.reports.exportRows(input.scope, cid) as Promise<Array<Record<string, unknown>>>, ctx.app.reports.exportCount(input.scope, cid)]);
    const truncated = total > rows.length;
    await ctx.app.audit.record(ctx.app.db, { actorType: "staff", actorId: ctx.user.id, action: "report.export", targetType: "report", targetId: input.scope, campaignId: cid, reason: `${rows.length} of ${total} rows`, payload: { scope: input.scope, format: input.format, count: rows.length, total, truncated } });
    const watermark = `${ctx.user.email} ${new Date().toISOString()}`;
    // A truncated export says so, in the file. An auditor receiving 50,000 rows
    // of 120,000 with no indication has an incomplete dataset that reads as
    // complete.
    const note = truncated ? `# WARNING: truncated at ${rows.length} of ${total} rows` : null;
    if (input.format === "csv") { const head = rows[0] ? Object.keys(rows[0]) : []; return { format: "csv" as const, watermark, count: rows.length, total, truncated, csv: [head.join(","), ...rows.map((r) => head.map((k) => csvCell(r[k])).join(","))].join("\r\n") + `\r\n# exported by ${watermark}` + (note ? `\r\n${note}` : "") }; }
    return { format: "json" as const, watermark, count: rows.length, total, truncated, rows };
  }),
});
/**
 * Who can see the staff roster on the readiness page.
 *
 * It used to list every account with its email, roles, MFA state and whether
 * the bootstrap password was still unchanged, to anyone signed in — which told
 * a low-privileged account exactly which administrators to go after. Account
 * administrators still see the detail; everyone else gets the counts, which is
 * what the readiness signal actually needs.
 */
async function staffReadiness(ctx: { app: { auth: { list(): Promise<Array<{ email: string; roles: string[]; mfaEnabled: boolean; mustChangePassword: boolean; status: string }>> } }; user: { roles: string[] } }) {
  const users = await ctx.app.auth.list();
  if (can(ctx.user.roles as never, "staff.manage")) return { detail: users.map((u) => ({ email: u.email, roles: u.roles, mfa: u.mfaEnabled, temporaryPassword: u.mustChangePassword, status: u.status })), counts: null };
  const active = users.filter((u) => u.status === "active");
  return { detail: null, counts: { total: users.length, active: active.length, withMfa: active.filter((u) => u.mfaEnabled).length, temporaryPassword: active.filter((u) => u.mustChangePassword).length } };
}
export const readinessRouter = router({
  get: sessionProcedure.query(async ({ ctx }) => {
    const c = await ctx.app.campaigns.current(); const decisions = c ? await ctx.app.campaigns.listDecisions(c.id) : [];
    const evidence = await Promise.all(["receipt_benchmark_accepted", "restore_rehearsal", "client_uat_signoff", "load_benchmark"].map(async (k) => ({ kind: k, value: await ctx.app.campaigns.setting(`evidence.${k}`, null) })));
    const transport = ctx.app.transport.health(); const extractor = await ctx.app.extractor.health(); const crm = await ctx.app.crm.health();
    return { environment: ctx.app.environment, campaign: c ? { id: c.id, code: c.code, name: c.name, status: c.status, sample: c.sample } : null, sampleData: await ctx.app.campaigns.setting("sample_data", null), providers: { transport, extractor, crm, fiscal: await ctx.app.fiscal.health() }, openDecisions: decisions.filter((d) => d.blocksActivation && !["approved", "not_required"].includes(d.status)).map((d) => ({ id: d.decisionId, question: d.question, testValue: d.testValue })), evidence, activation: c ? await validateActivation({ cfg: ctx.app.cfg, environment: ctx.app.environment, campaignId: c.id, campaigns: ctx.app.campaigns, auth: ctx.app.auth, extractor: ctx.app.extractor, transport: ctx.app.transport, crm: ctx.app.crm }) : null, levels: { locallyTestable: true, integratedClientTesting: transport.mode === "configured" && extractor.mode === "real" && extractor.ok && (crm.mode === "configured" || decisions.some((d) => d.decisionId === "D-19" && /post-launch|not required/i.test(d.approvedValue ?? ""))), production: false }, staff: await staffReadiness(ctx) };
  }),
});
export const publicRouter = router({
  config: publicProcedure.query(async ({ ctx }) => ({ environment: ctx.app.environment, transport: ctx.app.transport.mode, sampleData: !!(await ctx.app.campaigns.setting("sample_data", null)), productName: "Huletts Promotions" })),
  winners: publicProcedure.input(z.object({ campaignId: z.string().optional(), period: z.string().optional() })).query(async ({ ctx, input }) => { const c = input.campaignId ? await ctx.app.campaigns.get(input.campaignId) : await ctx.app.campaigns.current(); if (!c) return { campaign: null, periods: [], winners: [] }; return { campaign: { code: c.code, name: c.name }, periods: await ctx.app.winners.publishedPeriods(c.id), winners: await ctx.app.winners.listPublic(c.id, input.period ?? null) }; }),
});
export const simulatorRouter = router({
  inbound: guard("simulator.use").input(z.object({ phone: z.string().min(6).max(20), text: z.string().max(2000).optional(), imageB64: z.string().max(16_000_000).optional(), mime: z.string().optional(), kind: z.enum(["text", "image", "unsupported"]).optional(), providerMessageId: z.string().optional(), wait: z.boolean().default(true) })).mutation(async ({ ctx, input }) => {
    if (ctx.app.environment === "production") throw conflict("the simulator is disabled in production");
    const uid = ctx.app.participants.uid(input.phone); if (!uid) throw conflict("invalid phone number");
    const kind = input.imageB64 ? "message.image" : input.kind === "unsupported" ? "message.unsupported" : "message.text";
    const r = await ctx.app.queue.receive({ provider: "simulator", providerMessageId: input.providerMessageId ?? `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, kind, channelUid: uid, text: input.text ?? "", inlineMediaB64: input.imageB64 ?? null, mime: input.mime ?? null, timestamp: new Date().toISOString() });
    if (input.wait) await ctx.app.worker.drain(200);
    const replies = r.id ? (await ctx.app.outbox.byKeyPrefix(`reply:${r.id}:`)).map((m) => ({ text: (m.payload as { body?: string }).body ?? "", status: m.status })) : [];
    const ev = r.id ? await ctx.app.queue.event(r.id) : null;
    await ctx.app.signals.metric("simulator.inbound", 1, { user: ctx.user.id });
    return { accepted: r.accepted, duplicate: r.duplicate, eventId: r.id, replies, result: ev?.result ?? null, eventStatus: ev?.status ?? null };
  }),
  transcript: guard("simulator.use").input(z.object({ phone: z.string() })).query(async ({ ctx, input }) => { const uid = ctx.app.participants.uid(input.phone) ?? input.phone; const inbound = (await ctx.app.queue.eventsFor(uid)).map((e) => ({ dir: "in" as const, kind: e.kind, text: (e.payload as { text?: string }).text ?? "", status: e.status, at: e.receivedAt })); const outbound = (await ctx.app.outbox.forUid(uid)).map((o) => ({ dir: "out" as const, purpose: o.purpose, text: (o.payload as { body?: string }).body ?? "[template]", status: o.status, at: o.createdAt })); return { phone: `***${uid.slice(-4)}`, transcript: [...inbound, ...outbound].sort((a, b) => a.at.localeCompare(b.at)) }; }),
  fixtures: guard("simulator.use").query(async () => { const fs = await import("node:fs"); const path = await import("node:path"); const dir = path.resolve("fixtures/receipts"); if (!fs.existsSync(dir)) return []; const manifest = fs.existsSync(path.join(dir, "manifest.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as { fixtures: Array<{ id: string; file: string; notes: string; expect: Record<string, unknown> }> } : { fixtures: [] }; return manifest.fixtures.map((f) => ({ id: f.id, file: f.file, notes: f.notes, expect: f.expect })); }),
  fixtureImage: guard("simulator.use").input(z.object({ file: z.string().regex(/^[A-Za-z0-9-]+\.jpg$/) })).query(async ({ input }) => { const fs = await import("node:fs"); const path = await import("node:path"); const p = path.resolve("fixtures/receipts", input.file); if (!fs.existsSync(p)) throw notFound("fixture"); return { file: input.file, b64: fs.readFileSync(p).toString("base64") }; }),
});
export { eq, and, desc, conversations };
