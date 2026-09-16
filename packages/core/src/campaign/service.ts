import { eq, and, desc, asc, inArray, sql } from "drizzle-orm";
import { schema, type Db, type DbOrTx } from "@promo/db";
import { newId } from "../util/ids.ts";
import { hashOf } from "../util/json.ts";
import { invalid, conflict, notFound } from "../util/errors.ts";
import type { AuditService } from "../audit.ts";
import { Rules, Flags, Content, PrizePlan, CAMPAIGN_TRANSITIONS, type Rules as RulesT } from "./types.ts";

const { campaigns, campaignVersions, campaignPeriods, campaignDecisions, campaignControls, outlets, campaignOutlets, products, settings } = schema;
export type Campaign = typeof campaigns.$inferSelect;
export type CampaignVersion = typeof campaignVersions.$inferSelect;
export type Outlet = typeof outlets.$inferSelect;

/** Campaign configuration: immutable activated versions, half-open periods, decision register, pause controls, master data. */
export class CampaignService {
  constructor(private db: Db, private audit: AuditService) {}

  // ---- campaigns
  async list() { return this.db.select().from(campaigns).orderBy(desc(campaigns.createdAt)); }
  async get(id: string) { const [c] = await this.db.select().from(campaigns).where(eq(campaigns.id, id)); return c ?? null; }
  async byCode(code: string) { const [c] = await this.db.select().from(campaigns).where(eq(campaigns.code, code)); return c ?? null; }
  /** The campaign consumers currently talk to: active first, then paused, then the most recent closed (winners browsing). */
  async current() { const rows = await this.db.select().from(campaigns).where(inArray(campaigns.status, ["active", "paused", "closed"])); const rank: Record<string, number> = { active: 0, paused: 1, closed: 2 }; return rows.sort((a, b) => rank[a.status] - rank[b.status] || (b.createdAt < a.createdAt ? -1 : 1))[0] ?? null; }
  async create(input: { code: string; name: string; description?: string; startsAt: string; endsAt: string; timezone?: string; sample?: boolean; rules?: unknown; content?: unknown; flags?: unknown; prizePlan?: unknown }, actorId: string) {
    if (!/^[A-Z0-9][A-Z0-9-]{2,39}$/.test(input.code)) throw invalid("code must be 3–40 characters: A-Z, 0-9, dashes");
    if (Number.isNaN(Date.parse(input.startsAt)) || Number.isNaN(Date.parse(input.endsAt)) || Date.parse(input.endsAt) <= Date.parse(input.startsAt)) throw invalid("startsAt/endsAt must be ISO-8601 with endsAt after startsAt");
    if (await this.byCode(input.code)) throw conflict(`campaign code ${input.code} already exists`);
    const id = newId("cmp");
    return this.db.transaction(async (tx) => {
      await tx.insert(campaigns).values({ id, code: input.code, name: input.name || input.code, description: input.description ?? "", startsAt: input.startsAt, endsAt: input.endsAt, timezone: input.timezone || "Africa/Harare", sample: !!input.sample, createdBy: actorId });
      await tx.insert(campaignControls).values({ campaignId: id, updatedBy: actorId });
      const vid = await this.createVersionIn(tx, id, { rules: input.rules, content: input.content, flags: input.flags, prizePlan: input.prizePlan }, actorId);
      await this.audit.record(tx, { actorType: "staff", actorId, action: "campaign.create", targetType: "campaign", targetId: id, campaignId: id, payload: { code: input.code } });
      return { campaign: (await tx.select().from(campaigns).where(eq(campaigns.id, id)))[0], draftVersionId: vid };
    });
  }
  async update(id: string, patch: { name?: string; description?: string; startsAt?: string; endsAt?: string; timezone?: string }, actorId: string) {
    const c = await this.get(id); if (!c) throw notFound("campaign");
    if (["closed", "archived"].includes(c.status)) throw conflict(`campaign is ${c.status}`);
    const next = { name: patch.name ?? c.name, description: patch.description ?? c.description, startsAt: patch.startsAt ?? c.startsAt, endsAt: patch.endsAt ?? c.endsAt, timezone: patch.timezone ?? c.timezone };
    if (Date.parse(next.endsAt) <= Date.parse(next.startsAt)) throw invalid("endsAt must be after startsAt");
    await this.db.update(campaigns).set({ ...next, updatedAt: new Date().toISOString() }).where(eq(campaigns.id, id));
    await this.audit.record(this.db, { actorType: "staff", actorId, action: "campaign.update", targetType: "campaign", targetId: id, campaignId: id, payload: patch });
    return (await this.get(id))!;
  }
  async setStatus(id: string, status: string, actorId: string, reason?: string | null) {
    const c = await this.get(id); if (!c) throw notFound("campaign");
    if (!CAMPAIGN_TRANSITIONS[c.status]?.includes(status)) throw conflict(`cannot move a ${c.status} campaign to ${status}`);
    if (status === "active" && !(await this.activeVersion(id))) throw conflict("activate a campaign version first");
    await this.db.update(campaigns).set({ status, updatedAt: new Date().toISOString() }).where(eq(campaigns.id, id));
    await this.audit.record(this.db, { actorType: "staff", actorId, action: `campaign.${status}`, targetType: "campaign", targetId: id, campaignId: id, reason: reason ?? null });
    return (await this.get(id))!;
  }
  async clone(id: string, { code, name }: { code: string; name?: string }, actorId: string) {
    const src = await this.get(id); if (!src) throw notFound("campaign");
    const v = (await this.activeVersion(id)) ?? (await this.versions(id)).at(-1);
    const out = await this.create({ code, name: name || `${src.name} (copy)`, description: src.description, startsAt: src.startsAt, endsAt: src.endsAt, timezone: src.timezone, sample: src.sample, rules: v?.rules, content: v?.content, flags: v?.flags, prizePlan: v?.prizePlan }, actorId);
    const members = await this.db.select().from(campaignOutlets).where(eq(campaignOutlets.campaignId, id));
    if (members.length) await this.db.insert(campaignOutlets).values(members.map((m) => ({ ...m, campaignId: out.campaign.id })));
    const decisions = await this.listDecisions(id);
    if (decisions.length) await this.db.insert(campaignDecisions).values(decisions.map((d) => ({ id: newId("dec"), campaignId: out.campaign.id, decisionId: d.decisionId, question: d.question, testValue: d.testValue, approvedValue: null, status: "open", owner: d.owner, blocksActivation: d.blocksActivation })));
    await this.audit.record(this.db, { actorType: "staff", actorId, action: "campaign.clone", targetType: "campaign", targetId: out.campaign.id, campaignId: out.campaign.id, payload: { from: id } });
    return out;
  }

  // ---- controls (pause semantics are separate switches)
  async controls(id: string) { const [c] = await this.db.select().from(campaignControls).where(eq(campaignControls.campaignId, id)); return c ?? { campaignId: id, pauseIntake: false, pauseAutoQualify: false, pauseOutbound: false, pauseDraws: false, updatedBy: null, updatedAt: null }; }
  async setControls(id: string, patch: Partial<{ pauseIntake: boolean; pauseAutoQualify: boolean; pauseOutbound: boolean; pauseDraws: boolean }>, actorId: string) {
    await this.db.insert(campaignControls).values({ campaignId: id, ...patch, updatedBy: actorId, updatedAt: new Date().toISOString() }).onConflictDoUpdate({ target: campaignControls.campaignId, set: { ...patch, updatedBy: actorId, updatedAt: new Date().toISOString() } });
    await this.audit.record(this.db, { actorType: "staff", actorId, action: "campaign.controls", targetType: "campaign", targetId: id, campaignId: id, payload: patch });
    return this.controls(id);
  }

  // ---- versions (immutable once active)
  private async createVersionIn(tx: DbOrTx, campaignId: string, input: { rules?: unknown; content?: unknown; flags?: unknown; prizePlan?: unknown }, actorId: string) {
    const rules = Rules.parse(input.rules ?? {}), content = Content.parse(input.content ?? {}), flags = Flags.parse(input.flags ?? {}), prizePlan = PrizePlan.parse(input.prizePlan ?? {});
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(campaignVersions).where(eq(campaignVersions.campaignId, campaignId));
    const id = newId("ver");
    await tx.insert(campaignVersions).values({ id, campaignId, versionNo: n + 1, status: "draft", rules, content, flags, prizePlan, configHash: hashOf({ rules, content, flags, prizePlan }), createdBy: actorId });
    await this.audit.record(tx, { actorType: "staff", actorId, action: "campaign.version.create", targetType: "campaign_version", targetId: id, campaignId });
    return id;
  }
  async createVersion(campaignId: string, input: { fromActive?: boolean; rules?: unknown; content?: unknown; flags?: unknown; prizePlan?: unknown }, actorId: string) {
    if (!(await this.get(campaignId))) throw notFound("campaign");
    let base: { rules?: unknown; content?: unknown; flags?: unknown; prizePlan?: unknown } = {};
    if (input.fromActive) { const v = (await this.activeVersion(campaignId)) ?? (await this.versions(campaignId)).at(-1); if (v) base = { rules: v.rules, content: v.content, flags: v.flags, prizePlan: v.prizePlan }; }
    const merged = { rules: { ...(base.rules as object || {}), ...((input.rules as object) || {}) }, content: { ...(base.content as object || {}), ...((input.content as object) || {}) }, flags: { ...(base.flags as object || {}), ...((input.flags as object) || {}) }, prizePlan: { ...(base.prizePlan as object || {}), ...((input.prizePlan as object) || {}) } };
    return this.db.transaction((tx) => this.createVersionIn(tx, campaignId, merged, actorId));
  }
  async updateDraftVersion(versionId: string, patch: { rules?: unknown; content?: unknown; flags?: unknown; prizePlan?: unknown }, actorId: string) {
    const v = await this.version(versionId); if (!v) throw notFound("version");
    if (v.status !== "draft") throw conflict("only draft versions can be edited; create a new version for a change");
    const rules = Rules.parse(patch.rules ?? v.rules), content = Content.parse(patch.content ?? v.content), flags = Flags.parse(patch.flags ?? v.flags), prizePlan = PrizePlan.parse(patch.prizePlan ?? v.prizePlan);
    await this.db.update(campaignVersions).set({ rules, content, flags, prizePlan, configHash: hashOf({ rules, content, flags, prizePlan }) }).where(eq(campaignVersions.id, versionId));
    await this.audit.record(this.db, { actorType: "staff", actorId, action: "campaign.version.update", targetType: "campaign_version", targetId: versionId, campaignId: v.campaignId });
    return (await this.version(versionId))!;
  }
  async activateVersion(campaignId: string, versionId: string, actorId: string) {
    return this.db.transaction(async (tx) => {
      const [v] = await tx.select().from(campaignVersions).where(eq(campaignVersions.id, versionId)).for("update");
      if (!v || v.campaignId !== campaignId) throw notFound("version");
      if (v.status !== "draft") throw conflict(`only draft versions can be activated (status=${v.status})`);
      const plan = PrizePlan.parse(v.prizePlan); const rules = Rules.parse(v.rules);
      if (!rules.products.some((p) => p.qualifying)) throw invalid("the version needs at least one qualifying product");
      await tx.update(campaignVersions).set({ status: "retired" }).where(and(eq(campaignVersions.campaignId, campaignId), eq(campaignVersions.status, "active")));
      await tx.update(campaignVersions).set({ status: "active", activatedAt: new Date().toISOString(), activatedBy: actorId }).where(eq(campaignVersions.id, versionId));
      await this.audit.record(tx, { actorType: "staff", actorId, action: "campaign.version.activate", targetType: "campaign_version", targetId: versionId, campaignId, payload: { configHash: v.configHash, tiers: plan.tiers.length } });
      return (await tx.select().from(campaignVersions).where(eq(campaignVersions.id, versionId)))[0];
    });
  }
  async version(id: string) { const [v] = await this.db.select().from(campaignVersions).where(eq(campaignVersions.id, id)); return v ?? null; }
  async versions(campaignId: string) { return this.db.select().from(campaignVersions).where(eq(campaignVersions.campaignId, campaignId)).orderBy(asc(campaignVersions.versionNo)); }
  async activeVersion(campaignId: string) { const [v] = await this.db.select().from(campaignVersions).where(and(eq(campaignVersions.campaignId, campaignId), eq(campaignVersions.status, "active"))); return v ?? null; }
  rulesOf(v: CampaignVersion | null): RulesT { return Rules.parse(v?.rules ?? {}); }
  contentOf(v: CampaignVersion | null) { return Content.parse(v?.content ?? {}); }
  flagsOf(v: CampaignVersion | null) { return Flags.parse(v?.flags ?? {}); }
  planOf(v: CampaignVersion | null) { return PrizePlan.parse(v?.prizePlan ?? {}); }

  // ---- periods (half-open [startsAt, endsAt), never overlapping)
  async periods(campaignId: string) { return this.db.select().from(campaignPeriods).where(eq(campaignPeriods.campaignId, campaignId)).orderBy(asc(campaignPeriods.startsAt)); }
  async period(id: string) { const [p] = await this.db.select().from(campaignPeriods).where(eq(campaignPeriods.id, id)); return p ?? null; }
  async periodAt(campaignId: string, iso: string) { const t = Date.parse(iso); return (await this.periods(campaignId)).find((p) => t >= Date.parse(p.startsAt) && t < Date.parse(p.endsAt)) ?? null; }
  async upsertPeriod(campaignId: string, input: { code: string; label?: string; startsAt: string; endsAt: string; drawAt?: string | null; prizePlan?: unknown; status?: string }, actorId: string) {
    if (!/^[A-Z0-9][A-Z0-9+-]{0,19}$/i.test(input.code)) throw invalid("period code: 1–20 chars, letters, digits, + or -");
    if (Date.parse(input.endsAt) <= Date.parse(input.startsAt)) throw invalid("endsAt must be after startsAt");
    const all = await this.periods(campaignId);
    for (const p of all) { if (p.code === input.code) continue; if (Date.parse(input.startsAt) < Date.parse(p.endsAt) && Date.parse(input.endsAt) > Date.parse(p.startsAt)) throw invalid(`period overlaps ${p.code}`); }
    const existing = all.find((p) => p.code === input.code);
    const plan = input.prizePlan == null ? null : PrizePlan.parse(input.prizePlan);
    if (existing) {
      if (existing.status === "drawn") throw conflict("a drawn period is immutable");
      await this.db.update(campaignPeriods).set({ label: input.label ?? existing.label, startsAt: input.startsAt, endsAt: input.endsAt, drawAt: input.drawAt ?? existing.drawAt, prizePlan: input.prizePlan === undefined ? existing.prizePlan : plan, status: input.status ?? existing.status }).where(eq(campaignPeriods.id, existing.id));
      await this.audit.record(this.db, { actorType: "staff", actorId, action: "period.update", targetType: "campaign_period", targetId: existing.id, campaignId });
      return (await this.period(existing.id))!;
    }
    const id = newId("per");
    await this.db.insert(campaignPeriods).values({ id, campaignId, code: input.code, label: input.label || input.code, startsAt: input.startsAt, endsAt: input.endsAt, drawAt: input.drawAt ?? null, prizePlan: plan, status: input.status || "scheduled" });
    await this.audit.record(this.db, { actorType: "staff", actorId, action: "period.create", targetType: "campaign_period", targetId: id, campaignId });
    return (await this.period(id))!;
  }
  async setPeriodStatus(tx: DbOrTx, id: string, status: string) { await tx.update(campaignPeriods).set({ status }).where(eq(campaignPeriods.id, id)); }

  // ---- decisions register
  async listDecisions(campaignId: string) { return this.db.select().from(campaignDecisions).where(eq(campaignDecisions.campaignId, campaignId)).orderBy(asc(campaignDecisions.decisionId)); }
  async upsertDecision(campaignId: string, d: { decisionId: string; question?: string; testValue?: string | null; approvedValue?: string | null; status?: string; owner?: string | null; evidence?: string | null; blocksActivation?: boolean }, actorId: string) {
    if (d.status && !["open", "proposed", "approved", "not_required"].includes(d.status)) throw invalid("status must be open, proposed, approved or not_required");
    if (d.status === "approved" && !d.approvedValue) throw invalid("an approved decision needs an approved value");
    const [ex] = await this.db.select().from(campaignDecisions).where(and(eq(campaignDecisions.campaignId, campaignId), eq(campaignDecisions.decisionId, d.decisionId)));
    const approving = d.status === "approved";
    if (ex) await this.db.update(campaignDecisions).set({ question: d.question ?? ex.question, testValue: d.testValue ?? ex.testValue, approvedValue: d.approvedValue ?? ex.approvedValue, status: d.status ?? ex.status, owner: d.owner ?? ex.owner, evidence: d.evidence ?? ex.evidence, blocksActivation: d.blocksActivation ?? ex.blocksActivation, approvedBy: approving ? actorId : ex.approvedBy, approvedAt: approving ? new Date().toISOString() : ex.approvedAt, updatedAt: new Date().toISOString() }).where(eq(campaignDecisions.id, ex.id));
    else await this.db.insert(campaignDecisions).values({ id: newId("dec"), campaignId, decisionId: d.decisionId, question: d.question || d.decisionId, testValue: d.testValue ?? null, approvedValue: d.approvedValue ?? null, status: d.status || "open", owner: d.owner ?? null, evidence: d.evidence ?? null, blocksActivation: d.blocksActivation ?? true, approvedBy: approving ? actorId : null, approvedAt: approving ? new Date().toISOString() : null });
    await this.audit.record(this.db, { actorType: "staff", actorId, action: "decision.update", targetType: "campaign_decision", targetId: d.decisionId, campaignId, payload: { status: d.status } });
    return (await this.db.select().from(campaignDecisions).where(and(eq(campaignDecisions.campaignId, campaignId), eq(campaignDecisions.decisionId, d.decisionId))))[0];
  }

  // ---- outlets + products (master data) and campaign membership
  async outlets() { return this.db.select().from(outlets).orderBy(asc(outlets.retailer), asc(outlets.town), asc(outlets.branch)); }
  async outlet(id: string) { const [o] = await this.db.select().from(outlets).where(eq(outlets.id, id)); return o ?? null; }
  async campaignOutlets(campaignId: string) {
    const rows = await this.db.select({ o: outlets, m: campaignOutlets }).from(campaignOutlets).innerJoin(outlets, eq(outlets.id, campaignOutlets.outletId)).where(and(eq(campaignOutlets.campaignId, campaignId), eq(outlets.active, true))).orderBy(asc(outlets.retailer), asc(outlets.town), asc(outlets.branch));
    return rows.map((r) => ({ ...r.o, membership: { activeFrom: r.m.activeFrom, activeTo: r.m.activeTo, collectionPoint: r.m.collectionPoint } }));
  }
  async upsertOutlet(o: { code: string; retailer: string; branch: string; town: string; region?: string; aliases?: string[]; collectionPoint?: boolean; active?: boolean; sample?: boolean }, actorId: string) {
    if (!o.code || !o.retailer || !o.branch || !o.town) throw invalid("code, retailer, branch and town are required");
    const id = `out_${o.code.replace(/[^A-Za-z0-9-]/g, "_")}`;
    const values = { id, code: o.code, retailer: o.retailer, branch: o.branch, town: o.town, region: o.region ?? "", aliases: o.aliases ?? [], collectionPoint: !!o.collectionPoint, active: o.active ?? true, sample: !!o.sample, updatedAt: new Date().toISOString() };
    await this.db.insert(outlets).values(values).onConflictDoUpdate({ target: outlets.code, set: { retailer: values.retailer, branch: values.branch, town: values.town, region: values.region, aliases: values.aliases, collectionPoint: values.collectionPoint, active: values.active, updatedAt: values.updatedAt } });
    await this.audit.record(this.db, { actorType: "staff", actorId, action: "outlet.upsert", targetType: "outlet", targetId: id });
    return (await this.db.select().from(outlets).where(eq(outlets.code, o.code)))[0];
  }
  async setCampaignOutlets(campaignId: string, members: Array<{ outletId: string; collectionPoint?: boolean; activeFrom?: string | null; activeTo?: string | null }>, actorId: string) {
    return this.db.transaction(async (tx) => {
      await tx.delete(campaignOutlets).where(eq(campaignOutlets.campaignId, campaignId));
      if (members.length) await tx.insert(campaignOutlets).values(members.map((m) => ({ campaignId, outletId: m.outletId, collectionPoint: !!m.collectionPoint, activeFrom: m.activeFrom ?? null, activeTo: m.activeTo ?? null })));
      await this.audit.record(tx, { actorType: "staff", actorId, action: "campaign.outlets.set", targetType: "campaign", targetId: campaignId, campaignId, payload: { count: members.length } });
      return members.length;
    });
  }
  /** Validated CSV import: preview reports every row error; import is all-or-nothing. */
  async importOutletsCsv(campaignId: string | null, csv: string, { dryRun, actorId }: { dryRun: boolean; actorId: string }) {
    const rows = parseCsv(csv); const errors: Array<{ row: number; error: string }> = []; const seen = new Set<string>();
    if (!rows.length) errors.push({ row: 1, error: "no data rows (expected header: code,retailer,branch,town,region,collection_point,active,aliases)" });
    rows.forEach((r, i) => {
      const line = i + 2;
      for (const k of ["code", "retailer", "branch", "town"]) if (!r[k]) errors.push({ row: line, error: `${k} required` });
      if (r.code && !/^[A-Za-z0-9-]{2,30}$/.test(r.code)) errors.push({ row: line, error: "code must be 2–30 letters/digits/dashes" });
      if (r.code) { if (seen.has(r.code)) errors.push({ row: line, error: `duplicate code ${r.code}` }); seen.add(r.code); }
      for (const k of ["collection_point", "active"]) if (r[k] && !/^(0|1|true|false|yes|no)$/i.test(r[k])) errors.push({ row: line, error: `${k} must be yes/no` });
    });
    if (errors.length || dryRun) return { ok: errors.length === 0, rows: rows.length, errors, imported: 0 };
    return this.db.transaction(async (tx) => {
      const ids: string[] = [];
      for (const r of rows) {
        const id = `out_${r.code.replace(/[^A-Za-z0-9-]/g, "_")}`;
        const v = { id, code: r.code, retailer: r.retailer, branch: r.branch, town: r.town, region: r.region || "", aliases: (r.aliases || "").split(";").map((s) => s.trim()).filter(Boolean), collectionPoint: /^(1|true|yes)$/i.test(r.collection_point || ""), active: !/^(0|false|no)$/i.test(r.active || "yes"), updatedAt: new Date().toISOString() };
        await tx.insert(outlets).values(v).onConflictDoUpdate({ target: outlets.code, set: { retailer: v.retailer, branch: v.branch, town: v.town, region: v.region, aliases: v.aliases, collectionPoint: v.collectionPoint, active: v.active, updatedAt: v.updatedAt } });
        const [row] = await tx.select({ id: outlets.id, cp: outlets.collectionPoint }).from(outlets).where(eq(outlets.code, r.code)); ids.push(row.id);
        if (campaignId) await tx.insert(campaignOutlets).values({ campaignId, outletId: row.id, collectionPoint: row.cp }).onConflictDoUpdate({ target: [campaignOutlets.campaignId, campaignOutlets.outletId], set: { collectionPoint: row.cp } });
      }
      await this.audit.record(tx, { actorType: "staff", actorId, action: "outlets.import", targetType: "campaign", targetId: campaignId ?? "master", campaignId, payload: { rows: rows.length } });
      return { ok: true, rows: rows.length, errors: [], imported: ids.length };
    });
  }
  async products() { return this.db.select().from(products).orderBy(asc(products.brand), asc(products.name)); }
  async upsertProduct(p: { sku: string; brand?: string; name: string; packGrams: number; aliases?: string[]; active?: boolean; sample?: boolean }, actorId: string) {
    if (!p.sku || !p.name) throw invalid("sku and name are required"); if (!Number.isInteger(p.packGrams) || p.packGrams <= 0) throw invalid("packGrams must be a positive integer");
    const id = `prd_${p.sku.replace(/[^A-Za-z0-9-]/g, "_")}`;
    await this.db.insert(products).values({ id, sku: p.sku, brand: p.brand ?? "", name: p.name, packGrams: p.packGrams, aliases: p.aliases ?? [], active: p.active ?? true, sample: !!p.sample }).onConflictDoUpdate({ target: products.sku, set: { brand: p.brand ?? "", name: p.name, packGrams: p.packGrams, aliases: p.aliases ?? [], active: p.active ?? true } });
    await this.audit.record(this.db, { actorType: "staff", actorId, action: "product.upsert", targetType: "product", targetId: id });
    return (await this.db.select().from(products).where(eq(products.sku, p.sku)))[0];
  }

  // ---- settings (small JSON key/value; every write audited by the caller)
  async setting<T = unknown>(key: string, fallback: T): Promise<T> { const [r] = await this.db.select().from(settings).where(eq(settings.key, key)); return r ? (r.value as T) : fallback; }
  async setSetting(key: string, value: unknown, actorId: string) { await this.db.insert(settings).values({ key, value, updatedBy: actorId, updatedAt: new Date().toISOString() }).onConflictDoUpdate({ target: settings.key, set: { value, updatedBy: actorId, updatedAt: new Date().toISOString() } }); await this.audit.record(this.db, { actorType: "staff", actorId, action: "settings.update", targetType: "setting", targetId: key }); }
}

/** Small RFC-4180 parser (quoted fields, CRLF, BOM). Formula injection is neutralised on export, never on import. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = []; let row: string[] = [], field = "", q = false; const s = String(text || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; continue; }
    if (c === '"') q = true; else if (c === ",") { row.push(field); field = ""; } else if (c === "\n" || c === "\r") { if (c === "\r" && s[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; } else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((v) => v.trim() !== "")); if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}
/** Neutralise spreadsheet formula injection in exported cells. */
export function csvCell(v: unknown): string { let s = v == null ? "" : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
