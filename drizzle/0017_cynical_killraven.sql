CREATE TABLE "issuance_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"charge_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"mode" text DEFAULT 'simulado' NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pendente' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"external_ref" text,
	"external_status" text,
	"last_error" text,
	"requested_by" uuid NOT NULL,
	CONSTRAINT "issuance_requests_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "issuance_requests_mode_chk" CHECK ("issuance_requests"."mode" = 'simulado'),
	CONSTRAINT "issuance_requests_kind_chk" CHECK ("issuance_requests"."kind" in ('boleto', 'nfse')),
	CONSTRAINT "issuance_requests_status_chk" CHECK ("issuance_requests"."status" in ('pendente', 'enviando', 'processando', 'emitido', 'desconhecido', 'falhou', 'cancelado')),
	CONSTRAINT "issuance_requests_attempts_chk" CHECK ("issuance_requests"."attempts" between 0 and 20),
	CONSTRAINT "issuance_requests_done_chk" CHECK ("issuance_requests"."status" not in ('emitido', 'processando') or "issuance_requests"."external_ref" is not null)
);
--> statement-breakpoint
CREATE TABLE "issuance_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"paused" boolean DEFAULT true NOT NULL,
	"daily_limit" integer DEFAULT 20 NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "issuance_settings_company_uq" UNIQUE("company_id"),
	CONSTRAINT "issuance_settings_limit_chk" CHECK ("issuance_settings"."daily_limit" between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "issuance_requests" ADD CONSTRAINT "issuance_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issuance_requests" ADD CONSTRAINT "issuance_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issuance_requests" ADD CONSTRAINT "issuance_requests_company_id_charge_id_charges_company_id_id_fk" FOREIGN KEY ("company_id","charge_id") REFERENCES "public"."charges"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issuance_settings" ADD CONSTRAINT "issuance_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issuance_settings" ADD CONSTRAINT "issuance_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issuance_requests_one_uq" ON "issuance_requests" USING btree ("company_id","charge_id","kind") WHERE "issuance_requests"."status" <> 'cancelado';--> statement-breakpoint
CREATE UNIQUE INDEX "issuance_requests_idem_uq" ON "issuance_requests" USING btree ("company_id","idempotency_key") WHERE "issuance_requests"."status" <> 'cancelado';--> statement-breakpoint
CREATE INDEX "issuance_requests_due_idx" ON "issuance_requests" USING btree ("company_id","status","next_attempt_at");