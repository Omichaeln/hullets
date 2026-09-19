CREATE TABLE "auth_attempts" (
	"key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_failure_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fiscal_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"submission_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"status" text NOT NULL,
	"adapter" text NOT NULL,
	"contract_version" text NOT NULL,
	"error_code" text,
	"latency_ms" integer,
	"qr_payload_sha256" text,
	"qr_format" text,
	"qr_host" text,
	"device_id" text,
	"fiscal_day_no" integer,
	"receipt_global_no" text,
	"verification_code" text,
	"invoice_no" text,
	"merchant_tin" text,
	"merchant_name" text,
	"branch_name" text,
	"branch_code" text,
	"txn_at" timestamp with time zone,
	"txn_date" text,
	"currency" text,
	"total_minor" integer,
	"tax_minor" integer,
	"lines" jsonb,
	"raw" jsonb,
	"fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mfa_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_outcomes" (
	"id" text PRIMARY KEY NOT NULL,
	"submission_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"automated_tier" text NOT NULL,
	"automated_disposition" text NOT NULL,
	"automated_reason" text,
	"authority" text NOT NULL,
	"fiscal_status" text,
	"duplicate_risk" text,
	"anomaly_risk" text,
	"discrepancies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"human_decision" text,
	"human_reason" text,
	"human_note" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"agreement" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "ix_media_dhash";--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "verification_tier" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "authority" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "fiscal_status" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "pending_fields" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "user_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "fiscal_verifications" ADD CONSTRAINT "fiscal_verifications_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_challenges" ADD CONSTRAINT "mfa_challenges_user_id_staff_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_outcomes" ADD CONSTRAINT "verification_outcomes_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_auth_attempts_window" ON "auth_attempts" USING btree ("window_started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_fiscal_submission" ON "fiscal_verifications" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "ix_fiscal_code" ON "fiscal_verifications" USING btree ("campaign_id","verification_code");--> statement-breakpoint
CREATE INDEX "ix_fiscal_receipt" ON "fiscal_verifications" USING btree ("campaign_id","device_id","receipt_global_no");--> statement-breakpoint
CREATE INDEX "ix_fiscal_qr" ON "fiscal_verifications" USING btree ("campaign_id","qr_payload_sha256");--> statement-breakpoint
CREATE INDEX "ix_mfa_challenge_user" ON "mfa_challenges" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_mfa_challenge_expiry" ON "mfa_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "ix_outcome_campaign" ON "verification_outcomes" USING btree ("campaign_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_outcome_agreement" ON "verification_outcomes" USING btree ("agreement");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_outcome_submission" ON "verification_outcomes" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "ix_media_expiry" ON "media_assets" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "ix_submission_outlet" ON "submissions" USING btree ("campaign_id","selected_outlet_id","created_at");