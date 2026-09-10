/**
 * TEST ONLY — SAMPLE PROMOTION. Everything here is fictional and editable in
 * the console; nothing counts as client sign-off. Idempotent per campaign
 * code. Dates are relative to SEED_CLOCK (default now) so a seed replays.
 */
import type { App } from "@promo/core";
import { DECISION_IDS } from "@promo/core";

export const SAMPLE_CODE = "SAMPLE-SWEETVALE-2026";
export const RETAILERS: Array<[string, string]> = [["Mopani Mart", "MOP"], ["Baobab Stores", "BAO"], ["Jacaranda Foods", "JAC"], ["Msasa Supermarket", "MSA"], ["Kopje Cash & Carry", "KOP"], ["Savanna Grocer", "SAV"], ["Riverbend Market", "RIV"], ["Highveld Foods", "HIG"]];
export const TOWNS: Array<[string, string, string]> = [["Harare", "HRE", "Harare"], ["Bulawayo", "BYO", "Bulawayo"], ["Mutare", "MUT", "Manicaland"], ["Gweru", "GWE", "Midlands"], ["Masvingo", "MSV", "Masvingo"], ["Kwekwe", "KWE", "Midlands"], ["Chinhoyi", "CHI", "Mashonaland West"], ["Marondera", "MAR", "Mashonaland East"], ["Bindura", "BIN", "Mashonaland Central"], ["Victoria Falls", "VFA", "Matabeleland North"]];
const BRANCHES = ["Westgate", "Eastlea", "Central", "Avondale", "Borrowdale", "Hillside", "Main Street", "Market Square", "Station Road", "Riverside"];
/** Exactly 80 fictional branches (8 retailers x 10 towns); the three Harare outlets used by the receipt fixtures are all called "Westgate" on purpose (ambiguity test). */
export function sampleOutlets() {
  const out: Array<{ code: string; retailer: string; branch: string; town: string; region: string; aliases: string[]; collectionPoint: boolean; sample: boolean }> = [];
  RETAILERS.forEach(([retailer, rc], ri) => TOWNS.forEach(([town, tc, region], ti) => { const branch = ti === 0 && ri < 3 ? "Westgate" : BRANCHES[(ri + ti) % BRANCHES.length]; out.push({ code: `${rc}-${tc}-${String(ti + 1).padStart(2, "0")}`, retailer, branch, town, region, aliases: [`${retailer.split(" ")[0]} ${branch}`], collectionPoint: (ri + ti) % 3 === 0, sample: true }); }));
  return out;
}
export const SAMPLE_PRODUCTS = [{ code: "SV-BS-2KG", name: "Sweetvale Brown Sugar 2kg", aliases: ["sweetvale brown sugar", "brown sugar 2kg", "sv brown sugar", "sweetvale brn sugar"], packGrams: 2000, qualifying: true }, { code: "SV-BS-1KG", name: "Sweetvale Brown Sugar 1kg", aliases: ["brown sugar 1kg", "sweetvale brn sugar 1kg"], packGrams: 1000, qualifying: true }];
export const DECISIONS: Record<string, [string, string]> = {
  "D-01": ["Final campaign name and sponsoring brand", "TEST ONLY — Sweetvale Brown Sugar Promotion (fictional brand)"],
  "D-02": ["Exact start/end, entry cutoff, draw and publication dates and timezone", "seed-clock relative weeks; Monday 00:00 Africa/Harare cutoffs (test assumption)"],
  "D-03": ["Eight-week duration, calendar year and November end", "4 sample weeks relative to the seed clock; no live dates inferred"],
  "D-04": ["Eligible country, regions, towns and outlet scope", "default country code 263; 10 fictional-town outlets"],
  "D-05": ["Qualifying brands, SKUs, receipt aliases and pack sizes", "SV-BS-2KG Sweetvale Brown Sugar 2kg + aliases (fictional)"],
  "D-06": ["Two 2 kg packs specifically vs other combinations totalling 4 kg", "strict 2 x 2000 g; allowMixedPacks=false (selectable)"],
  "D-07": ["One entry per receipt vs quantity-based multiples", "unitsPerReceipt=1"],
  "D-08": ["Participant, household, daily, weekly or campaign caps", "unlimited additional unique receipts (caps null)"],
  "D-09": ["Receipt dates, refunds, duplicate definition, photocopies and e-receipts", "purchase window Sep–Dec 2026 (fixture dates); DMY; voided lines excluded; receipt identity = outlet|date|number, total checked for conflicts"],
  "D-10": ["Age, staff/supplier, household and prior-winner restrictions", "18+ declaration only; priorWinnerExclusion=none"],
  "D-11": ["Identity number at registration or only from winners", "identityStage=registration (encrypted, masked, audited reveal)"],
  "D-12": ["Meaning of the location field", "town/city free text"],
  "D-13": ["Approved outlet master and prize collection locations", "80 fictional branches; collection points on roughly a third"],
  "D-14": ["Uncertain receipt handling, review target and pending-at-cutoff policy", "24 h review target (test); freeze blocked until on-time submissions are resolved (override needs a reason)"],
  "D-15": ["Participant count only or full submission status/history", "participantStatus=true (counts + last three references)"],
  "D-16": ["Winners and alternates per period, prizes, repeat-winner restrictions", "2 x P1 + 3 x P2 per week, 1 alternate per winner, one prize per participant per draw"],
  "D-17": ["Winner verification, deadlines, collection proof and replacement rules", "7-day claim window; verified -> accepted -> collected at a collection point; alternates promoted on expiry/decline"],
  "D-18": ["Permitted published winner fields and timing", "first name + initial, town, prize, week; after verification and explicit publication"],
  "D-19": ["CRM product, fields, access, sandbox and launch priority", "generic HTTP contract + local receiver; vendor not selected"],
  "D-20": ["Languages, support hours, escalation contacts, accessibility", "English only; SUPPORT keyword handoff; test owner ops@example.test"],
  "D-21": ["Registrations, entry volume, peaks and service targets", "engineering benchmark only: 5,000 registrations, 20,000 receipts, 200/h peak"],
  "D-22": ["Data retention, deletion, hosting and processor constraints", "media 90 d (config); PostgreSQL + filesystem media; processors: WhatsApp, hosting"],
};
export async function ensureSampleCampaign(app: App, { clock = process.env.SEED_CLOCK ?? null }: { clock?: string | null } = {}) {
  const existing = await app.campaigns.byCode(SAMPLE_CODE); if (existing) return { campaign: existing, seeded: false };
  const now = clock ? new Date(clock) : new Date(); const day = 86_400_000;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7)));
  const start = new Date(monday.getTime() - 14 * day), end = new Date(monday.getTime() + 14 * day);
  const { campaign, draftVersionId } = await app.campaigns.create({ code: SAMPLE_CODE, name: "TEST ONLY — Sweetvale Brown Sugar Promotion", startsAt: start.toISOString(), endsAt: end.toISOString(), timezone: "Africa/Harare", sample: true,
    rules: { products: SAMPLE_PRODUCTS, qualification: { mode: "packs", minPacks: 2, packGrams: 2000, minTotalGrams: 4000, allowMixedPacks: false }, dateOrder: "DMY", purchaseWindow: { start: "2026-09-01T00:00:00Z", end: "2027-01-01T00:00:00Z" } },
    content: { termsVersion: "TEST-T1", privacyVersion: "TEST-P1", termsUrl: "https://example.test/sample-terms (TEST ONLY placeholder)", prizesText: "TEST ONLY: weekly draw of 2 x USD 200 vouchers and 3 x USD 50 vouchers (sample allocation, not approved).", prizeArtworkUrl: "", prizeArtworkAlt: "", winnerTemplateName: "", messages: {} },
    flags: { participantStatus: true, identityStage: "registration", locationMode: "town" },
    prizePlan: { tiers: [{ code: "P1", label: "TEST prize: USD 200 voucher", count: 2 }, { code: "P2", label: "TEST prize: USD 50 voucher", count: 3 }], alternatesPerWinner: 1, onePrizePerParticipant: true, claimDays: 7 } }, "seed");
  await app.campaigns.activateVersion(campaign.id, draftVersionId, "seed");
  for (const [i, code] of ["W-2", "W-1", "W0", "W+1"].entries()) { const s = new Date(monday.getTime() + (i - 2) * 7 * day), e = new Date(s.getTime() + 7 * day); await app.campaigns.upsertPeriod(campaign.id, { code, label: `Week ${i + 1} (${s.toISOString().slice(0, 10)} to ${new Date(e.getTime() - day).toISOString().slice(0, 10)})`, startsAt: s.toISOString(), endsAt: e.toISOString(), drawAt: new Date(e.getTime() + day).toISOString(), status: i < 2 ? "closed" : i === 2 ? "open" : "scheduled" }, "seed"); }
  const ids: Array<{ outletId: string; collectionPoint: boolean }> = [];
  for (const o of sampleOutlets()) { const row = await app.campaigns.upsertOutlet(o, "seed"); ids.push({ outletId: row.id, collectionPoint: o.collectionPoint }); }
  await app.campaigns.setCampaignOutlets(campaign.id, ids, "seed");
  for (const p of SAMPLE_PRODUCTS) await app.campaigns.upsertProduct({ sku: p.code, brand: "Sweetvale (fictional)", name: p.name, packGrams: p.packGrams, aliases: p.aliases, sample: true }, "seed");
  await app.campaigns.upsertProduct({ sku: "SV-WS-2KG", brand: "Sweetvale (fictional)", name: "Sweetvale White Sugar 2kg", packGrams: 2000, aliases: ["white sugar"], sample: true }, "seed");
  for (const id of DECISION_IDS) await app.campaigns.upsertDecision(campaign.id, { decisionId: id, question: DECISIONS[id][0], testValue: DECISIONS[id][1], status: "open", owner: "client", blocksActivation: true }, "seed");
  await app.campaigns.setStatus(campaign.id, "active", "seed", "TEST ONLY sample activation (non-production)");
  await app.campaigns.setSetting("sample_data", { seededAt: new Date().toISOString(), seedClock: now.toISOString(), campaign: SAMPLE_CODE, note: "TEST ONLY sample data present" }, "seed");
  return { campaign: (await app.campaigns.get(campaign.id))!, seeded: true };
}
export const SAMPLE_STAFF: Array<[string, string, string[]]> = [["manager@example.test", "Sample Campaign Manager", ["campaign_manager"]], ["reviewer@example.test", "Sample Reviewer", ["reviewer"]], ["support@example.test", "Sample Support", ["support"]], ["draw@example.test", "Sample Draw Officer", ["draw_officer"]], ["approver@example.test", "Sample Draw Approver", ["draw_approver", "auditor"]], ["fulfilment@example.test", "Sample Fulfilment", ["fulfilment"]], ["auditor@example.test", "Sample Auditor", ["auditor"]]];
/** Sample staff with temporary passwords printed once (never stored in docs). Non-production only. */
export async function ensureSampleStaff(app: App) {
  const created: Array<{ email: string; roles: string[]; temporaryPassword: string | null }> = [];
  for (const [email, name, roles] of SAMPLE_STAFF) { if (await app.auth.byEmail(email)) continue; const r = await app.auth.createUser({ email, name, roles, createdBy: "seed" }); created.push({ email, roles, temporaryPassword: r.temporaryPassword }); }
  return created;
}
