CREATE TABLE "crm_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"desired_status" text NOT NULL,
	"state" text DEFAULT 'pendente' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	CONSTRAINT "crm_outbox_kind_chk" CHECK ("crm_outbox"."kind" in ('status', 'create')),
	CONSTRAINT "crm_outbox_state_chk" CHECK ("crm_outbox"."state" in ('pendente', 'enviado', 'falhou')),
	CONSTRAINT "crm_outbox_status_chk" CHECK ("crm_outbox"."desired_status" in ('ativo', 'suspenso', 'cancelado')),
	CONSTRAINT "crm_outbox_attempts_chk" CHECK ("crm_outbox"."attempts" >= 0 and ("crm_outbox"."last_error" is null or char_length("crm_outbox"."last_error") <= 300))
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "crm_cutover_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "crm_cutover_by" uuid;--> statement-breakpoint
ALTER TABLE "crm_outbox" ADD CONSTRAINT "crm_outbox_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_outbox" ADD CONSTRAINT "crm_outbox_customer_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."customers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "crm_outbox_open_uq" ON "crm_outbox" USING btree ("company_id","customer_id","kind") WHERE "crm_outbox"."state" = 'pendente';--> statement-breakpoint
CREATE INDEX "crm_outbox_due_idx" ON "crm_outbox" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "crm_outbox_customer_idx" ON "crm_outbox" USING btree ("company_id","customer_id","created_at");--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_crm_cutover_by_users_id_fk" FOREIGN KEY ("crm_cutover_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;