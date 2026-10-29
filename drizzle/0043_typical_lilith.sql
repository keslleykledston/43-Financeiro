CREATE TABLE "cora_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"event_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"event_id" text,
	"status" text DEFAULT 'pendente' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"outcome" text,
	"processed_at" timestamp with time zone,
	CONSTRAINT "cora_webhook_events_env_chk" CHECK ("cora_webhook_events"."environment" in ('homologacao', 'producao')),
	CONSTRAINT "cora_webhook_events_attempts_chk" CHECK ("cora_webhook_events"."attempts" between 0 and 20),
	CONSTRAINT "cora_webhook_events_status_chk" CHECK ("cora_webhook_events"."status" in ('pendente', 'processado', 'ignorado', 'erro')),
	CONSTRAINT "cora_webhook_events_shape_chk" CHECK ("cora_webhook_events"."event_type" ~ '^[a-z_]{2,20}[.][a-z_*]{2,20}$' and "cora_webhook_events"."resource_id" ~ '^inv_[A-Za-z0-9_-]{4,64}$' and ("cora_webhook_events"."event_id" is null or char_length("cora_webhook_events"."event_id") <= 100))
);
--> statement-breakpoint
CREATE TABLE "cora_webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"secret_hash" text NOT NULL,
	"endpoint_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "cora_webhooks_company_env_uq" UNIQUE("company_id","environment"),
	CONSTRAINT "cora_webhooks_env_chk" CHECK ("cora_webhooks"."environment" in ('homologacao', 'producao')),
	CONSTRAINT "cora_webhooks_hash_chk" CHECK ("cora_webhooks"."secret_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "issuance_requests" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issuance_settings" ADD COLUMN "auto_settle" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cora_webhook_events" ADD CONSTRAINT "cora_webhook_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cora_webhooks" ADD CONSTRAINT "cora_webhooks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cora_webhooks" ADD CONSTRAINT "cora_webhooks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cora_webhook_events_pending_idx" ON "cora_webhook_events" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cora_webhook_events_event_uq" ON "cora_webhook_events" USING btree ("company_id","event_id") WHERE "cora_webhook_events"."event_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "cora_webhook_events_pending_uq" ON "cora_webhook_events" USING btree ("company_id","resource_id","event_type") WHERE "cora_webhook_events"."status" = 'pendente';--> statement-breakpoint
CREATE UNIQUE INDEX "cora_webhooks_secret_uq" ON "cora_webhooks" USING btree ("secret_hash");