import { eq, and, desc, sql } from "drizzle-orm";
import { schema, type Db } from "@promo/db";
import { newId } from "../util/ids.ts";
import { maskPhone } from "../util/phone.ts";
import { parseIntent, type Intent } from "./intent.ts";
import { render, reasonText } from "./copy.ts";
import { maskIdentity, type ParticipantService } from "../participant/service.ts";
import type { CampaignService, Outlet } from "../campaign/service.ts";
import type { AuditService } from "../audit.ts";

const { conversations, submissions, entries } = schema;
const PAGE = 8;
export type InboundKind = "text" | "image" | "unsupported";
export type ConversationInput = { eventId: string; providerMessageId: string; uid: string; kind: InboundKind; text?: string; mediaBytes?: Buffer | null; mime?: string | null; correlationId?: string | null; eventAt?: string | null };
export type ConversationResult = { replies: string[]; state: string; campaignId: string | null; participantId?: string | null; submissionId?: string | null };
type Nav = { mode: "retailers" | "branches" | "search"; retailer?: string; page: number; options: Array<{ label: string; value: string; kind: "retailer" | "outlet" | "more" }>; query?: string };
type Ctx = { reg?: Record<string, string | boolean | undefined>; nav?: Nav; outletId?: string; outletLabel?: string; lastSubmissionId?: string; resumeState?: "OUTLET" | "OUTLET_CONFIRM" | "RECEIPT"; resumeOutletId?: string; resumeOutletLabel?: string; winnerNav?: Array<{ label: string; value: string }> };

export interface SubmissionIntake { submit(input: { campaignId: string; campaignVersionId: string; participantId: string; conversationId: string; inboundEventId: string; providerMessageId: string; uid: string; imageBytes: Buffer; selectedOutletId: string; correlationId?: string | null; eventAt?: string | null; reuploadOf?: string | null }): Promise<{ submissionId: string; reference: string; replay: boolean }>; statusOf(submissionId: string): Promise<string | null>; }
export interface WinnersReadModel { publishedPeriods(campaignId: string): Promise<Array<{ code: string; label: string }>>; listPublic(campaignId: string, period: string): Promise<Array<{ rank: number; name: string; location: string | null; prize: string }>>; }
export interface CrmEmitter { emit(e: { entityType: string; entityId: string; entityVersion: number; payload: Record<string, unknown>; correlationId?: string | null }): Promise<unknown>; }

/**
 * Persisted per-campaign, per-phone state machine. Every transition is a pure
 * function of (stored state, event); optimistic versioning rejects a stale
 * concurrent writer; support handoff suspends automation; background receipt
 * outcomes never overwrite a newer conversation state.
 */
export class ConversationEngine {
  constructor(private db: Db, private deps: { campaigns: CampaignService; participants: ParticipantService; intake: SubmissionIntake; winners: WinnersReadModel; crm?: CrmEmitter | null; audit: AuditService }) {}

  async session(campaignId: string, uid: string) { const [s] = await this.db.select().from(conversations).where(and(eq(conversations.campaignId, campaignId), eq(conversations.channelUid, uid))); return s ?? null; }

  async handle(input: ConversationInput): Promise<ConversationResult> {
    const { campaigns, participants } = this.deps;
    const uid = participants.uid(input.uid) ?? input.uid;
    const campaign = await campaigns.current();
    if (!campaign) return { replies: [render(undefined, "no_campaign")], state: "HOME", campaignId: null };
    const cid = campaign.id;
    const version = await campaigns.activeVersion(cid);
    const content = campaigns.contentOf(version), rules = campaigns.rulesOf(version), flags = campaigns.flagsOf(version);
    const M = content.messages;
    const session = await this.session(cid, uid);
    const expired = Boolean(session?.expiresAt && Date.parse(session.expiresAt) < Date.now());
    const state = expired ? "HOME" : (session?.state ?? "HOME"); const ctx = (expired ? { lastSubmissionId: (session?.context as Ctx | undefined)?.lastSubmissionId } : (session?.context ?? {})) as Ctx; const expectedVersion = session?.version ?? null;
    const participant = await participants.byUid(uid);
    const enrollment = participant ? await participants.enrollment(participant.id, cid) : null;
    const { intent, number, text } = parseIntent(input.text, input.kind);
    const isImage = intent === "IMAGE";

    const save = async (st: string, c: Ctx, extra: Partial<{ participantId: string | null; activeSubmissionId: string | null; handoffOwner: string | null; handoffSince: string | null }> = {}) => {
      const values = { state: st, context: c as Record<string, unknown>, participantId: extra.participantId === undefined ? (participant?.id ?? session?.participantId ?? null) : extra.participantId, activeSubmissionId: extra.activeSubmissionId === undefined ? (session?.activeSubmissionId ?? null) : extra.activeSubmissionId, handoffOwner: extra.handoffOwner === undefined ? (session?.handoffOwner ?? null) : extra.handoffOwner, handoffSince: extra.handoffSince === undefined ? (session?.handoffSince ?? null) : extra.handoffSince, updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() };
      if (session) {
        const r = await this.db.update(conversations).set({ ...values, version: session.version + 1 }).where(and(eq(conversations.id, session.id), eq(conversations.version, expectedVersion!))).returning({ id: conversations.id });
        if (!r.length) throw Object.assign(new Error("conversation changed concurrently"), { transient: true });
        return session.id;
      }
      const id = newId("cnv"); await this.db.insert(conversations).values({ id, campaignId: cid, channelUid: uid, ...values }); return id;
    };
    const reply = (st: string, msgs: string | string[], extra: Partial<ConversationResult> = {}): ConversationResult => ({ replies: ([] as string[]).concat(msgs), state: st, campaignId: cid, ...extra });
    const returning = Boolean(participant && enrollment && !enrollment.withdrawnAt);
    const menu = () => render(M, "menu", { campaign: campaign.name, status_item: flags.participantStatus ? render(M, "menu_status_item") : "" });
    const returningMenu = () => render(M, "returning_menu", { campaign: campaign.name });
    const checkpoint = (): Partial<Ctx> => ["OUTLET", "OUTLET_CONFIRM", "RECEIPT"].includes(state) ? { resumeState: state as Ctx["resumeState"], resumeOutletId: ctx.outletId, resumeOutletLabel: ctx.outletLabel } : { resumeState: ctx.resumeState, resumeOutletId: ctx.resumeOutletId, resumeOutletLabel: ctx.resumeOutletLabel };
    const home = async (prefix?: string) => { await save("HOME", { lastSubmissionId: ctx.lastSubmissionId, ...checkpoint() }); const m = returning ? returningMenu() : menu(); return reply("HOME", prefix ? [prefix, m] : [m]); };
    const welcome = async () => { await save("HOME", { lastSubmissionId: ctx.lastSubmissionId, ...checkpoint() }); return reply("HOME", returning ? render(M, "returning_greeting", { campaign: campaign.name, first_name: participant!.firstName }) : `${render(M, "greeting", { campaign: campaign.name })}\n\n${menu()}`); };
    const packLabel = `${rules.qualification.packGrams / 1000}kg pack`;
    const productName = rules.products.find((p) => p.qualifying)?.name ?? "the qualifying product";

    // support handoff suspends automation
    if (session?.handoffOwner) return reply("SUPPORT", render(M, "support_active"));
    if (intent === "SUPPORT") {
      await save("SUPPORT", ctx, { handoffOwner: "queue", handoffSince: new Date().toISOString() });
      await this.deps.audit.record(this.db, { actorType: "participant", actorId: participant?.id ?? uid, action: "support.requested", targetType: "conversation", targetId: maskPhone(uid), campaignId: cid, correlationId: input.correlationId });
      return reply("SUPPORT", render(M, "support_handoff"));
    }
    if (campaign.status === "closed") { if (intent === "WINNERS" || state === "WINNERS") return this.winnersFlow({ cid, M, ctx, state, number, fresh: intent === "WINNERS", save, reply }); return reply("HOME", render(M, "closed")); }
    const controls = await campaigns.controls(cid);

    // Greetings are a global reset action. This prevents a casual "hi" from
    // being interpreted as an invalid answer to a state-specific prompt.
    if (intent === "GREETING") return welcome();
    if (intent === "MENU") return home();
    // A numbered option on the current screen wins over the "9 = help" shortcut (page lists end in "9. More…").
    const numberedOption = number != null && state === "OUTLET" && Boolean(ctx.nav?.options[number - 1]);
    if (intent === "HELP" && !numberedOption) return reply(state, render(M, returning ? "returning_help" : "help"));
    if (intent === "CANCEL") { await save("HOME", {}); return reply("HOME", render(M, "cancel")); }

    const registration = async (): Promise<ConversationResult> => {
      const reg = { ...(ctx.reg ?? {}) } as Record<string, string | boolean | undefined>;
      const identityStage = flags.identityStage;
      const order = ["REG_NAME", "REG_SURNAME", ...(identityStage === "registration" ? ["REG_ID"] : []), "REG_LOCATION", "REG_CONFIRM", "REG_TERMS"];
      const prompts: Record<string, string> = { REG_NAME: "reg_first", REG_SURNAME: "reg_surname", REG_ID: "reg_identity", REG_LOCATION: "reg_location", REG_CONFIRM: "reg_confirm", REG_TERMS: "reg_terms" };
      const vars = () => ({ first_name: (reg.firstName as string) || participant?.firstName || "", surname: (reg.surname as string) || participant?.surname || "", identity_mask: (reg.identityMask as string) || participant?.identityMask || (identityStage === "registration" ? "(not given)" : "(asked from winners)"), location: (reg.location as string) || participant?.location || "", phone: uid, terms_version: content.termsVersion || "unversioned", privacy_version: content.privacyVersion || "unversioned", terms_url: content.termsUrl || "(link to be supplied)", min_age: rules.eligibility.minAge });
      const ask = async (st: string) => { await save(st, { ...ctx, reg }); return reply(st, render(M, prompts[st], vars())); };
      const confirm = async () => { delete reg.returnTo; await save("REG_CONFIRM", { ...ctx, reg }); return reply("REG_CONFIRM", render(M, "reg_confirm", vars())); };
      const next = (st: string) => (reg.returnTo ? confirm() : ask(order[order.indexOf(st) + 1]));
      if (intent === "BACK") return state === "REG_NAME" ? home() : ask(order[Math.max(0, order.indexOf(state) - 1)]);
      if (isImage || intent === "UNSUPPORTED") return reply(state, render(M, prompts[state], vars()));
      const val = text;
      switch (state) {
        case "REG_NAME": if (val.length < 2 || /\d/.test(val)) return reply(state, render(M, "reg_retry")); reg.firstName = val.slice(0, 60); return next(state);
        case "REG_SURNAME": if (val.length < 2) return reply(state, render(M, "reg_retry")); reg.surname = val.slice(0, 60); return next(state);
        case "REG_ID": if (!/^[A-Za-z0-9-]{5,20}$/.test(val)) return reply(state, render(M, "reg_identity_retry")); reg.identity = val.toUpperCase(); reg.identityMask = maskIdentity(val); return next(state);
        case "REG_LOCATION": if (val.length < 2) return reply(state, render(M, "reg_retry")); reg.location = val.slice(0, 80); return confirm();
        case "REG_CONFIRM": {
          if (intent === "YES") return ask("REG_TERMS");
          const field = number != null ? ({ 1: "REG_NAME", 2: "REG_SURNAME", 3: "REG_ID", 4: "REG_LOCATION" } as Record<number, string>)[number] : null;
          if (field && order.includes(field)) { reg.returnTo = "REG_CONFIRM"; return ask(field); }
          return confirm();
        }
        case "REG_TERMS": {
          if (intent === "NO") { await save("HOME", {}); return reply("HOME", render(M, "reg_declined")); }
          if (intent !== "YES") return ask("REG_TERMS");
          if (!version) return reply("HOME", render(M, "no_campaign"));
          const res = await participants.register({ uid, firstName: (reg.firstName as string) || participant!.firstName, surname: (reg.surname as string) ?? participant?.surname ?? "", location: (reg.location as string) || participant?.location || null, identity: (reg.identity as string) || null, campaignId: cid, campaignVersionId: version.id, termsVersion: content.termsVersion || `v${version.versionNo}`, privacyVersion: content.privacyVersion || `v${version.versionNo}`, marketingConsent: false, correlationId: input.correlationId });
          const p = res.participant;
          await this.deps.crm?.emit({ entityType: "participant", entityId: p.id, entityVersion: p.version, payload: { firstName: p.firstName, surname: p.surname, phone: maskPhone(p.channelUid), location: p.location, status: p.status }, correlationId: input.correlationId });
          await this.deps.crm?.emit({ entityType: "enrollment", entityId: `${p.id}:${cid}`, entityVersion: 1, payload: { participantId: p.id, campaignCode: campaign.code, termsVersion: res.enrollment.termsVersion, privacyVersion: res.enrollment.privacyVersion, marketingConsent: res.enrollment.marketingConsent, acceptedAt: res.enrollment.acceptedAt }, correlationId: input.correlationId });
          await save("HOME", { lastSubmissionId: ctx.lastSubmissionId }, { participantId: p.id });
          const m = reg.updating ? returningMenu() : menu();
          return reply("HOME", `${render(M, reg.updating ? "updated" : "registered", { first_name: p.firstName })}\n\n${m}`, { participantId: p.id });
        }
        default: return home();
      }
    };

    const beginDetailsUpdate = async (): Promise<ConversationResult> => {
      const reg = { firstName: participant?.firstName, surname: participant?.surname, location: participant?.location ?? undefined, identityMask: participant?.identityMask ?? undefined, updating: true } as Record<string, string | boolean | undefined>;
      await save("REG_NAME", { ...ctx, reg }); return reply("REG_NAME", [render(M, "update_intro", { first_name: participant?.firstName ?? "" }), render(M, "reg_first")]);
    };

    const startEntry = async (): Promise<ConversationResult> => {
      if (!participant) return reply("HOME", render(M, "not_registered"));
      if (!enrollment || enrollment.withdrawnAt) { await save("REG_TERMS", { reg: {} }); return reply("REG_TERMS", render(M, "reg_terms", { terms_version: content.termsVersion || "unversioned", privacy_version: content.privacyVersion || "unversioned", terms_url: content.termsUrl || "(link to be supplied)", min_age: rules.eligibility.minAge })); }
      if (campaign.status === "paused" || controls.pauseIntake) return reply("HOME", render(M, "paused"));
      return showRetailers(0);
    };
    const outletLabel = (o: Outlet) => `${o.retailer} — ${o.branch}, ${o.town}`;
    const paged = <T extends { label: string; value: string; kind: "retailer" | "outlet" }>(list: T[], page: number) => { const slice = list.slice(page * PAGE, page * PAGE + PAGE); const more = (page + 1) * PAGE < list.length; return [...slice, ...(more ? [{ label: "More…", value: "__more", kind: "more" as const }] : [])]; };
    const fmtOptions = (o: Array<{ label: string }>) => o.map((x, i) => `${i + 1}. ${x.label}`).join("\n");
    const showRetailers = async (page: number) => {
      const all = await campaigns.campaignOutlets(cid);
      const retailers = [...new Set(all.map((o) => o.retailer))].sort().map((r) => ({ label: r, value: r, kind: "retailer" as const }));
      const options = paged(retailers, page);
      await save("OUTLET", { ...ctx, nav: { mode: "retailers", page, options } });
      return reply("OUTLET", render(M, "outlet_retailers", { options: fmtOptions(options) }));
    };
    const showBranches = async (retailer: string, page: number) => {
      const all = (await campaigns.campaignOutlets(cid)).filter((o) => o.retailer === retailer);
      const options = paged(all.map((o) => ({ label: `${o.branch}, ${o.town}`, value: o.id, kind: "outlet" as const })), page);
      await save("OUTLET", { ...ctx, nav: { mode: "branches", retailer, page, options } });
      return reply("OUTLET", render(M, "outlet_branches", { retailer, options: fmtOptions(options) }));
    };
    const searchOutlets = async (q: string) => {
      const words = q.toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
      const all = await campaigns.campaignOutlets(cid);
      const hits = all.map((o) => { const hay = `${o.retailer} ${o.branch} ${o.town} ${o.region} ${o.aliases.join(" ")}`.toLowerCase(); const n = words.filter((w) => hay.includes(w)).length; return n ? { o, n } : null; }).filter(Boolean) as Array<{ o: typeof all[number]; n: number }>;
      hits.sort((a, b) => b.n - a.n || a.o.retailer.localeCompare(b.o.retailer) || a.o.town.localeCompare(b.o.town));
      return hits.slice(0, PAGE).map((h) => ({ label: outletLabel(h.o), value: h.o.id, kind: "outlet" as const }));
    };
    const selectOutlet = async (id: string) => {
      const o = (await campaigns.campaignOutlets(cid)).find((x) => x.id === id);
      if (!o) return reply(state, render(M, "outlet_pick_number"));
      const label = outletLabel(o);
      await save("OUTLET_CONFIRM", { ...ctx, nav: undefined, outletId: o.id, outletLabel: label });
      return reply("OUTLET_CONFIRM", render(M, "outlet_verify", { outlet: label }));
    };
    const outletConfirmation = async (): Promise<ConversationResult> => {
      const label = ctx.outletLabel ?? "the selected outlet";
      if (intent === "YES") { await save("RECEIPT", { ...ctx }); return reply("RECEIPT", render(M, "outlet_confirmed", { outlet: label })); }
      if (intent === "NO" || intent === "BACK") { await save("OUTLET", { ...ctx, nav: undefined, outletId: undefined, outletLabel: undefined }); return reply("OUTLET", render(M, "outlet_verify_no")); }
      return reply("OUTLET_CONFIRM", render(M, "outlet_verify_retry", { outlet: label }));
    };
    const outletFlow = async (): Promise<ConversationResult> => {
      const nav = ctx.nav;
      if (intent === "BACK") return nav?.mode === "retailers" || !nav ? home() : showRetailers(0);
      if (isImage || intent === "UNSUPPORTED") return reply(state, render(M, "outlet_pick_number"));
      if (number != null && nav) {
        const pick = nav.options[number - 1];
        if (!pick) return reply(state, render(M, "outlet_pick_number"));
        if (pick.kind === "more") return nav.mode === "retailers" ? showRetailers(nav.page + 1) : showBranches(nav.retailer!, nav.page + 1);
        if (pick.kind === "retailer") return showBranches(pick.value, 0);
        return selectOutlet(pick.value);
      }
      if (text.length >= 2) {
        const options = await searchOutlets(text);
        if (!options.length) return reply(state, render(M, "outlet_no_match", { query: text.slice(0, 40) }));
        await save("OUTLET", { ...ctx, nav: { mode: "search", page: 0, options, query: text } });
        return reply("OUTLET", render(M, "outlet_search", { options: fmtOptions(options) }));
      }
      return reply(state, render(M, "outlet_pick_number"));
    };
    const resumeEntry = async (): Promise<ConversationResult> => {
      const resumeState = ctx.resumeState;
      if (resumeState === "OUTLET") return showRetailers(0);
      if (resumeState === "OUTLET_CONFIRM" && ctx.resumeOutletLabel) { await save("OUTLET_CONFIRM", { ...ctx, outletId: ctx.resumeOutletId, outletLabel: ctx.resumeOutletLabel, resumeState: undefined, resumeOutletId: undefined, resumeOutletLabel: undefined }); return reply("OUTLET_CONFIRM", render(M, "outlet_verify", { outlet: ctx.resumeOutletLabel })); }
      if (resumeState === "RECEIPT" && ctx.resumeOutletLabel) { await save("RECEIPT", { ...ctx, outletId: ctx.resumeOutletId, outletLabel: ctx.resumeOutletLabel, resumeState: undefined, resumeOutletId: undefined, resumeOutletLabel: undefined }); return reply("RECEIPT", render(M, "outlet_confirmed", { outlet: ctx.resumeOutletLabel })); }
      return reply("HOME", render(M, "resume_none"));
    };

    const receiptFlow = async ({ remembered = false } = {}): Promise<ConversationResult> => {
      if (intent === "BACK") return showRetailers(0);
      if (intent === "ENTER") return startEntry();
      if (!isImage) return reply("RECEIPT", render(M, "need_photo"));
      if (!input.mediaBytes) return reply("RECEIPT", render(M, "media_missing"));
      if (!participant || !version || !ctx.outletId) return home();
      if (controls.pauseIntake) return reply("HOME", render(M, "paused"));
      const conversationId = session!.id;
      try {
        // a photo that follows a re-upload request is linked to that attempt (one thread for the participant and the reviewer)
        const reuploadOf = ctx.lastSubmissionId && (await this.deps.intake.statusOf(ctx.lastSubmissionId)) === "reupload" ? ctx.lastSubmissionId : null;
        const res = await this.deps.intake.submit({ campaignId: cid, campaignVersionId: version.id, participantId: participant.id, conversationId, inboundEventId: input.eventId, providerMessageId: input.providerMessageId, uid, imageBytes: input.mediaBytes, selectedOutletId: ctx.outletId, correlationId: input.correlationId, eventAt: input.eventAt, reuploadOf });
        await save("HOME", { lastSubmissionId: res.submissionId, outletId: ctx.outletId, outletLabel: ctx.outletLabel }, { activeSubmissionId: res.submissionId });
        return reply("HOME", render(M, res.replay ? "still_checking" : remembered ? "received_outlet" : "received", { reference: res.reference, outlet: ctx.outletLabel ?? "" }), { submissionId: res.submissionId });
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "MEDIA_REJECTED") return reply("RECEIPT", render(M, "media_rejected", { reason: (e as Error).message }));
        throw e; // the intake job retries with backoff; the participant is never told a false outcome
      }
    };
    const statusText = async (): Promise<ConversationResult> => {
      if (!flags.participantStatus) return reply("HOME", render(M, "status_off"));
      if (!participant) return reply("HOME", render(M, "not_registered"));
      const rows = await this.db.select({ reference: submissions.reference, status: submissions.status }).from(submissions).where(and(eq(submissions.participantId, participant.id), eq(submissions.campaignId, cid))).orderBy(desc(submissions.createdAt)).limit(50);
      const [{ q }] = await this.db.select({ q: sql<number>`count(*)::int` }).from(entries).where(and(eq(entries.participantId, participant.id), eq(entries.campaignId, cid), eq(entries.status, "active")));
      const label: Record<string, string> = { received: "being checked", processing: "being checked", delayed: "delayed", review: "under review", qualified: "qualified", not_qualified: "did not qualify", duplicate: "already used", reupload: "needs a clearer photo" };
      const pending = rows.filter((r) => ["received", "processing", "delayed", "review"].includes(r.status)).length;
      const rejected = rows.filter((r) => ["not_qualified", "duplicate", "reupload"].includes(r.status)).length;
      const recent = rows.slice(0, 3).map((r) => render(M, "status_line", { reference: r.reference, outcome: label[r.status] ?? r.status })).join("\n");
      return reply("HOME", render(M, "status", { campaign: campaign.name, qualified: q, pending, rejected, recent }));
    };
    const infoText = (key: string) => {
      if (key === "mechanics") return render(M, "mechanics", { min_packs: rules.qualification.minPacks, pack_label: packLabel, product: productName });
      if (key === "terms") return render(M, "terms", { terms_version: content.termsVersion || "unversioned", privacy_version: content.privacyVersion || "unversioned", terms_url: content.termsUrl || "(link to be supplied)" });
      const plan = campaigns.planOf(version);
      const prizes = content.prizesText || plan.tiers.map((t) => `${t.count} x ${t.label}`).join("; ") || "to be announced";
      return render(M, "prizes", { prizes, artwork: content.prizeArtworkUrl ? render(M, "prizes_artwork", { url: content.prizeArtworkUrl }) + (content.prizeArtworkAlt ? ` (${content.prizeArtworkAlt})` : "") : render(M, "prizes_no_artwork") });
    };

    switch (state) {
      case "HOME": {
        if (returning && number != null) {
          if (number === 1) return startEntry();
          if (number === 2) return resumeEntry();
          if (number === 3) return flags.participantStatus ? statusText() : reply("HOME", render(M, "status_off"));
          if (number === 4) return reply("HOME", infoText("mechanics"));
          if (number === 5) return reply("HOME", infoText("terms"));
          if (number === 6) return reply("HOME", infoText("prizes"));
          if (number === 7) return this.winnersFlow({ cid, M, ctx, state, number: null, fresh: true, save, reply });
          if (number === 8) return beginDetailsUpdate();
          if (number === 9) return reply("HOME", render(M, "returning_help"));
          return home();
        }
        if (intent === "REGISTER") {
          if (returning) return beginDetailsUpdate();
          await save("REG_NAME", { reg: {} }); return reply("REG_NAME", render(M, "reg_first"));
        }
        if (intent === "ENTER") return startEntry();
        if (intent === "MECHANICS") return reply("HOME", infoText("mechanics"));
        if (intent === "TERMS") return reply("HOME", infoText("terms"));
        if (intent === "PRIZES") return reply("HOME", infoText("prizes"));
        if (intent === "WINNERS") return this.winnersFlow({ cid, M, ctx, state, number, fresh: true, save, reply });
        if (intent === "STATUS") return statusText();
        if (isImage) {
          // A further photo after a submission (or a re-upload request) reuses the outlet the participant chose; the
          // acknowledgement names it and says how to change it. The header cross-check still catches a wrong shop.
          if (participant && enrollment && !enrollment.withdrawnAt && ctx.outletId && ctx.lastSubmissionId && !controls.pauseIntake && campaign.status === "active") return receiptFlow({ remembered: true });
          return reply("HOME", [render(M, "need_photo"), menu()]);
        }
        if (intent === "BACK") return home();
        return reply("HOME", render(M, "unknown", { menu: menu() }));
      }
      case "REG_NAME": case "REG_SURNAME": case "REG_ID": case "REG_LOCATION": case "REG_CONFIRM": case "REG_TERMS": return registration();
      case "OUTLET": return outletFlow();
      case "OUTLET_CONFIRM": return outletConfirmation();
      case "RECEIPT": return receiptFlow();
      case "WINNERS": return this.winnersFlow({ cid, M, ctx, state, number, fresh: intent === "WINNERS", save, reply });
      default: return home();
    }
  }

  private async winnersFlow({ cid, M, ctx, state, number, fresh, save, reply }: { cid: string; M: Record<string, string>; ctx: Ctx; state: string; number: number | null; fresh: boolean; save: (s: string, c: Ctx) => Promise<string>; reply: (s: string, m: string | string[]) => ConversationResult }): Promise<ConversationResult> {
    const periods = await this.deps.winners.publishedPeriods(cid);
    if (!periods.length) { await save("HOME", ctx); return reply("HOME", render(M, "winners_none")); }
    if (!fresh && state === "WINNERS" && number != null && ctx.winnerNav?.[number - 1]) {
      const pick = ctx.winnerNav[number - 1];
      const rows = await this.deps.winners.listPublic(cid, pick.value);
      const lines = rows.map((w) => render(M, "winners_line", { rank: w.rank, name: w.name, location: w.location ?? "", prize: w.prize })).join("\n") || "(none)";
      return reply("WINNERS", render(M, "winners_list", { period: pick.label, lines }));
    }
    const options = periods.map((p) => ({ label: p.label, value: p.code }));
    await save("WINNERS", { ...ctx, winnerNav: options });
    return reply("WINNERS", render(M, "winners_periods", { options: options.map((o, i) => `${i + 1}. ${o.label}`).join("\n") }));
  }

  /** Background outcome hook: clears the active submission only if it is still the newest one. */
  async onSubmissionOutcome(campaignId: string, uid: string, submissionId: string) {
    await this.db.update(conversations).set({ activeSubmissionId: null }).where(and(eq(conversations.campaignId, campaignId), eq(conversations.channelUid, uid), eq(conversations.activeSubmissionId, submissionId)));
  }
  async claimHandoff(campaignId: string, uid: string, operatorId: string) {
    const s = await this.session(campaignId, uid);
    if (s) await this.db.update(conversations).set({ handoffOwner: operatorId, handoffSince: s.handoffSince ?? new Date().toISOString(), version: s.version + 1, updatedAt: new Date().toISOString() }).where(eq(conversations.id, s.id));
    else await this.db.insert(conversations).values({ id: newId("cnv"), campaignId, channelUid: uid, state: "SUPPORT", context: {}, handoffOwner: operatorId, handoffSince: new Date().toISOString() });
    await this.deps.audit.record(this.db, { actorType: "staff", actorId: operatorId, action: "support.claim", targetType: "conversation", targetId: maskPhone(uid), campaignId });
  }
  async releaseHandoff(campaignId: string, uid: string, operatorId: string) {
    const s = await this.session(campaignId, uid); if (!s) return;
    await this.db.update(conversations).set({ state: "HOME", context: {}, handoffOwner: null, handoffSince: null, version: s.version + 1, updatedAt: new Date().toISOString() }).where(eq(conversations.id, s.id));
    await this.deps.audit.record(this.db, { actorType: "staff", actorId: operatorId, action: "support.release", targetType: "conversation", targetId: maskPhone(uid), campaignId });
  }
  async handoffQueue() { return this.db.select().from(conversations).where(sql`${conversations.handoffOwner} is not null`).orderBy(conversations.handoffSince); }
}
export { render, reasonText, parseIntent };
export type { Intent };
