CREATE TABLE "alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"severity" text DEFAULT 'warning' NOT NULL,
	"message" text NOT NULL,
	"detail" jsonb,
	"runbook" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acked_by" text,
	"acked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_checkpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"upto_id" bigint NOT NULL,
	"head_hash" text NOT NULL,
	"signature" text NOT NULL,
	"signed" boolean NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"reason" text,
	"payload" jsonb,
	"body" text NOT NULL,
	"prev_hash" text NOT NULL,
	"entry_hash" text NOT NULL,
	"correlation_id" text,
	"campaign_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_controls" (
	"campaign_id" text PRIMARY KEY NOT NULL,
	"pause_intake" boolean DEFAULT false NOT NULL,
	"pause_auto_qualify" boolean DEFAULT false NOT NULL,
	"pause_outbound" boolean DEFAULT false NOT NULL,
	"pause_draws" boolean DEFAULT false NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"decision_id" text NOT NULL,
	"question" text NOT NULL,
	"test_value" text,
	"approved_value" text,
	"status" text DEFAULT 'open' NOT NULL,
	"owner" text,
	"evidence" text,
	"blocks_activation" boolean DEFAULT true NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_outlets" (
	"campaign_id" text NOT NULL,
	"outlet_id" text NOT NULL,
	"active_from" timestamp with time zone,
	"active_to" timestamp with time zone,
	"collection_point" boolean DEFAULT false NOT NULL,
	CONSTRAINT "campaign_outlets_campaign_id_outlet_id_pk" PRIMARY KEY("campaign_id","outlet_id")
);
--> statement-breakpoint
CREATE TABLE "campaign_periods" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"draw_at" timestamp with time zone,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"prize_plan" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_period_window" CHECK ("campaign_periods"."ends_at" > "campaign_periods"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "campaign_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"version_no" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"rules" jsonb NOT NULL,
	"content" jsonb NOT NULL,
	"flags" jsonb NOT NULL,
	"prize_plan" jsonb NOT NULL,
	"config_hash" text NOT NULL,
	"activated_at" timestamp with time zone,
	"activated_by" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"timezone" text DEFAULT 'Africa/Harare' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"sample" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_campaign_window" CHECK ("campaigns"."ends_at" > "campaigns"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "canonical_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"receipt_key" text NOT NULL,
	"outlet_id" text,
	"txn_date" text,
	"receipt_no" text,
	"total_minor" integer,
	"first_submission_id" text NOT NULL,
	"credited_submission_id" text,
	"credited_entry_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"channel_uid" text NOT NULL,
	"participant_id" text,
	"state" text DEFAULT 'HOME' NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"active_submission_id" text,
	"handoff_owner" text,
	"handoff_since" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "crm_events" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"entity_version" integer NOT NULL,
	"event_type" text DEFAULT 'upsert' NOT NULL,
	"mapping_version" text NOT NULL,
	"external_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"external_id" text,
	"readback" jsonb,
	"readback_at" timestamp with time zone,
	"correlation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "crm_refs" (
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"last_version" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_refs_entity_type_entity_id_provider_pk" PRIMARY KEY("entity_type","entity_id","provider")
);
--> statement-breakpoint
CREATE TABLE "draw_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"draw_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"outcome" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "draw_candidates" (
	"draw_id" text NOT NULL,
	"position" integer NOT NULL,
	"entry_id" text NOT NULL,
	"participant_id" text NOT NULL,
	"units" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'eligible' NOT NULL,
	"exclusion_reason" text,
	CONSTRAINT "draw_candidates_draw_id_position_pk" PRIMARY KEY("draw_id","position")
);
--> statement-breakpoint
CREATE TABLE "draws" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"period_id" text NOT NULL,
	"sequence_no" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'frozen' NOT NULL,
	"rules_version_hash" text,
	"prize_plan" jsonb NOT NULL,
	"snapshot" jsonb NOT NULL,
	"snapshot_hash" text NOT NULL,
	"seed_commitment" text NOT NULL,
	"seed_hex" text NOT NULL,
	"algorithm" text NOT NULL,
	"output" jsonb,
	"output_hash" text,
	"barrier" jsonb NOT NULL,
	"execution_attempts" integer DEFAULT 0 NOT NULL,
	"officer_id" text NOT NULL,
	"executed_at" timestamp with time zone,
	"executed_by" text,
	"approver_id" text,
	"approved_at" timestamp with time zone,
	"approval_note" text,
	"published_at" timestamp with time zone,
	"published_by" text,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_approved_by" text,
	"void_reason" text,
	"supersedes_id" text,
	"verifier_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "duplicate_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"submission_id" text NOT NULL,
	"candidate_submission_id" text NOT NULL,
	"kind" text NOT NULL,
	"score" real,
	"resolution" text DEFAULT 'open' NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrollments" (
	"id" text PRIMARY KEY NOT NULL,
	"participant_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"campaign_version_id" text NOT NULL,
	"terms_version" text NOT NULL,
	"privacy_version" text NOT NULL,
	"marketing_consent" boolean DEFAULT false NOT NULL,
	"declarations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "entries" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"campaign_version_id" text NOT NULL,
	"participant_id" text NOT NULL,
	"submission_id" text NOT NULL,
	"canonical_receipt_id" text NOT NULL,
	"period_code" text,
	"units" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"awarded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"awarded_by" text NOT NULL,
	CONSTRAINT "ck_entry_units" CHECK ("entries"."units" >= 1)
);
--> statement-breakpoint
CREATE TABLE "entry_events" (
	"id" text PRIMARY KEY NOT NULL,
	"entry_id" text NOT NULL,
	"type" text NOT NULL,
	"reason" text NOT NULL,
	"actor_id" text NOT NULL,
	"approved_by" text,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extractions" (
	"id" text PRIMARY KEY NOT NULL,
	"submission_id" text NOT NULL,
	"attempt_no" integer NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text,
	"schema_version" text NOT NULL,
	"ocr_text" text,
	"facts" jsonb,
	"rule_results" jsonb,
	"disposition" text,
	"confidence" real,
	"latency_ms" integer,
	"raw" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_events" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_account" text DEFAULT 'default' NOT NULL,
	"provider_message_id" text NOT NULL,
	"kind" text NOT NULL,
	"channel_uid" text,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"result" jsonb,
	"error" text,
	"correlation_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 6 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"correlation_id" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text,
	"storage_key" text NOT NULL,
	"normalized_key" text,
	"mime" text NOT NULL,
	"bytes" integer NOT NULL,
	"width" integer,
	"height" integer,
	"sha256" text NOT NULL,
	"ahash" text,
	"dhash" text,
	"quality" jsonb,
	"status" text DEFAULT 'stored' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "metrics" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"value" real DEFAULT 1 NOT NULL,
	"labels" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_uid" text NOT NULL,
	"kind" text DEFAULT 'text' NOT NULL,
	"purpose" text NOT NULL,
	"campaign_id" text,
	"payload" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"provider_message_id" text,
	"error_code" text,
	"last_error" text,
	"correlation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "outlets" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"retailer" text NOT NULL,
	"branch" text NOT NULL,
	"town" text NOT NULL,
	"region" text DEFAULT '' NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"collection_point" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sample" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" text DEFAULT 'whatsapp' NOT NULL,
	"channel_uid" text NOT NULL,
	"first_name" text NOT NULL,
	"surname" text DEFAULT '' NOT NULL,
	"location" text,
	"identity_enc" text,
	"identity_mask" text,
	"identity_fp" text,
	"identity_verified_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" text PRIMARY KEY NOT NULL,
	"sku" text NOT NULL,
	"brand" text DEFAULT '' NOT NULL,
	"name" text NOT NULL,
	"pack_grams" integer NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sample" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_pack_grams" CHECK ("products"."pack_grams" > 0)
);
--> statement-breakpoint
CREATE TABLE "review_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"submission_id" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"reason_code" text,
	"assignee" text,
	"assigned_at" timestamp with time zone,
	"sla_due_at" timestamp with time zone NOT NULL,
	"decision" text,
	"decision_reason" text,
	"note" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schema_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"mfa_secret_enc" text,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"must_change_password" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submission_items" (
	"id" text PRIMARY KEY NOT NULL,
	"submission_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"raw_text" text NOT NULL,
	"description" text NOT NULL,
	"quantity" integer,
	"pack_grams" integer,
	"amount_minor" integer,
	"voided" boolean DEFAULT false NOT NULL,
	"product_code" text,
	"evidence" jsonb
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"reference" text NOT NULL,
	"campaign_id" text NOT NULL,
	"campaign_version_id" text NOT NULL,
	"participant_id" text NOT NULL,
	"conversation_id" text,
	"inbound_event_id" text,
	"provider_message_id" text NOT NULL,
	"media_asset_id" text,
	"selected_outlet_id" text,
	"period_code" text,
	"status" text DEFAULT 'received' NOT NULL,
	"reason_code" text,
	"canonical_receipt_id" text,
	"reupload_of" text,
	"version" integer DEFAULT 1 NOT NULL,
	"event_at" timestamp with time zone,
	"intake_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"correlation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "winner_events" (
	"id" text PRIMARY KEY NOT NULL,
	"winner_id" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_id" text NOT NULL,
	"reason" text,
	"note" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "winners" (
	"id" text PRIMARY KEY NOT NULL,
	"draw_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"kind" text DEFAULT 'winner' NOT NULL,
	"position" integer NOT NULL,
	"entry_id" text NOT NULL,
	"participant_id" text NOT NULL,
	"prize_code" text NOT NULL,
	"prize_label" text NOT NULL,
	"status" text DEFAULT 'selected' NOT NULL,
	"publication" text DEFAULT 'unpublished' NOT NULL,
	"display_name" text,
	"claim_token_hash" text,
	"claim_expires_at" timestamp with time zone,
	"contact_attempts" integer DEFAULT 0 NOT NULL,
	"collection_outlet_id" text,
	"verified_at" timestamp with time zone,
	"verified_by" text,
	"accepted_at" timestamp with time zone,
	"fulfilled_at" timestamp with time zone,
	"fulfilled_by" text,
	"fulfilment_ref" text,
	"replaces_id" text,
	"replaced_by_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_controls" ADD CONSTRAINT "campaign_controls_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_decisions" ADD CONSTRAINT "campaign_decisions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_outlets" ADD CONSTRAINT "campaign_outlets_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_outlets" ADD CONSTRAINT "campaign_outlets_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_periods" ADD CONSTRAINT "campaign_periods_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_versions" ADD CONSTRAINT "campaign_versions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_receipts" ADD CONSTRAINT "canonical_receipts_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draw_attempts" ADD CONSTRAINT "draw_attempts_draw_id_draws_id_fk" FOREIGN KEY ("draw_id") REFERENCES "public"."draws"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draw_candidates" ADD CONSTRAINT "draw_candidates_draw_id_draws_id_fk" FOREIGN KEY ("draw_id") REFERENCES "public"."draws"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draws" ADD CONSTRAINT "draws_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draws" ADD CONSTRAINT "draws_period_id_campaign_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."campaign_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_candidate_submission_id_submissions_id_fk" FOREIGN KEY ("candidate_submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_campaign_version_id_campaign_versions_id_fk" FOREIGN KEY ("campaign_version_id") REFERENCES "public"."campaign_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_canonical_receipt_id_canonical_receipts_id_fk" FOREIGN KEY ("canonical_receipt_id") REFERENCES "public"."canonical_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_events" ADD CONSTRAINT "entry_events_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_tasks" ADD CONSTRAINT "review_tasks_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_user_id_staff_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_items" ADD CONSTRAINT "submission_items_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_campaign_version_id_campaign_versions_id_fk" FOREIGN KEY ("campaign_version_id") REFERENCES "public"."campaign_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_media_asset_id_media_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_selected_outlet_id_outlets_id_fk" FOREIGN KEY ("selected_outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "winner_events" ADD CONSTRAINT "winner_events_winner_id_winners_id_fk" FOREIGN KEY ("winner_id") REFERENCES "public"."winners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "winners" ADD CONSTRAINT "winners_draw_id_draws_id_fk" FOREIGN KEY ("draw_id") REFERENCES "public"."draws"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_alert_open" ON "alerts" USING btree ("acked_at","created_at");--> statement-breakpoint
CREATE INDEX "ix_audit_target" ON "audit_events" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "ix_audit_action" ON "audit_events" USING btree ("action");--> statement-breakpoint
CREATE INDEX "ix_audit_actor" ON "audit_events" USING btree ("actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_decision" ON "campaign_decisions" USING btree ("campaign_id","decision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_period_code" ON "campaign_periods" USING btree ("campaign_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_version_no" ON "campaign_versions" USING btree ("campaign_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_version_active" ON "campaign_versions" USING btree ("campaign_id") WHERE "campaign_versions"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_campaign_code" ON "campaigns" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_canonical_key" ON "canonical_receipts" USING btree ("campaign_id","receipt_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_conversation" ON "conversations" USING btree ("campaign_id","channel_uid");--> statement-breakpoint
CREATE INDEX "ix_conversation_handoff" ON "conversations" USING btree ("handoff_owner");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_crm_event" ON "crm_events" USING btree ("entity_type","entity_id","entity_version","event_type");--> statement-breakpoint
CREATE INDEX "ix_crm_queue" ON "crm_events" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_draw_entry" ON "draw_candidates" USING btree ("draw_id","entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_draw_sequence" ON "draws" USING btree ("period_id","sequence_no");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_draw_live" ON "draws" USING btree ("period_id") WHERE "draws"."status" <> 'voided';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_dup_candidate" ON "duplicate_candidates" USING btree ("submission_id","candidate_submission_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_enrollment" ON "enrollments" USING btree ("participant_id","campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_entry_submission" ON "entries" USING btree ("submission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_entry_canonical" ON "entries" USING btree ("canonical_receipt_id");--> statement-breakpoint
CREATE INDEX "ix_entry_period" ON "entries" USING btree ("campaign_id","period_code","status");--> statement-breakpoint
CREATE INDEX "ix_entry_participant" ON "entries" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "ix_entry_events" ON "entry_events" USING btree ("entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_extraction_attempt" ON "extractions" USING btree ("submission_id","attempt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inbound_event" ON "inbound_events" USING btree ("provider","provider_account","provider_message_id","kind");--> statement-breakpoint
CREATE INDEX "ix_inbound_queue" ON "inbound_events" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "ix_inbound_uid" ON "inbound_events" USING btree ("channel_uid","received_at");--> statement-breakpoint
CREATE INDEX "ix_jobs_queue" ON "jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_jobs_dedupe" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "ix_media_sha" ON "media_assets" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "ix_media_dhash" ON "media_assets" USING btree ("dhash");--> statement-breakpoint
CREATE INDEX "ix_metrics_name" ON "metrics" USING btree ("name","at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_outbound_idem" ON "outbound_messages" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "ix_outbound_queue" ON "outbound_messages" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "ix_outbound_uid" ON "outbound_messages" USING btree ("channel_uid","created_at");--> statement-breakpoint
CREATE INDEX "ix_outbound_provider" ON "outbound_messages" USING btree ("provider_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_outlet_code" ON "outlets" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_participant_channel" ON "participants" USING btree ("channel","channel_uid");--> statement-breakpoint
CREATE INDEX "ix_participant_fp" ON "participants" USING btree ("identity_fp");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_product_sku" ON "products" USING btree ("sku");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_review_submission" ON "review_tasks" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "ix_review_open" ON "review_tasks" USING btree ("state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_session_token" ON "staff_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "ix_session_user" ON "staff_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_staff_email" ON "staff_users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "ix_items_submission" ON "submission_items" USING btree ("submission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_submission_message" ON "submissions" USING btree ("provider_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_submission_ref" ON "submissions" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "ix_submission_campaign" ON "submissions" USING btree ("campaign_id","status","created_at");--> statement-breakpoint
CREATE INDEX "ix_submission_participant" ON "submissions" USING btree ("participant_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_submission_period" ON "submissions" USING btree ("campaign_id","period_code","status");--> statement-breakpoint
CREATE INDEX "ix_winner_events" ON "winner_events" USING btree ("winner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_winner_slot" ON "winners" USING btree ("draw_id","kind","position");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_winner_entry" ON "winners" USING btree ("draw_id","entry_id");--> statement-breakpoint
CREATE INDEX "ix_winner_campaign" ON "winners" USING btree ("campaign_id","status");