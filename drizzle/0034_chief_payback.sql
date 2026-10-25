CREATE TABLE "expense_import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"sheet" text NOT NULL,
	"row_number" integer NOT NULL,
	"month" text NOT NULL,
	"block" text NOT NULL,
	"description" text NOT NULL,
	"due_on" date,
	"amount" numeric(18, 2),
	"paid_amount" numeric(18, 2),
	"paid_on" date,
	"paid_raw" text,
	"installment_no" integer,
	"installments_total" integer,
	CONSTRAINT "expense_rows_month_chk" CHECK ("expense_import_rows"."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "expense_rows_block_chk" CHECK ("expense_import_rows"."block" in ('empresa', 'casa', 'cartao', 'dizimo')),
	CONSTRAINT "expense_rows_amounts_chk" CHECK (coalesce("expense_import_rows"."amount", 0) >= 0 and coalesce("expense_import_rows"."paid_amount", 0) >= 0),
	CONSTRAINT "expense_rows_text_chk" CHECK (char_length("expense_import_rows"."description") between 1 and 200 and ("expense_import_rows"."paid_raw" is null or char_length("expense_import_rows"."paid_raw") <= 40)),
	CONSTRAINT "expense_rows_inst_chk" CHECK (("expense_import_rows"."installment_no" is null) = ("expense_import_rows"."installments_total" is null) and ("expense_import_rows"."installment_no" is null or ("expense_import_rows"."installment_no" between 1 and "expense_import_rows"."installments_total" and "expense_import_rows"."installments_total" between 2 and 999)))
);
--> statement-breakpoint
CREATE TABLE "expense_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"file_sha256" text NOT NULL,
	"file_label" text NOT NULL,
	"year" integer NOT NULL,
	"row_count" integer NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "expense_imports_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "expense_imports_sha_chk" CHECK ("expense_imports"."file_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "expense_imports_year_chk" CHECK ("expense_imports"."year" between 2000 and 2100)
);
--> statement-breakpoint
ALTER TABLE "expense_import_rows" ADD CONSTRAINT "expense_import_rows_company_id_import_id_expense_imports_company_id_id_fk" FOREIGN KEY ("company_id","import_id") REFERENCES "public"."expense_imports"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_imports" ADD CONSTRAINT "expense_imports_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_imports" ADD CONSTRAINT "expense_imports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expense_rows_pos_uq" ON "expense_import_rows" USING btree ("import_id","sheet","row_number","block");--> statement-breakpoint
CREATE INDEX "expense_rows_company_month_idx" ON "expense_import_rows" USING btree ("company_id","month");--> statement-breakpoint
CREATE UNIQUE INDEX "expense_imports_file_uq" ON "expense_imports" USING btree ("company_id","file_sha256");
--> statement-breakpoint
-- Staging de despesas: imutável. Só o fluxo "Desfazer importação" (aplicação, auditado) liga k3g.allow_expense_import_delete e apaga a importação (e as linhas, em cascata).
CREATE FUNCTION expense_import_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('k3g.allow_expense_import_delete', true) = 'on' THEN RETURN OLD; END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'o histórico de despesas importado só pode ser apagado pelo fluxo "Desfazer importação" (auditado)' USING ERRCODE = '23514'; END IF;
  RAISE EXCEPTION 'o histórico de despesas importado é imutável: para corrigir, desfaça a importação e importe de novo' USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER expense_import_rows_immutable_trg BEFORE UPDATE OR DELETE ON expense_import_rows FOR EACH ROW EXECUTE FUNCTION expense_import_guard();
--> statement-breakpoint
CREATE TRIGGER expense_imports_immutable_trg BEFORE UPDATE OR DELETE ON expense_imports FOR EACH ROW EXECUTE FUNCTION expense_import_guard();
