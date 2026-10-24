CREATE TABLE "legacy_billing_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"sheet" text NOT NULL,
	"row_number" integer NOT NULL,
	"month" text NOT NULL,
	"customer_name" text NOT NULL,
	"document_raw" text NOT NULL,
	"document" text,
	"customer_id" uuid,
	"block" text NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"service" text,
	"observation" text,
	"gross_amount" numeric(18, 2),
	"plan_amount" numeric(18, 2),
	"excess_amount" numeric(18, 2),
	"net_amount" numeric(18, 2),
	"due_on" date,
	"paid_on" date,
	CONSTRAINT "legacy_rows_month_chk" CHECK ("legacy_billing_rows"."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "legacy_rows_block_chk" CHECK ("legacy_billing_rows"."block" in ('solutions', 'call') and "legacy_billing_rows"."amount" >= 0),
	CONSTRAINT "legacy_rows_amounts_chk" CHECK (coalesce("legacy_billing_rows"."gross_amount", 0) >= 0 and coalesce("legacy_billing_rows"."plan_amount", 0) >= 0 and coalesce("legacy_billing_rows"."excess_amount", 0) >= 0 and coalesce("legacy_billing_rows"."net_amount", 0) >= 0)
);
--> statement-breakpoint
CREATE TABLE "legacy_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"file_sha256" text NOT NULL,
	"file_label" text NOT NULL,
	"year" integer NOT NULL,
	"row_count" integer NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "legacy_imports_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "legacy_imports_sha_chk" CHECK ("legacy_imports"."file_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "legacy_imports_year_chk" CHECK ("legacy_imports"."year" between 2000 and 2100)
);
--> statement-breakpoint
ALTER TABLE "legacy_billing_rows" ADD CONSTRAINT "legacy_billing_rows_company_id_import_id_legacy_imports_company_id_id_fk" FOREIGN KEY ("company_id","import_id") REFERENCES "public"."legacy_imports"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_billing_rows" ADD CONSTRAINT "legacy_billing_rows_company_id_customer_id_customers_company_id_id_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."customers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_imports" ADD CONSTRAINT "legacy_imports_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_imports" ADD CONSTRAINT "legacy_imports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_rows_pos_uq" ON "legacy_billing_rows" USING btree ("import_id","sheet","row_number");--> statement-breakpoint
CREATE INDEX "legacy_rows_company_month_idx" ON "legacy_billing_rows" USING btree ("company_id","month");--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_imports_file_uq" ON "legacy_imports" USING btree ("company_id","file_sha256");--> statement-breakpoint
CREATE FUNCTION legacy_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('k3g.allow_legacy_delete', true) = 'on' THEN RETURN OLD; END IF; -- só o fluxo "Desfazer importação" (aplicação, com auditoria) liga isto
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'o histórico importado só pode ser apagado pelo fluxo "Desfazer importação" (auditado)' USING ERRCODE = '23514'; END IF;
  RAISE EXCEPTION 'o histórico importado é imutável: para corrigir, desfaça a importação e importe de novo' USING ERRCODE = '23514';
END $$;--> statement-breakpoint
CREATE TRIGGER legacy_billing_rows_immutable_trg BEFORE UPDATE OR DELETE ON legacy_billing_rows FOR EACH ROW EXECUTE FUNCTION legacy_immutable_guard();--> statement-breakpoint
CREATE TRIGGER legacy_imports_immutable_trg BEFORE UPDATE OR DELETE ON legacy_imports FOR EACH ROW EXECUTE FUNCTION legacy_immutable_guard();
