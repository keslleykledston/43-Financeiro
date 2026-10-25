CREATE TABLE "payable_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"description" text NOT NULL,
	"installments" integer NOT NULL,
	"first_due" date NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"category_id" uuid,
	"cost_center_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "payable_series_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "payable_series_amount_chk" CHECK ("payable_series"."amount" > 0 and "payable_series"."amount" <= 99999999999.99),
	CONSTRAINT "payable_series_count_chk" CHECK ("payable_series"."installments" between 2 and 120),
	CONSTRAINT "payable_series_text_chk" CHECK (char_length("payable_series"."description") between 2 and 160)
);
--> statement-breakpoint
CREATE TABLE "payable_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"due_day" integer NOT NULL,
	"category_id" uuid,
	"cost_center_id" uuid,
	"start_month" date NOT NULL,
	"end_month" date,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "payable_templates_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "payable_templates_amount_chk" CHECK ("payable_templates"."amount" > 0 and "payable_templates"."amount" <= 99999999999.99),
	CONSTRAINT "payable_templates_day_chk" CHECK ("payable_templates"."due_day" between 1 and 31),
	CONSTRAINT "payable_templates_text_chk" CHECK (char_length("payable_templates"."description") between 2 and 200),
	CONSTRAINT "payable_templates_months_chk" CHECK (extract(day from "payable_templates"."start_month") = 1 and ("payable_templates"."end_month" is null or (extract(day from "payable_templates"."end_month") = 1 and "payable_templates"."end_month" >= "payable_templates"."start_month")))
);
--> statement-breakpoint
ALTER TABLE "payables" ADD COLUMN "template_id" uuid;--> statement-breakpoint
ALTER TABLE "payables" ADD COLUMN "series_id" uuid;--> statement-breakpoint
ALTER TABLE "payables" ADD COLUMN "installment_no" integer;--> statement-breakpoint
ALTER TABLE "payable_series" ADD CONSTRAINT "payable_series_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payable_series" ADD CONSTRAINT "payable_series_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payable_series" ADD CONSTRAINT "payable_series_company_id_vendor_id_vendors_company_id_id_fk" FOREIGN KEY ("company_id","vendor_id") REFERENCES "public"."vendors"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payable_series" ADD CONSTRAINT "payable_series_company_id_category_id_expense_categories_company_id_id_fk" FOREIGN KEY ("company_id","category_id") REFERENCES "public"."expense_categories"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payable_series" ADD CONSTRAINT "payable_series_company_id_cost_center_id_cost_centers_company_id_id_fk" FOREIGN KEY ("company_id","cost_center_id") REFERENCES "public"."cost_centers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payable_templates" ADD CONSTRAINT "payable_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payable_templates" ADD CONSTRAINT "payable_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payable_templates" ADD CONSTRAINT "payable_templates_company_id_vendor_id_vendors_company_id_id_fk" FOREIGN KEY ("company_id","vendor_id") REFERENCES "public"."vendors"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payable_templates" ADD CONSTRAINT "payable_templates_company_id_category_id_expense_categories_company_id_id_fk" FOREIGN KEY ("company_id","category_id") REFERENCES "public"."expense_categories"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payable_templates" ADD CONSTRAINT "payable_templates_company_id_cost_center_id_cost_centers_company_id_id_fk" FOREIGN KEY ("company_id","cost_center_id") REFERENCES "public"."cost_centers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payables" ADD CONSTRAINT "payables_company_id_template_id_payable_templates_company_id_id_fk" FOREIGN KEY ("company_id","template_id") REFERENCES "public"."payable_templates"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payables" ADD CONSTRAINT "payables_company_id_series_id_payable_series_company_id_id_fk" FOREIGN KEY ("company_id","series_id") REFERENCES "public"."payable_series"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payables_template_month_uq" ON "payables" USING btree ("template_id","competence") WHERE "payables"."template_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payables_series_no_uq" ON "payables" USING btree ("series_id","installment_no") WHERE "payables"."series_id" is not null;--> statement-breakpoint
ALTER TABLE "payables" ADD CONSTRAINT "payables_origin_chk" CHECK (("payables"."template_id" is null or ("payables"."series_id" is null and "payables"."competence" is not null)) and (("payables"."series_id" is null) = ("payables"."installment_no" is null)));
--> statement-breakpoint
-- D2: a origem (modelo/série/nº da parcela) nunca muda depois de criada a conta.
CREATE OR REPLACE FUNCTION payables_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'payable_undeletable'; END IF;
  IF OLD.status IN ('rejeitado', 'cancelado') THEN RAISE EXCEPTION 'payable_immutable'; END IF;
  IF NEW.template_id IS DISTINCT FROM OLD.template_id OR NEW.series_id IS DISTINCT FROM OLD.series_id OR NEW.installment_no IS DISTINCT FROM OLD.installment_no
     OR (OLD.template_id IS NOT NULL AND NEW.competence IS DISTINCT FROM OLD.competence) THEN RAISE EXCEPTION 'payable_immutable'; END IF; -- a competência de conta gerada por modelo é a chave da não-duplicação
  IF OLD.status <> 'rascunho' AND (NEW.company_id <> OLD.company_id OR NEW.vendor_id <> OLD.vendor_id OR NEW.amount <> OLD.amount OR NEW.due_date <> OLD.due_date
     OR NEW.document_number IS DISTINCT FROM OLD.document_number OR NEW.description <> OLD.description OR NEW.category IS DISTINCT FROM OLD.category OR NEW.created_by <> OLD.created_by
     OR NEW.category_id IS DISTINCT FROM OLD.category_id OR NEW.cost_center_id IS DISTINCT FROM OLD.cost_center_id OR NEW.competence IS DISTINCT FROM OLD.competence) THEN
    RAISE EXCEPTION 'payable_immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'rascunho' AND NEW.status IN ('aguardando_aprovacao', 'cancelado'))
    OR (OLD.status = 'aguardando_aprovacao' AND NEW.status IN ('aprovado', 'rejeitado', 'cancelado'))
    OR (OLD.status = 'aprovado' AND NEW.status = 'cancelado')) THEN
    RAISE EXCEPTION 'payable_bad_transition';
  END IF;
  IF NEW.status = 'cancelado' AND EXISTS (SELECT 1 FROM payable_payments WHERE company_id = OLD.company_id AND payable_id = OLD.id) THEN RAISE EXCEPTION 'payable_has_payments'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
