CREATE TABLE "cora_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"environment" text DEFAULT 'producao' NOT NULL,
	"cora_id" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"code" text,
	"due_date" date NOT NULL,
	"total_cents" integer NOT NULL,
	"paid_cents" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"paid_on" date,
	"digitable" text,
	"pdf_url" text,
	"charge_id" uuid,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cora_invoices_status_chk" CHECK ("cora_invoices"."status" in ('OPEN', 'LATE', 'IN_PAYMENT', 'DRAFT', 'PAID', 'CANCELLED')),
	CONSTRAINT "cora_invoices_env_chk" CHECK ("cora_invoices"."environment" in ('producao', 'homologacao')),
	CONSTRAINT "cora_invoices_amount_chk" CHECK ("cora_invoices"."total_cents" >= 0 and "cora_invoices"."paid_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "overdue_collection" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cora_invoices" ADD CONSTRAINT "cora_invoices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cora_invoices" ADD CONSTRAINT "cora_invoices_customer_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."customers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cora_invoices_ref_uq" ON "cora_invoices" USING btree ("company_id","environment","cora_id");--> statement-breakpoint
CREATE INDEX "cora_invoices_customer_idx" ON "cora_invoices" USING btree ("company_id","customer_id","status");--> statement-breakpoint
CREATE INDEX "cora_invoices_due_idx" ON "cora_invoices" USING btree ("company_id","status","due_date");