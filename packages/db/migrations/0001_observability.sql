CREATE TABLE "error_events" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"code" text NOT NULL,
	"message" text NOT NULL,
	"fingerprint" text NOT NULL,
	"path" text,
	"correlation_id" text,
	"actor_id" text,
	"ref" jsonb,
	"detail" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text
);
--> statement-breakpoint
CREATE TABLE "health_samples" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"process" text NOT NULL,
	"ok" boolean NOT NULL,
	"uptime_sec" integer NOT NULL,
	"inbound" integer DEFAULT 0 NOT NULL,
	"processed" integer DEFAULT 0 NOT NULL,
	"outbound" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"waiting_events" integer DEFAULT 0 NOT NULL,
	"waiting_jobs" integer DEFAULT 0 NOT NULL,
	"dead_letters" integer DEFAULT 0 NOT NULL,
	"outbound_failures" integer DEFAULT 0 NOT NULL,
	"review_overdue" integer DEFAULT 0 NOT NULL,
	"tick_lag_ms" integer DEFAULT 0 NOT NULL,
	"memory_mb" real DEFAULT 0 NOT NULL,
	"checks" jsonb
);
--> statement-breakpoint
CREATE INDEX "ix_error_time" ON "error_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "ix_error_fingerprint" ON "error_events" USING btree ("fingerprint","occurred_at");--> statement-breakpoint
CREATE INDEX "ix_error_open" ON "error_events" USING btree ("resolved_at","occurred_at");--> statement-breakpoint
CREATE INDEX "ix_health_at" ON "health_samples" USING btree ("at");