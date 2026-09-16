import type { Config } from "../config.ts";
import type { CampaignService } from "../campaign/service.ts";
import type { AuthService } from "../auth/service.ts";
import type { Extractor } from "../extraction/types.ts";
import type { WhatsAppTransport } from "../whatsapp/transport.ts";
import type { CrmService } from "../crm/index.ts";
import { DECISION_IDS } from "../campaign/types.ts";

const SAMPLE = /test only|sample|fictional|example\.test|sweetvale|mopani|baobab|jacaranda|msasa|kopje|savanna|riverbend|highveld/i;
export type Failure = { code: string; message: string; blocking: boolean };
/**
 * Production activation validator (T-36). Runs server-side on every request
 * to activate a campaign in a production environment; also reported to the
 * console in every environment. Sample configuration, test providers,
 * synthetic assets and open decisions can never become live policy silently.
 */
export async function validateActivation(d: { cfg: Config; environment: string; campaignId: string; campaigns: CampaignService; auth: AuthService; extractor: Extractor; transport: WhatsAppTransport; crm: CrmService }) {
  const prod = d.environment === "production"; const f: Failure[] = [];
  const fail = (code: string, message: string, always = false) => f.push({ code, message, blocking: always || prod });
  const c = await d.campaigns.get(d.campaignId); if (!c) return { ok: false, environment: d.environment, failures: [{ code: "CAMPAIGN_NOT_FOUND", message: "campaign not found", blocking: true }], blockingCount: 1 };
  // Judge the configuration that WOULD be live: the active version, or — while the
  // campaign is still being set up — its latest draft, so the set-up flow can say
  // what is missing before anything is activated. NO_ACTIVE_VERSION still fails.
  const active = await d.campaigns.activeVersion(d.campaignId); if (!active) fail("NO_ACTIVE_VERSION", "no activated campaign version");
  const v = active ?? [...(await d.campaigns.versions(d.campaignId))].reverse().find((x) => x.status === "draft") ?? null;
  const rules = d.campaigns.rulesOf(v), content = d.campaigns.contentOf(v), plan = d.campaigns.planOf(v);
  const decisions = await d.campaigns.listDecisions(d.campaignId);
  for (const id of DECISION_IDS) { const row = decisions.find((x) => x.decisionId === id); if (!row) fail(`DECISION_MISSING_${id}`, `${id} is not in the register`); else if (row.blocksActivation && !["approved", "not_required"].includes(row.status)) fail(`DECISION_OPEN_${id}`, `${id} (${row.question}) is ${row.status}`); else if (row.status === "approved" && !row.approvedValue) fail(`DECISION_NO_VALUE_${id}`, `${id} approved without a value`); }
  if (c.sample || SAMPLE.test(`${c.name} ${c.code} ${JSON.stringify(content)} ${JSON.stringify(rules.products)}`)) fail("SAMPLE_CONFIGURATION", "campaign carries TEST ONLY / sample markers");
  if (!content.termsUrl || !content.termsVersion || !content.privacyVersion) fail("CONTENT_TERMS", "termsUrl, termsVersion and privacyVersion are required");
  if (!content.prizesText && !content.prizeArtworkUrl) fail("CONTENT_PRIZES", "prize text or artwork is required");
  if (!rules.products.some((p) => p.qualifying)) fail("RULES_PRODUCTS", "no qualifying product configured");
  const outletsList = await d.campaigns.campaignOutlets(d.campaignId); if (!outletsList.length) fail("OUTLETS_EMPTY", "no participating outlets"); if (outletsList.some((o) => o.sample)) fail("OUTLETS_SAMPLE", "sample outlets present");
  if (!outletsList.some((o) => o.membership.collectionPoint || o.collectionPoint)) fail("OUTLETS_COLLECTION", "no prize collection point configured");
  if (!(await d.campaigns.periods(d.campaignId)).length) fail("PERIODS_EMPTY", "no draw periods configured");
  if (!plan.tiers.length) fail("PRIZES_EMPTY", "no prize allocation configured");
  if (d.cfg.WHATSAPP_PROVIDER !== "cloud-api" || d.transport.mode !== "configured") fail("TRANSPORT", `WhatsApp provider is ${d.cfg.WHATSAPP_PROVIDER} (production requires cloud-api)`);
  const xh = await d.extractor.health(); if (xh.mode !== "real" || !xh.ok) fail("EXTRACTOR", `receipt extractor mode=${xh.mode} ok=${xh.ok}`);
  const ch = await d.crm.health(); const d19 = decisions.find((x) => x.decisionId === "D-19"); if (ch.mode !== "configured" && !/post-launch|not required/i.test(d19?.approvedValue ?? "")) fail("CRM", `CRM provider ${ch.mode}; approve D-19 as post-launch or configure the adapter`);
  if (!d.cfg.DATA_KEY || d.cfg.DATA_KEY.length < 24) fail("DATA_KEY", "DATA_KEY is missing or too short"); if (!d.cfg.AUDIT_SIGNING_KEY) fail("AUDIT_SIGNING_KEY", "AUDIT_SIGNING_KEY is not set");
  if (!d.cfg.META_APP_SECRET || !d.cfg.META_VERIFY_TOKEN) fail("WEBHOOK_SECRETS", "META_APP_SECRET / META_VERIFY_TOKEN missing");
  const users = await d.auth.list(); const withRole = (r: string) => users.filter((u) => u.status === "active" && u.roles.includes(r));
  if (!withRole("draw_officer").length) fail("STAFF_DRAW_OFFICER", "no active draw officer"); if (!withRole("draw_approver").some((u) => !u.roles.includes("draw_officer"))) fail("STAFF_APPROVER", "no active draw approver who is not also a draw officer"); if (!withRole("reviewer").length) fail("STAFF_REVIEWER", "no active reviewer"); if (!withRole("fulfilment").length) fail("STAFF_FULFILMENT", "no active fulfilment user");
  if (users.some((u) => u.status === "active" && u.mustChangePassword)) fail("STAFF_TEMP_PASSWORDS", "staff still hold temporary passwords");
  if (users.some((u) => u.status === "active" && u.roles.some((r) => ["draw_officer", "draw_approver", "platform_admin", "fulfilment"].includes(r)) && !u.mfaEnabled)) fail("STAFF_MFA", "privileged staff without MFA");
  if (users.some((u) => u.status === "active" && SAMPLE.test(u.email))) fail("STAFF_SAMPLE", "sample staff accounts present");
  if (prod && d.cfg.outboundAllowlist.length) fail("RECIPIENT_ALLOWLIST", "OUTBOUND_ALLOWLIST is a test-only setting");
  if (!content.winnerTemplateName) fail("WINNER_TEMPLATE", "approved winner-contact template name not configured (required outside the 24-hour window)");
  for (const [k, msg] of [["evidence.receipt_benchmark_accepted", "client acceptance of the receipt benchmark not recorded"], ["evidence.restore_rehearsal", "backup restore rehearsal not recorded"], ["evidence.client_uat_signoff", "client UAT sign-off not recorded"], ["evidence.load_benchmark", "load benchmark not recorded"]]) if (!(await d.campaigns.setting(k, null))) fail(k.replace("evidence.", "EVIDENCE_").toUpperCase(), msg);
  if (!prod) fail("ENVIRONMENT", `environment is "${d.environment}" — production activation is only possible in a production environment`, true);
  const blocking = f.filter((x) => x.blocking);
  return { ok: blocking.length === 0, environment: d.environment, campaignId: d.campaignId, failures: f, blockingCount: blocking.length, checkedAt: new Date().toISOString() };
}
