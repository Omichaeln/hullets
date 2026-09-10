import { eq, and, gte, lt, sql, inArray, ne, desc } from "drizzle-orm";
import { schema, type Db } from "@promo/db";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
const { submissions, entries, enrollments, canonicalReceipts, reviewTasks, winners, draws, outlets, participants } = schema;
/** Counts with explicit definitions; submissions, receipts, entries, participants and winners are never interchangeable. */
export const DEFINITIONS = { registrations: "enrollments accepted in the campaign within the range", submissions: "receipt uploads (one per image message) received within the range", canonical_receipts: "distinct purchases identified (outlet|date|receipt number)", entries_active: "awards not disqualified", entries_excluded: "awards disqualified by an authorised event", unique_participants: "distinct participants with at least one submission", winners_selected: "winner rows from approved or published draws", winners_verified: "winners verified, accepted or collected", prizes_fulfilled: "winners recorded as collected" };
export class ReportService {
  constructor(private db: Db) {}
  async summary(campaignId: string, { since, until }: { since?: string | null; until?: string | null }) {
    const s = since ?? "1970-01-01T00:00:00Z", u = until ?? "9999-12-31T00:00:00Z";
    const count = async (q: Promise<Array<{ n: number }>>) => (await q)[0]?.n ?? 0;
    const inRange = (col: AnyPgColumn) => and(gte(col, s), lt(col, u));
    return {
      campaignId, range: { since: s, until: u }, definitions: DEFINITIONS,
      registrations: await count(this.db.select({ n: sql<number>`count(*)::int` }).from(enrollments).where(and(eq(enrollments.campaignId, campaignId), inRange(enrollments.acceptedAt)))),
      submissions: await count(this.db.select({ n: sql<number>`count(*)::int` }).from(submissions).where(and(eq(submissions.campaignId, campaignId), inRange(submissions.createdAt)))),
      submissions_by_status: await this.db.select({ k: submissions.status, n: sql<number>`count(*)::int` }).from(submissions).where(and(eq(submissions.campaignId, campaignId), inRange(submissions.createdAt))).groupBy(submissions.status),
      not_qualified_by_reason: await this.db.select({ k: submissions.reasonCode, n: sql<number>`count(*)::int` }).from(submissions).where(and(eq(submissions.campaignId, campaignId), inRange(submissions.createdAt), inArray(submissions.status, ["not_qualified", "reupload", "duplicate"]))).groupBy(submissions.reasonCode),
      canonical_receipts: await count(this.db.select({ n: sql<number>`count(*)::int` }).from(canonicalReceipts).where(and(eq(canonicalReceipts.campaignId, campaignId), inRange(canonicalReceipts.createdAt)))),
      entries_active: await count(this.db.select({ n: sql<number>`count(*)::int` }).from(entries).where(and(eq(entries.campaignId, campaignId), inRange(entries.awardedAt), eq(entries.status, "active")))),
      entries_excluded: await count(this.db.select({ n: sql<number>`count(*)::int` }).from(entries).where(and(eq(entries.campaignId, campaignId), inRange(entries.awardedAt), eq(entries.status, "excluded")))),
      unique_participants: await count(this.db.select({ n: sql<number>`count(distinct ${submissions.participantId})::int` }).from(submissions).where(and(eq(submissions.campaignId, campaignId), inRange(submissions.createdAt)))),
      entries_by_period: await this.db.select({ k: entries.periodCode, n: sql<number>`count(*)::int` }).from(entries).where(and(eq(entries.campaignId, campaignId), eq(entries.status, "active"), inRange(entries.awardedAt))).groupBy(entries.periodCode),
      entries_by_outlet: await this.db.select({ k: outlets.code, n: sql<number>`count(*)::int` }).from(entries).innerJoin(submissions, eq(submissions.id, entries.submissionId)).innerJoin(outlets, eq(outlets.id, submissions.selectedOutletId)).where(and(eq(entries.campaignId, campaignId), eq(entries.status, "active"), inRange(entries.awardedAt))).groupBy(outlets.code).orderBy(desc(sql`count(*)`)).limit(20),
      review_open: await count(this.db.select({ n: sql<number>`count(*)::int` }).from(reviewTasks).innerJoin(submissions, eq(submissions.id, reviewTasks.submissionId)).where(and(eq(submissions.campaignId, campaignId), ne(reviewTasks.state, "decided")))),
      winners_selected: await count(this.db.select({ n: sql<number>`count(*)::int` }).from(winners).innerJoin(draws, eq(draws.id, winners.drawId)).where(and(eq(draws.campaignId, campaignId), eq(winners.kind, "winner"), inArray(draws.status, ["approved", "published"])))),
      winners_verified: await count(this.db.select({ n: sql<number>`count(*)::int` }).from(winners).where(and(eq(winners.campaignId, campaignId), eq(winners.kind, "winner"), inArray(winners.status, ["verified", "accepted", "collected"])))),
      prizes_fulfilled: await count(this.db.select({ n: sql<number>`count(*)::int` }).from(winners).where(and(eq(winners.campaignId, campaignId), eq(winners.kind, "winner"), eq(winners.status, "collected")))),
      draws_by_status: await this.db.select({ k: draws.status, n: sql<number>`count(*)::int` }).from(draws).where(eq(draws.campaignId, campaignId)).groupBy(draws.status),
    };
  }
  /** Export rows for the auditor; identity and phone numbers never included. */
  async exportRows(scope: string, campaignId: string, cap = 50_000) {
    switch (scope) {
      case "submissions": return this.db.select({ id: submissions.id, reference: submissions.reference, participant_id: submissions.participantId, period: submissions.periodCode, outlet_id: submissions.selectedOutletId, status: submissions.status, reason: submissions.reasonCode, decided_by: submissions.decidedBy, decided_at: submissions.decidedAt, intake_at: submissions.intakeAt }).from(submissions).where(eq(submissions.campaignId, campaignId)).orderBy(desc(submissions.createdAt)).limit(cap);
      case "entries": return this.db.select({ id: entries.id, submission_id: entries.submissionId, participant_id: entries.participantId, period: entries.periodCode, status: entries.status, units: entries.units, canonical_receipt_id: entries.canonicalReceiptId, rules_version_id: entries.campaignVersionId, awarded_at: entries.awardedAt }).from(entries).where(eq(entries.campaignId, campaignId)).orderBy(desc(entries.awardedAt)).limit(cap);
      case "winners": return this.db.select({ id: winners.id, draw_id: winners.drawId, kind: winners.kind, position: winners.position, prize: winners.prizeLabel, status: winners.status, publication: winners.publication, display_name: winners.displayName, verified_at: winners.verifiedAt, fulfilled_at: winners.fulfilledAt, fulfilment_ref: winners.fulfilmentRef }).from(winners).where(eq(winners.campaignId, campaignId)).orderBy(winners.drawId, winners.position).limit(cap);
      case "participants": return this.db.select({ id: participants.id, first_name: participants.firstName, surname: participants.surname, town: participants.location, status: participants.status, identity_mask: participants.identityMask, registered_at: participants.createdAt }).from(participants).innerJoin(enrollments, eq(enrollments.participantId, participants.id)).where(eq(enrollments.campaignId, campaignId)).orderBy(desc(participants.createdAt)).limit(cap);
      case "outlets": return this.db.select({ code: outlets.code, retailer: outlets.retailer, branch: outlets.branch, town: outlets.town, region: outlets.region, collection_point: outlets.collectionPoint, active: outlets.active }).from(outlets).orderBy(outlets.retailer, outlets.town).limit(cap);
      default: throw new Error("unknown export scope");
    }
  }
}
