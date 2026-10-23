CREATE TABLE "message_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"charge_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"scheduled_for" date NOT NULL,
	"status" text DEFAULT 'pendente' NOT NULL,
	"blocked_reason" text,
	"template_version_id" uuid,
	"rendered_subject" text,
	"rendered_body" text,
	"processed_at" timestamp with time zone,
	"processed_by" uuid,
	CONSTRAINT "message_queue_status_chk" CHECK ("message_queue"."status" in ('pendente', 'bloqueado', 'simulado', 'cancelado')),
	CONSTRAINT "message_queue_kind_chk" CHECK ("message_queue"."kind" in ('emissao', 'd_menos_3', 'd0', 'd_mais_3', 'd_mais_7', 'revisao_d15')),
	CONSTRAINT "message_queue_channel_chk" CHECK ("message_queue"."channel" in ('email', 'whatsapp', 'interno')),
	CONSTRAINT "message_queue_internal_chk" CHECK (("message_queue"."kind" = 'revisao_d15') = ("message_queue"."channel" = 'interno')),
	CONSTRAINT "message_queue_blocked_chk" CHECK (("message_queue"."status" = 'bloqueado') = ("message_queue"."blocked_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "message_template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"body" text NOT NULL,
	"state" text DEFAULT 'rascunho' NOT NULL,
	"created_by" uuid,
	"activated_by" uuid,
	"activated_at" timestamp with time zone,
	CONSTRAINT "message_template_versions_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "message_template_versions_ver_uq" UNIQUE("template_id","version"),
	CONSTRAINT "message_template_versions_state_chk" CHECK ("message_template_versions"."state" in ('rascunho', 'ativa', 'arquivada')),
	CONSTRAINT "message_template_versions_body_chk" CHECK (char_length("message_template_versions"."body") between 1 and 4000 and char_length("message_template_versions"."subject") <= 200)
);
--> statement-breakpoint
CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	CONSTRAINT "message_templates_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "message_templates_kind_chk" CHECK ("message_templates"."kind" in ('emissao', 'd_menos_3', 'd0', 'd_mais_3', 'd_mais_7')),
	CONSTRAINT "message_templates_channel_chk" CHECK ("message_templates"."channel" in ('email', 'whatsapp'))
);
--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_company_id_uq" UNIQUE("company_id","id");
--> statement-breakpoint
ALTER TABLE "message_queue" ADD CONSTRAINT "message_queue_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_queue" ADD CONSTRAINT "message_queue_processed_by_users_id_fk" FOREIGN KEY ("processed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_queue" ADD CONSTRAINT "message_queue_company_id_charge_id_charges_company_id_id_fk" FOREIGN KEY ("company_id","charge_id") REFERENCES "public"."charges"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_queue" ADD CONSTRAINT "message_queue_company_id_customer_id_customers_company_id_id_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."customers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_queue" ADD CONSTRAINT "message_queue_company_id_template_version_id_message_template_versions_company_id_id_fk" FOREIGN KEY ("company_id","template_version_id") REFERENCES "public"."message_template_versions"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_template_versions" ADD CONSTRAINT "message_template_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_template_versions" ADD CONSTRAINT "message_template_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_template_versions" ADD CONSTRAINT "message_template_versions_activated_by_users_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_template_versions" ADD CONSTRAINT "message_template_versions_company_id_template_id_message_templates_company_id_id_fk" FOREIGN KEY ("company_id","template_id") REFERENCES "public"."message_templates"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_queue_one_uq" ON "message_queue" USING btree ("company_id","charge_id","kind","channel") WHERE "message_queue"."status" <> 'cancelado';--> statement-breakpoint
CREATE INDEX "message_queue_due_idx" ON "message_queue" USING btree ("company_id","status","scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "message_template_versions_one_active_uq" ON "message_template_versions" USING btree ("template_id") WHERE "message_template_versions"."state" = 'ativa';--> statement-breakpoint
CREATE UNIQUE INDEX "message_templates_one_uq" ON "message_templates" USING btree ("company_id","kind","channel");