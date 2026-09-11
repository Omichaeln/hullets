/**
 * Relational model (PostgreSQL 16, Drizzle). Every campaign-owned record
 * carries campaign_id; environment scope lives in schema_meta (one database
 * per environment, never shared). Integrity that matters is enforced here —
 * unique keys, partial unique indexes, foreign keys, checks — not only in code.
 */
import { pgTable, text, integer, bigint, boolean, timestamp, jsonb, uniqueIndex, index, primaryKey, bigserial, real, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });
const created = () => ts("created_at").notNull().defaultNow();

export const schemaMeta = pgTable("schema_meta", { key: text("key").primaryKey(), value: text("value").notNull() });

// ---------------------------------------------------------------- staff
export const staffUsers = pgTable("staff_users", {
  id: text("id").primaryKey(), email: text("email").notNull(), name: text("name").notNull(), passwordHash: text("password_hash").notNull(),
  roles: jsonb("roles").$type<string[]>().notNull().default([]), status: text("status").notNull().default("active"),
  mfaSecretEnc: text("mfa_secret_enc"), mfaEnabled: boolean("mfa_enabled").notNull().default(false), mustChangePassword: boolean("must_change_password").notNull().default(true),
  createdBy: text("created_by"), lastLoginAt: ts("last_login_at"), createdAt: created(), updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("uq_staff_email").on(t.email)]);

export const staffSessions = pgTable("staff_sessions", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => staffUsers.id), tokenHash: text("token_hash").notNull(),
  expiresAt: ts("expires_at").notNull(), revokedAt: ts("revoked_at"), ip: text("ip"), createdAt: created(),
}, (t) => [uniqueIndex("uq_session_token").on(t.tokenHash), index("ix_session_user").on(t.userId)]);

// ---------------------------------------------------------------- campaign
export const campaigns = pgTable("campaigns", {
  id: text("id").primaryKey(), code: text("code").notNull(), name: text("name").notNull(), status: text("status").notNull().default("draft"),
  timezone: text("timezone").notNull().default("Africa/Harare"), startsAt: ts("starts_at").notNull(), endsAt: ts("ends_at").notNull(),
  sample: boolean("sample").notNull().default(false), createdBy: text("created_by"), createdAt: created(), updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("uq_campaign_code").on(t.code), check("ck_campaign_window", sql`${t.endsAt} > ${t.startsAt}`)]);

export const campaignVersions = pgTable("campaign_versions", {
  id: text("id").primaryKey(), campaignId: text("campaign_id").notNull().references(() => campaigns.id), versionNo: integer("version_no").notNull(),
  status: text("status").notNull().default("draft"), rules: jsonb("rules").$type<Record<string, unknown>>().notNull(), content: jsonb("content").$type<Record<string, unknown>>().notNull(),
  flags: jsonb("flags").$type<Record<string, unknown>>().notNull(), prizePlan: jsonb("prize_plan").$type<Record<string, unknown>>().notNull(), configHash: text("config_hash").notNull(),
  activatedAt: ts("activated_at"), activatedBy: text("activated_by"), createdBy: text("created_by"), createdAt: created(),
}, (t) => [uniqueIndex("uq_version_no").on(t.campaignId, t.versionNo), uniqueIndex("uq_version_active").on(t.campaignId).where(sql`${t.status} = 'active'`)]);

export const campaignPeriods = pgTable("campaign_periods", {
  id: text("id").primaryKey(), campaignId: text("campaign_id").notNull().references(() => campaigns.id), code: text("code").notNull(), label: text("label").notNull(),
  startsAt: ts("starts_at").notNull(), endsAt: ts("ends_at").notNull(), drawAt: ts("draw_at"), status: text("status").notNull().default("scheduled"),
  prizePlan: jsonb("prize_plan").$type<Record<string, unknown> | null>(), createdAt: created(),
}, (t) => [uniqueIndex("uq_period_code").on(t.campaignId, t.code), check("ck_period_window", sql`${t.endsAt} > ${t.startsAt}`)]);

export const campaignDecisions = pgTable("campaign_decisions", {
  id: text("id").primaryKey(), campaignId: text("campaign_id").notNull().references(() => campaigns.id), decisionId: text("decision_id").notNull(), question: text("question").notNull(),
  testValue: text("test_value"), approvedValue: text("approved_value"), status: text("status").notNull().default("open"), owner: text("owner"), evidence: text("evidence"),
  blocksActivation: boolean("blocks_activation").notNull().default(true), approvedBy: text("approved_by"), approvedAt: ts("approved_at"), updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("uq_decision").on(t.campaignId, t.decisionId)]);

export const campaignControls = pgTable("campaign_controls", {
  campaignId: text("campaign_id").primaryKey().references(() => campaigns.id), pauseIntake: boolean("pause_intake").notNull().default(false), pauseAutoQualify: boolean("pause_auto_qualify").notNull().default(false),
  pauseOutbound: boolean("pause_outbound").notNull().default(false), pauseDraws: boolean("pause_draws").notNull().default(false), updatedBy: text("updated_by"), updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const outlets = pgTable("outlets", {
  id: text("id").primaryKey(), code: text("code").notNull(), retailer: text("retailer").notNull(), branch: text("branch").notNull(), town: text("town").notNull(), region: text("region").notNull().default(""),
  aliases: jsonb("aliases").$type<string[]>().notNull().default([]), collectionPoint: boolean("collection_point").notNull().default(false), active: boolean("active").notNull().default(true),
  sample: boolean("sample").notNull().default(false), createdAt: created(), updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("uq_outlet_code").on(t.code)]);

export const campaignOutlets = pgTable("campaign_outlets", {
  campaignId: text("campaign_id").notNull().references(() => campaigns.id), outletId: text("outlet_id").notNull().references(() => outlets.id),
  activeFrom: ts("active_from"), activeTo: ts("active_to"), collectionPoint: boolean("collection_point").notNull().default(false),
}, (t) => [primaryKey({ columns: [t.campaignId, t.outletId] })]);

export const products = pgTable("products", {
  id: text("id").primaryKey(), sku: text("sku").notNull(), brand: text("brand").notNull().default(""), name: text("name").notNull(), packGrams: integer("pack_grams").notNull(),
  aliases: jsonb("aliases").$type<string[]>().notNull().default([]), active: boolean("active").notNull().default(true), sample: boolean("sample").notNull().default(false), createdAt: created(),
}, (t) => [uniqueIndex("uq_product_sku").on(t.sku), check("ck_pack_grams", sql`${t.packGrams} > 0`)]);

// ---------------------------------------------------------------- participants
export const participants = pgTable("participants", {
  id: text("id").primaryKey(), channel: text("channel").notNull().default("whatsapp"), channelUid: text("channel_uid").notNull(), firstName: text("first_name").notNull(), surname: text("surname").notNull().default(""),
  location: text("location"), identityEnc: text("identity_enc"), identityMask: text("identity_mask"), identityFp: text("identity_fp"), identityVerifiedAt: ts("identity_verified_at"),
  status: text("status").notNull().default("active"), version: integer("version").notNull().default(1), createdAt: created(), updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("uq_participant_channel").on(t.channel, t.channelUid), index("ix_participant_fp").on(t.identityFp)]);

export const enrollments = pgTable("enrollments", {
  id: text("id").primaryKey(), participantId: text("participant_id").notNull().references(() => participants.id), campaignId: text("campaign_id").notNull().references(() => campaigns.id),
  campaignVersionId: text("campaign_version_id").notNull().references(() => campaignVersions.id), termsVersion: text("terms_version").notNull(), privacyVersion: text("privacy_version").notNull(),
  marketingConsent: boolean("marketing_consent").notNull().default(false), declarations: jsonb("declarations").$type<Record<string, unknown>>().notNull().default({}),
  acceptedAt: ts("accepted_at").notNull().defaultNow(), withdrawnAt: ts("withdrawn_at"),
}, (t) => [uniqueIndex("uq_enrollment").on(t.participantId, t.campaignId)]);

export const conversations = pgTable("conversations", {
  id: text("id").primaryKey(), campaignId: text("campaign_id").notNull().references(() => campaigns.id), channelUid: text("channel_uid").notNull(), participantId: text("participant_id"),
  state: text("state").notNull().default("HOME"), context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}), version: integer("version").notNull().default(1),
  activeSubmissionId: text("active_submission_id"), handoffOwner: text("handoff_owner"), handoffSince: ts("handoff_since"), updatedAt: ts("updated_at").notNull().defaultNow(), expiresAt: ts("expires_at"),
}, (t) => [uniqueIndex("uq_conversation").on(t.campaignId, t.channelUid), index("ix_conversation_handoff").on(t.handoffOwner)]);

// ---------------------------------------------------------------- intake + jobs
export const inboundEvents = pgTable("inbound_events", {
  id: text("id").primaryKey(), provider: text("provider").notNull(), providerAccount: text("provider_account").notNull().default("default"), providerMessageId: text("provider_message_id").notNull(),
  kind: text("kind").notNull(), channelUid: text("channel_uid"), payload: jsonb("payload").$type<Record<string, unknown>>().notNull(), status: text("status").notNull().default("received"),
  attempts: integer("attempts").notNull().default(0), leaseUntil: ts("lease_until"), result: jsonb("result").$type<Record<string, unknown> | null>(), error: text("error"),
  correlationId: text("correlation_id").notNull(), receivedAt: ts("received_at").notNull().defaultNow(), processedAt: ts("processed_at"),
}, (t) => [uniqueIndex("uq_inbound_event").on(t.provider, t.providerAccount, t.providerMessageId, t.kind), index("ix_inbound_queue").on(t.status, t.receivedAt), index("ix_inbound_uid").on(t.channelUid, t.receivedAt)]);

export const jobs = pgTable("jobs", {
  id: text("id").primaryKey(), kind: text("kind").notNull(), payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}), status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0), maxAttempts: integer("max_attempts").notNull().default(6), runAfter: ts("run_after").notNull().defaultNow(), leaseUntil: ts("lease_until"),
  lastError: text("last_error"), correlationId: text("correlation_id"), dedupeKey: text("dedupe_key"), createdAt: created(), finishedAt: ts("finished_at"),
}, (t) => [index("ix_jobs_queue").on(t.status, t.runAfter), uniqueIndex("uq_jobs_dedupe").on(t.dedupeKey).where(sql`${t.dedupeKey} is not null`)]);

// ---------------------------------------------------------------- media + submissions
export const mediaAssets = pgTable("media_assets", {
  id: text("id").primaryKey(), campaignId: text("campaign_id"), storageKey: text("storage_key").notNull(), normalizedKey: text("normalized_key"), mime: text("mime").notNull(), bytes: integer("bytes").notNull(),
  width: integer("width"), height: integer("height"), sha256: text("sha256").notNull(), ahash: text("ahash"), dhash: text("dhash"), quality: jsonb("quality").$type<Record<string, unknown> | null>(),
  status: text("status").notNull().default("stored"), createdAt: created(), expiresAt: ts("expires_at"),
}, (t) => [index("ix_media_sha").on(t.sha256), index("ix_media_dhash").on(t.dhash)]);

export const submissions = pgTable("submissions", {
  id: text("id").primaryKey(), reference: text("reference").notNull(), campaignId: text("campaign_id").notNull().references(() => campaigns.id), campaignVersionId: text("campaign_version_id").notNull().references(() => campaignVersions.id),
  participantId: text("participant_id").notNull().references(() => participants.id), conversationId: text("conversation_id"), inboundEventId: text("inbound_event_id"), providerMessageId: text("provider_message_id").notNull(),
  mediaAssetId: text("media_asset_id").references(() => mediaAssets.id), selectedOutletId: text("selected_outlet_id").references(() => outlets.id), periodCode: text("period_code"),
  status: text("status").notNull().default("received"), reasonCode: text("reason_code"), canonicalReceiptId: text("canonical_receipt_id"), reuploadOf: text("reupload_of"),
  version: integer("version").notNull().default(1), eventAt: ts("event_at"), intakeAt: ts("intake_at").notNull().defaultNow(), decidedAt: ts("decided_at"), decidedBy: text("decided_by"),
  correlationId: text("correlation_id"), createdAt: created(),
}, (t) => [uniqueIndex("uq_submission_message").on(t.providerMessageId), uniqueIndex("uq_submission_ref").on(t.reference), index("ix_submission_campaign").on(t.campaignId, t.status, t.createdAt), index("ix_submission_participant").on(t.participantId, t.createdAt), index("ix_submission_period").on(t.campaignId, t.periodCode, t.status)]);

export const extractions = pgTable("extractions", {
  id: text("id").primaryKey(), submissionId: text("submission_id").notNull().references(() => submissions.id), attemptNo: integer("attempt_no").notNull(), provider: text("provider").notNull(), model: text("model").notNull(),
  promptVersion: text("prompt_version"), schemaVersion: text("schema_version").notNull(), ocrText: text("ocr_text"), facts: jsonb("facts").$type<Record<string, unknown>>(), ruleResults: jsonb("rule_results").$type<unknown[]>(),
  disposition: text("disposition"), confidence: real("confidence"), latencyMs: integer("latency_ms"), raw: jsonb("raw").$type<Record<string, unknown> | null>(), error: text("error"), createdAt: created(),
}, (t) => [uniqueIndex("uq_extraction_attempt").on(t.submissionId, t.attemptNo)]);

export const submissionItems = pgTable("submission_items", {
  id: text("id").primaryKey(), submissionId: text("submission_id").notNull().references(() => submissions.id), lineNo: integer("line_no").notNull(), rawText: text("raw_text").notNull(), description: text("description").notNull(),
  quantity: integer("quantity"), packGrams: integer("pack_grams"), amountMinor: integer("amount_minor"), voided: boolean("voided").notNull().default(false), productCode: text("product_code"), evidence: jsonb("evidence").$type<Record<string, unknown> | null>(),
}, (t) => [index("ix_items_submission").on(t.submissionId)]);

export const canonicalReceipts = pgTable("canonical_receipts", {
  id: text("id").primaryKey(), campaignId: text("campaign_id").notNull().references(() => campaigns.id), receiptKey: text("receipt_key").notNull(), outletId: text("outlet_id"), txnDate: text("txn_date"), receiptNo: text("receipt_no"),
  totalMinor: integer("total_minor"), firstSubmissionId: text("first_submission_id").notNull(), creditedSubmissionId: text("credited_submission_id"), creditedEntryId: text("credited_entry_id"),
  status: text("status").notNull().default("pending"), createdAt: created(),
}, (t) => [uniqueIndex("uq_canonical_key").on(t.campaignId, t.receiptKey)]);

export const duplicateCandidates = pgTable("duplicate_candidates", {
  id: text("id").primaryKey(), submissionId: text("submission_id").notNull().references(() => submissions.id), candidateSubmissionId: text("candidate_submission_id").notNull().references(() => submissions.id), kind: text("kind").notNull(),
  score: real("score"), resolution: text("resolution").notNull().default("open"), resolvedBy: text("resolved_by"), resolvedAt: ts("resolved_at"), note: text("note"), createdAt: created(),
}, (t) => [uniqueIndex("uq_dup_candidate").on(t.submissionId, t.candidateSubmissionId, t.kind)]);

export const reviewTasks = pgTable("review_tasks", {
  id: text("id").primaryKey(), submissionId: text("submission_id").notNull().references(() => submissions.id), state: text("state").notNull().default("open"), reasonCode: text("reason_code"), assignee: text("assignee"), assignedAt: ts("assigned_at"),
  slaDueAt: ts("sla_due_at").notNull(), decision: text("decision"), decisionReason: text("decision_reason"), note: text("note"), decidedBy: text("decided_by"), decidedAt: ts("decided_at"), version: integer("version").notNull().default(1), createdAt: created(),
}, (t) => [uniqueIndex("uq_review_submission").on(t.submissionId), index("ix_review_open").on(t.state, t.createdAt)]);

// ---------------------------------------------------------------- ledger
export const entries = pgTable("entries", {
  id: text("id").primaryKey(), campaignId: text("campaign_id").notNull().references(() => campaigns.id), campaignVersionId: text("campaign_version_id").notNull(), participantId: text("participant_id").notNull().references(() => participants.id),
  submissionId: text("submission_id").notNull().references(() => submissions.id), canonicalReceiptId: text("canonical_receipt_id").notNull().references(() => canonicalReceipts.id), periodCode: text("period_code"),
  units: integer("units").notNull().default(1), status: text("status").notNull().default("active"), awardedAt: ts("awarded_at").notNull().defaultNow(), awardedBy: text("awarded_by").notNull(),
}, (t) => [uniqueIndex("uq_entry_submission").on(t.submissionId), uniqueIndex("uq_entry_canonical").on(t.canonicalReceiptId), index("ix_entry_period").on(t.campaignId, t.periodCode, t.status), index("ix_entry_participant").on(t.participantId), check("ck_entry_units", sql`${t.units} >= 1`)]);

export const entryEvents = pgTable("entry_events", {
  id: text("id").primaryKey(), entryId: text("entry_id").notNull().references(() => entries.id), type: text("type").notNull(), reason: text("reason").notNull(), actorId: text("actor_id").notNull(), approvedBy: text("approved_by"),
  effectiveAt: ts("effective_at").notNull().defaultNow(), note: text("note"), createdAt: created(),
}, (t) => [index("ix_entry_events").on(t.entryId)]);

// ---------------------------------------------------------------- draws
export const draws = pgTable("draws", {
  id: text("id").primaryKey(), campaignId: text("campaign_id").notNull().references(() => campaigns.id), periodId: text("period_id").notNull().references(() => campaignPeriods.id), sequenceNo: integer("sequence_no").notNull().default(1),
  status: text("status").notNull().default("frozen"), rulesVersionHash: text("rules_version_hash"), prizePlan: jsonb("prize_plan").$type<Record<string, unknown>>().notNull(), snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(), snapshotHash: text("snapshot_hash").notNull(),
  seedCommitment: text("seed_commitment").notNull(), seedHex: text("seed_hex").notNull(), algorithm: text("algorithm").notNull(), output: jsonb("output").$type<Record<string, unknown> | null>(), outputHash: text("output_hash"), barrier: jsonb("barrier").$type<Record<string, unknown>>().notNull(),
  executionAttempts: integer("execution_attempts").notNull().default(0), officerId: text("officer_id").notNull(), executedAt: ts("executed_at"), executedBy: text("executed_by"), approverId: text("approver_id"), approvedAt: ts("approved_at"), approvalNote: text("approval_note"),
  publishedAt: ts("published_at"), publishedBy: text("published_by"), voidedAt: ts("voided_at"), voidedBy: text("voided_by"), voidApprovedBy: text("void_approved_by"), voidReason: text("void_reason"), supersedesId: text("supersedes_id"), verifierVersion: text("verifier_version").notNull(), createdAt: created(),
}, (t) => [uniqueIndex("uq_draw_sequence").on(t.periodId, t.sequenceNo), uniqueIndex("uq_draw_live").on(t.periodId).where(sql`${t.status} <> 'voided'`)]);

export const drawCandidates = pgTable("draw_candidates", {
  drawId: text("draw_id").notNull().references(() => draws.id), position: integer("position").notNull(), entryId: text("entry_id").notNull(), participantId: text("participant_id").notNull(), units: integer("units").notNull().default(1), status: text("status").notNull().default("eligible"), exclusionReason: text("exclusion_reason"),
}, (t) => [primaryKey({ columns: [t.drawId, t.position] }), uniqueIndex("uq_draw_entry").on(t.drawId, t.entryId)]);

export const drawAttempts = pgTable("draw_attempts", { id: text("id").primaryKey(), drawId: text("draw_id").notNull().references(() => draws.id), actorId: text("actor_id").notNull(), outcome: text("outcome").notNull(), detail: text("detail"), createdAt: created() });

export const winners = pgTable("winners", {
  id: text("id").primaryKey(), drawId: text("draw_id").notNull().references(() => draws.id), campaignId: text("campaign_id").notNull(), kind: text("kind").notNull().default("winner"), position: integer("position").notNull(), entryId: text("entry_id").notNull(),
  participantId: text("participant_id").notNull(), prizeCode: text("prize_code").notNull(), prizeLabel: text("prize_label").notNull(), status: text("status").notNull().default("selected"), publication: text("publication").notNull().default("unpublished"),
  displayName: text("display_name"), claimTokenHash: text("claim_token_hash"), claimExpiresAt: ts("claim_expires_at"), contactAttempts: integer("contact_attempts").notNull().default(0), collectionOutletId: text("collection_outlet_id"),
  verifiedAt: ts("verified_at"), verifiedBy: text("verified_by"), acceptedAt: ts("accepted_at"), fulfilledAt: ts("fulfilled_at"), fulfilledBy: text("fulfilled_by"), fulfilmentRef: text("fulfilment_ref"), replacesId: text("replaces_id"), replacedById: text("replaced_by_id"),
  version: integer("version").notNull().default(1), createdAt: created(),
}, (t) => [uniqueIndex("uq_winner_slot").on(t.drawId, t.kind, t.position), uniqueIndex("uq_winner_entry").on(t.drawId, t.entryId), index("ix_winner_campaign").on(t.campaignId, t.status)]);

export const winnerEvents = pgTable("winner_events", { id: text("id").primaryKey(), winnerId: text("winner_id").notNull().references(() => winners.id), fromStatus: text("from_status"), toStatus: text("to_status").notNull(), actorId: text("actor_id").notNull(), reason: text("reason"), note: text("note"), detail: jsonb("detail").$type<Record<string, unknown> | null>(), createdAt: created() }, (t) => [index("ix_winner_events").on(t.winnerId)]);

// ---------------------------------------------------------------- outbound + CRM
export const outboundMessages = pgTable("outbound_messages", {
  id: text("id").primaryKey(), channelUid: text("channel_uid").notNull(), kind: text("kind").notNull().default("text"), purpose: text("purpose").notNull(), campaignId: text("campaign_id"), payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  idempotencyKey: text("idempotency_key").notNull(), status: text("status").notNull().default("pending"), attempts: integer("attempts").notNull().default(0), leaseUntil: ts("lease_until"), nextAttemptAt: ts("next_attempt_at"), providerMessageId: text("provider_message_id"),
  errorCode: text("error_code"), lastError: text("last_error"), correlationId: text("correlation_id"), createdAt: created(), sentAt: ts("sent_at"), deliveredAt: ts("delivered_at"), readAt: ts("read_at"),
}, (t) => [uniqueIndex("uq_outbound_idem").on(t.idempotencyKey), index("ix_outbound_queue").on(t.status, t.nextAttemptAt), index("ix_outbound_uid").on(t.channelUid, t.createdAt), index("ix_outbound_provider").on(t.providerMessageId)]);

export const crmEvents = pgTable("crm_events", {
  id: text("id").primaryKey(), provider: text("provider").notNull(), entityType: text("entity_type").notNull(), entityId: text("entity_id").notNull(), entityVersion: integer("entity_version").notNull(), eventType: text("event_type").notNull().default("upsert"),
  mappingVersion: text("mapping_version").notNull(), externalKey: text("external_key").notNull(), payload: jsonb("payload").$type<Record<string, unknown>>().notNull(), status: text("status").notNull().default("pending"), attempts: integer("attempts").notNull().default(0),
  leaseUntil: ts("lease_until"), nextAttemptAt: ts("next_attempt_at"), lastError: text("last_error"), externalId: text("external_id"), readback: jsonb("readback").$type<Record<string, unknown> | null>(), readbackAt: ts("readback_at"), correlationId: text("correlation_id"), createdAt: created(), deliveredAt: ts("delivered_at"),
}, (t) => [uniqueIndex("uq_crm_event").on(t.entityType, t.entityId, t.entityVersion, t.eventType), index("ix_crm_queue").on(t.status, t.nextAttemptAt)]);

export const crmRefs = pgTable("crm_refs", { entityType: text("entity_type").notNull(), entityId: text("entity_id").notNull(), provider: text("provider").notNull(), externalId: text("external_id").notNull(), lastVersion: integer("last_version").notNull(), updatedAt: ts("updated_at").notNull().defaultNow() }, (t) => [primaryKey({ columns: [t.entityType, t.entityId, t.provider] })]);

// ---------------------------------------------------------------- audit + ops
export const auditEvents = pgTable("audit_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(), actorType: text("actor_type").notNull(), actorId: text("actor_id").notNull(), action: text("action").notNull(), targetType: text("target_type").notNull(), targetId: text("target_id"),
  reason: text("reason"), payload: jsonb("payload").$type<Record<string, unknown> | null>(), body: text("body").notNull(), prevHash: text("prev_hash").notNull(), entryHash: text("entry_hash").notNull(), correlationId: text("correlation_id"), campaignId: text("campaign_id"), createdAt: created(),
}, (t) => [index("ix_audit_target").on(t.targetType, t.targetId), index("ix_audit_action").on(t.action), index("ix_audit_actor").on(t.actorId)]);

export const auditCheckpoints = pgTable("audit_checkpoints", { id: text("id").primaryKey(), uptoId: bigint("upto_id", { mode: "number" }).notNull(), headHash: text("head_hash").notNull(), signature: text("signature").notNull(), signed: boolean("signed").notNull(), createdBy: text("created_by").notNull(), createdAt: created() });

export const alerts = pgTable("alerts", { id: text("id").primaryKey(), kind: text("kind").notNull(), severity: text("severity").notNull().default("warning"), message: text("message").notNull(), detail: jsonb("detail").$type<Record<string, unknown> | null>(), runbook: text("runbook"), createdAt: created(), ackedBy: text("acked_by"), ackedAt: ts("acked_at") }, (t) => [index("ix_alert_open").on(t.ackedAt, t.createdAt)]);

export const metrics = pgTable("metrics", { id: bigserial("id", { mode: "number" }).primaryKey(), name: text("name").notNull(), value: real("value").notNull().default(1), labels: jsonb("labels").$type<Record<string, unknown> | null>(), at: ts("at").notNull().defaultNow() }, (t) => [index("ix_metrics_name").on(t.name, t.at)]);

/** Operational error log: one row per failure the platform handled (API internal errors, worker failures, webhook rejections). Messages are redacted before insert; never a stack, SQL or phone number. */
export const errorEvents = pgTable("error_events", {
  id: text("id").primaryKey(), source: text("source").notNull(), code: text("code").notNull(), message: text("message").notNull(), fingerprint: text("fingerprint").notNull(), path: text("path"),
  correlationId: text("correlation_id"), actorId: text("actor_id"), ref: jsonb("ref").$type<Record<string, string> | null>(), detail: jsonb("detail").$type<Record<string, unknown> | null>(),
  occurredAt: ts("occurred_at").notNull().defaultNow(), resolvedAt: ts("resolved_at"), resolvedBy: text("resolved_by"),
}, (t) => [index("ix_error_time").on(t.occurredAt), index("ix_error_fingerprint").on(t.fingerprint, t.occurredAt), index("ix_error_open").on(t.resolvedAt, t.occurredAt)]);

/** Health samples written once a minute by the worker's housekeeping: uptime and throughput history for the console. */
export const healthSamples = pgTable("health_samples", {
  id: bigserial("id", { mode: "number" }).primaryKey(), at: ts("at").notNull().defaultNow(), process: text("process").notNull(), ok: boolean("ok").notNull(), uptimeSec: integer("uptime_sec").notNull(),
  inbound: integer("inbound").notNull().default(0), processed: integer("processed").notNull().default(0), outbound: integer("outbound").notNull().default(0), errors: integer("errors").notNull().default(0),
  waitingEvents: integer("waiting_events").notNull().default(0), waitingJobs: integer("waiting_jobs").notNull().default(0), deadLetters: integer("dead_letters").notNull().default(0), outboundFailures: integer("outbound_failures").notNull().default(0), reviewOverdue: integer("review_overdue").notNull().default(0),
  tickLagMs: integer("tick_lag_ms").notNull().default(0), memoryMb: real("memory_mb").notNull().default(0), checks: jsonb("checks").$type<Record<string, unknown> | null>(),
}, (t) => [index("ix_health_at").on(t.at)]);

export const settings = pgTable("settings", { key: text("key").primaryKey(), value: jsonb("value").$type<unknown>().notNull(), updatedBy: text("updated_by"), updatedAt: ts("updated_at").notNull().defaultNow() });
