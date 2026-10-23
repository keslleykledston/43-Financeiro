CREATE TABLE "billing_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_date" date NOT NULL,
	"status" text DEFAULT 'rascunho' NOT NULL,
	"generated_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"reopen_reason" text,
	CONSTRAINT "billing_batches_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "billing_batches_status_chk" CHECK ("billing_batches"."status" in ('rascunho', 'aprovado', 'cancelado')),
	CONSTRAINT "billing_batches_approval_chk" CHECK (("billing_batches"."status" = 'aprovado') = ("billing_batches"."approved_by" is not null and "billing_batches"."approved_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"competence_month" date NOT NULL,
	"due_date" date NOT NULL,
	"issue_date" date NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"joint_invoice" boolean DEFAULT false NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'previa' NOT NULL,
	CONSTRAINT "charges_status_chk" CHECK ("charges"."status" in ('previa', 'aprovada', 'cancelada')),
	CONSTRAINT "charges_amount_chk" CHECK ("charges"."amount" > 0 and "charges"."amount" <= 99999999999.99),
	CONSTRAINT "charges_competence_day_chk" CHECK (extract(day from "charges"."competence_month") = 1)
);
--> statement-breakpoint
ALTER TABLE "billing_batches" ADD CONSTRAINT "billing_batches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_batches" ADD CONSTRAINT "billing_batches_generated_by_users_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_batches" ADD CONSTRAINT "billing_batches_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_company_id_batch_id_billing_batches_company_id_id_fk" FOREIGN KEY ("company_id","batch_id") REFERENCES "public"."billing_batches"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_company_id_contract_id_contracts_company_id_id_fk" FOREIGN KEY ("company_id","contract_id") REFERENCES "public"."contracts"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_company_id_customer_id_customers_company_id_id_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."customers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_batches_one_per_date_uq" ON "billing_batches" USING btree ("company_id","issue_date") WHERE "billing_batches"."status" <> 'cancelado';--> statement-breakpoint
CREATE UNIQUE INDEX "charges_one_per_competence_uq" ON "charges" USING btree ("company_id","contract_id","competence_month") WHERE "charges"."status" <> 'cancelada';--> statement-breakpoint
CREATE INDEX "charges_batch_idx" ON "charges" USING btree ("company_id","batch_id");