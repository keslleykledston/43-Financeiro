CREATE TABLE "billing_automation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"enabled_by" uuid,
	"enabled_at" timestamp with time zone,
	"lead_days" integer DEFAULT 2 NOT NULL,
	CONSTRAINT "billing_automation_company_uq" UNIQUE("company_id"),
	CONSTRAINT "billing_automation_on_chk" CHECK (not "billing_automation"."enabled" or ("billing_automation"."enabled_by" is not null and "billing_automation"."enabled_at" is not null)),
	CONSTRAINT "billing_automation_lead_chk" CHECK ("billing_automation"."lead_days" between 0 and 5)
);
--> statement-breakpoint
ALTER TABLE "billing_batches" ADD COLUMN "auto_issue" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_batches" ADD COLUMN "auto_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_batches" ADD COLUMN "auto_done_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_automation" ADD CONSTRAINT "billing_automation_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_automation" ADD CONSTRAINT "billing_automation_enabled_by_users_id_fk" FOREIGN KEY ("enabled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_batches" ADD CONSTRAINT "billing_batches_auto_chk" CHECK (("billing_batches"."auto_done_at" is null and "billing_batches"."auto_requested_at" is null) or ("billing_batches"."auto_issue" and "billing_batches"."status" = 'aprovado'));