// Delete ONLY the sample campaign's records. Refuses production and non-sample campaigns.
import { createApp } from "@promo/core";
import { schema } from "@promo/db";
import { eq, inArray, sql } from "drizzle-orm";
import { SAMPLE_CODE } from "./lib/sample.ts";
if (!process.argv.includes("--confirm")) { console.error("pass --confirm to reset the sample campaign"); process.exit(2); }
const app = await createApp();
if (app.environment === "production") { console.error("refusing: production environment"); process.exit(2); }
const c = await app.campaigns.byCode(SAMPLE_CODE); if (!c || !c.sample) { console.log("no sample campaign present"); await app.close(); process.exit(0); }
const S = schema; const cid = c.id;
await app.db.transaction(async (tx) => {
  const subIds = (await tx.select({ id: S.submissions.id }).from(S.submissions).where(eq(S.submissions.campaignId, cid))).map((r) => r.id);
  const drawIds = (await tx.select({ id: S.draws.id }).from(S.draws).where(eq(S.draws.campaignId, cid))).map((r) => r.id);
  if (drawIds.length) { const winIds = (await tx.select({ id: S.winners.id }).from(S.winners).where(inArray(S.winners.drawId, drawIds))).map((r) => r.id); if (winIds.length) await tx.delete(S.winnerEvents).where(inArray(S.winnerEvents.winnerId, winIds)); await tx.delete(S.winners).where(inArray(S.winners.drawId, drawIds)); await tx.delete(S.drawAttempts).where(inArray(S.drawAttempts.drawId, drawIds)); await tx.delete(S.drawCandidates).where(inArray(S.drawCandidates.drawId, drawIds)); await tx.delete(S.draws).where(eq(S.draws.campaignId, cid)); }
  const entIds = (await tx.select({ id: S.entries.id }).from(S.entries).where(eq(S.entries.campaignId, cid))).map((r) => r.id); if (entIds.length) await tx.delete(S.entryEvents).where(inArray(S.entryEvents.entryId, entIds)); await tx.delete(S.entries).where(eq(S.entries.campaignId, cid));
  if (subIds.length) { await tx.delete(S.duplicateCandidates).where(inArray(S.duplicateCandidates.submissionId, subIds)); await tx.delete(S.reviewTasks).where(inArray(S.reviewTasks.submissionId, subIds)); await tx.delete(S.submissionItems).where(inArray(S.submissionItems.submissionId, subIds)); await tx.delete(S.extractions).where(inArray(S.extractions.submissionId, subIds)); }
  await tx.delete(S.submissions).where(eq(S.submissions.campaignId, cid)); await tx.delete(S.canonicalReceipts).where(eq(S.canonicalReceipts.campaignId, cid)); await tx.delete(S.mediaAssets).where(eq(S.mediaAssets.campaignId, cid));
  await tx.delete(S.conversations).where(eq(S.conversations.campaignId, cid)); await tx.delete(S.enrollments).where(eq(S.enrollments.campaignId, cid));
  await tx.delete(S.participants).where(sql`${S.participants.channelUid} like '26377000%'`);
  await tx.delete(S.inboundEvents).where(eq(S.inboundEvents.provider, "simulator")); await tx.delete(S.outboundMessages).where(eq(S.outboundMessages.campaignId, cid)); await tx.delete(S.crmEvents).where(sql`true`); await tx.delete(S.crmRefs).where(sql`true`); await tx.delete(S.jobs).where(sql`true`);
  await tx.delete(S.campaignDecisions).where(eq(S.campaignDecisions.campaignId, cid)); await tx.delete(S.campaignOutlets).where(eq(S.campaignOutlets.campaignId, cid)); await tx.delete(S.campaignPeriods).where(eq(S.campaignPeriods.campaignId, cid)); await tx.delete(S.campaignControls).where(eq(S.campaignControls.campaignId, cid)); await tx.delete(S.campaignVersions).where(eq(S.campaignVersions.campaignId, cid)); await tx.delete(S.campaigns).where(eq(S.campaigns.id, cid));
  await tx.delete(S.settings).where(eq(S.settings.key, "sample_data"));
});
await app.audit.record(app.db, { actorType: "system", actorId: "reset-sample", action: "sample.reset", targetType: "campaign", targetId: cid });
console.log(`sample campaign ${SAMPLE_CODE} removed (audit chain retained)`); await app.close(); process.exit(0);
