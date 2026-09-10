/**
 * Populated TEST ONLY journeys: synthetic participants and real fixture images
 * pushed through the REAL pipeline (intake -> conversation -> OCR -> rules ->
 * ledger) so every console screen has data: qualified entries, duplicates,
 * rejections, pending review, a published historical draw (W-2) with winners
 * in several states. W-1 is left drawable for the UAT script. Idempotent.
 */
import fs from "node:fs";
import path from "node:path";
import { eq, and, notInArray, inArray, ne } from "drizzle-orm";
import { schema } from "@promo/db";
import type { App } from "@promo/core";
import { SAMPLE_CODE } from "./sample.ts";
const { submissions, entries, reviewTasks } = schema;
export const fixture = (id: string) => fs.readFileSync(path.resolve("fixtures/receipts", id.endsWith(".jpg") ? id : `${id}.jpg`));
const NAMES: Array<[string, string]> = [["Tendai", "Ncube"], ["Rudo", "Chari"], ["Blessing", "Moyo"], ["Farai", "Dube"], ["Chipo", "Sibanda"], ["Tapiwa", "Mutasa"], ["Nyasha", "Gumbo"], ["Kudzai", "Mhlanga"], ["Rutendo", "Chikwanda"], ["Tinashe", "Banda"], ["Vimbai", "Mapfumo"], ["Simba", "Zulu"]];
const OUTLET_QUERY: Record<string, string> = { A: "mopani westgate harare", B: "baobab westgate harare", C: "jacaranda westgate harare" };
export async function runSampleJourneys(app: App, log: (m: string) => void = console.log) {
  const camp = await app.campaigns.byCode(SAMPLE_CODE); if (!camp) throw new Error("sample campaign not seeded");
  const [{ n }] = await app.db.select({ n: schema.submissions.id }).from(submissions).where(eq(submissions.campaignId, camp.id)).limit(1).then((r) => [{ n: r.length }]);
  if (n) { log("[seed] journeys already present; nothing to do"); return { already: true }; }
  const phones = NAMES.map((_, i) => `2637700000${String(i + 1).padStart(2, "0")}`); let seq = 0;
  const say = async (phone: string, text: string, image: Buffer | null = null) => { await app.queue.receive({ provider: "simulator", providerMessageId: `seed_${++seq}`, kind: image ? "message.image" : "message.text", channelUid: phone, text, inlineMediaB64: image ? image.toString("base64") : null, timestamp: new Date().toISOString() }); await app.worker.drain(); };
  const register = async (i: number) => { const p = phones[i]; await say(p, "hi"); await say(p, "1"); await say(p, NAMES[i][0]); await say(p, NAMES[i][1]); await say(p, `TEST${1000 + i}X`); await say(p, ["Harare", "Bulawayo", "Mutare", "Gweru"][i % 4]); await say(p, "yes"); await say(p, "yes"); };
  const enter = async (i: number, fixtureId: string) => { const p = phones[i]; const k = fixtureId.match(/-([ABC])(?:-photo)?$/)?.[1] ?? "A"; await say(p, "2"); await say(p, OUTLET_QUERY[k]); await say(p, "1"); await say(p, "", fixture(fixtureId)); await app.worker.drain(); };
  log("[seed] registering 12 synthetic participants"); for (let i = 0; i < NAMES.length; i++) await register(i);
  const plan: Array<[number, string]> = [[0, "valid-two-pack-A"], [0, "valid-two-pack-B"], [1, "valid-two-pack-C"], [1, "dup-photo-A"], [2, "valid-three-pack-A"], [2, "one-pack-A"], [3, "wrong-sku-A"], [3, "random-photo"], [4, "missing-receipt-no-B"], [4, "valid-multi-line-B"], [5, "non-participating-outlet-A"], [5, "blurred-A"], [6, "date-before-window-A"], [7, "ambiguous-date-C"], [7, "unrelated-paper"]];
  log(`[seed] submitting ${plan.length} fixture receipts through the real pipeline (OCR)`); for (const [i, f] of plan) await enter(i, f);
  const periods = await app.campaigns.periods(camp.id); const hist = periods.filter((p) => ["W-2", "W-1"].includes(p.code));
  const backdate = async (rows: Array<{ id: string; submissionId: string }>, offset: number) => { for (const [k, e] of rows.entries()) { const per = hist[k % 2]; const at = new Date(Date.parse(per.startsAt) + 3_600_000 * (k + offset)).toISOString(); await app.db.update(entries).set({ periodCode: per.code, awardedAt: at }).where(eq(entries.id, e.id)); await app.db.update(submissions).set({ periodCode: per.code, intakeAt: at, createdAt: at }).where(eq(submissions.id, e.submissionId)); } };
  await backdate(await app.db.select({ id: entries.id, submissionId: entries.submissionId }).from(entries).where(and(eq(entries.campaignId, camp.id), eq(entries.status, "active"))).orderBy(entries.awardedAt), 1);
  const pool = fs.readdirSync(path.resolve("fixtures/receipts")).filter((f) => /^pool-\d+-[ABC]\.jpg$/.test(f)).sort().map((f) => f.replace(/\.jpg$/, ""));
  log(`[seed] submitting ${pool.length} draw-pool receipts (real OCR)`); for (const [k, f] of pool.entries()) await enter(2 + (k % 10), f);
  await backdate(await app.db.select({ id: entries.id, submissionId: entries.submissionId }).from(entries).where(and(eq(entries.campaignId, camp.id), eq(entries.status, "active"), notInArray(entries.periodCode, ["W-2", "W-1"]))).orderBy(entries.awardedAt), 10);
  log("[seed] cross-phone re-use of credited receipts (must be blocked)"); for (const [i, f] of [[8, "valid-two-pack-A"], [9, "valid-two-pack-B"], [10, "valid-two-pack-C"], [11, "dup-no-total-B"]] as Array<[number, string]>) await enter(i, f);
  // resolve on-time review items in the historical weeks so W-2's barrier passes
  const reviewer = await app.auth.byEmail("reviewer@example.test");
  const open = await app.db.select({ id: reviewTasks.submissionId }).from(reviewTasks).innerJoin(submissions, eq(submissions.id, reviewTasks.submissionId)).where(and(ne(reviewTasks.state, "decided"), inArray(submissions.periodCode, ["W-2", "W-1"])));
  for (const t of open) { try { await app.pipeline.review(t.id, { reviewerId: reviewer!.id, decision: "not_qualified", reasonCode: "reviewer_decision", note: "seed: resolved for the draw barrier" }); } catch { /* ignore */ } }
  await app.worker.drain();
  const officer = (await app.auth.byEmail("draw@example.test"))!, approver = (await app.auth.byEmail("approver@example.test"))!, ops = (await app.auth.byEmail("fulfilment@example.test"))!;
  const w2 = periods.find((p) => p.code === "W-2")!; const b = await app.draws.barrier(camp.id, w2.id);
  if (b.ok) {
    const d = await app.draws.freeze({ campaignId: camp.id, periodId: w2.id, actorId: officer.id }); const e = await app.draws.execute(d.id, officer.id); await app.draws.approve(d.id, approver.id, { expectedOutputHash: e.outputHash, note: "seed approval" });
    await app.draws.publish(d.id, ops.id); await app.winners.materialise(d.id, ops.id);
    const ws = (await app.winners.list({ drawId: d.id })).map((r) => r.w); const collect = (await app.campaigns.campaignOutlets(camp.id)).find((o) => o.membership.collectionPoint)!;
    if (ws[0]) { await app.winners.notify(ws[0].id, ops.id); await app.winners.transition(ws[0].id, { status: "verified", actorId: ops.id, evidence: "seed: ID checked" }); await app.winners.transition(ws[0].id, { status: "accepted", actorId: ops.id, collectionOutletId: collect.id }); await app.winners.transition(ws[0].id, { status: "collected", actorId: ops.id, fulfilmentRef: "SEED-SLIP-1" }); await app.winners.publish(ws[0].id, ops.id); }
    if (ws[1]) { await app.winners.notify(ws[1].id, ops.id); await app.winners.transition(ws[1].id, { status: "verified", actorId: ops.id, evidence: "seed: ID checked" }); await app.winners.publish(ws[1].id, ops.id); }
    if (ws[2]) { await app.winners.notify(ws[2].id, ops.id); await app.winners.transition(ws[2].id, { status: "replaced", actorId: ops.id, reason: "seed: no response" }); }
    if (ws[3]) await app.winners.notify(ws[3].id, ops.id);
    await app.worker.drain();
  } else log(`[seed] W-2 draw blocked: ${b.blockers.map((x) => x.code).join(", ")}`);
  const byStatus = await app.db.select({ status: submissions.status }).from(submissions).where(eq(submissions.campaignId, camp.id));
  const summary = { participants: NAMES.length, submissions: byStatus.length, byStatus: byStatus.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {} as Record<string, number>), entries: (await app.db.select({ id: entries.id }).from(entries).where(and(eq(entries.campaignId, camp.id), eq(entries.status, "active")))).length, draw: b.ok ? "W-2 published" : "W-2 blocked" };
  log(JSON.stringify(summary)); return summary;
}
