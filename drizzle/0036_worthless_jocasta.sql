CREATE TABLE "expense_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"row_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payable_id" uuid,
	"payment_id" uuid,
	"entry_id" uuid,
	"applied_by" uuid NOT NULL,
	CONSTRAINT "expense_applications_kind_chk" CHECK ("expense_applications"."kind" in ('conta_paga', 'conta_aberta', 'retirada')),
	CONSTRAINT "expense_applications_shape_chk" CHECK (case "expense_applications"."kind" when 'conta_paga' then "expense_applications"."payable_id" is not null and "expense_applications"."payment_id" is not null and "expense_applications"."entry_id" is null when 'conta_aberta' then "expense_applications"."payable_id" is not null and "expense_applications"."payment_id" is null and "expense_applications"."entry_id" is null else "expense_applications"."entry_id" is not null and "expense_applications"."payable_id" is null and "expense_applications"."payment_id" is null end)
);
--> statement-breakpoint
ALTER TABLE "expense_import_rows" ADD CONSTRAINT "expense_rows_company_id_uq" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "partner_entries" ADD CONSTRAINT "partner_entries_company_id_uq" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "expense_applications" ADD CONSTRAINT "expense_applications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_applications" ADD CONSTRAINT "expense_applications_applied_by_users_id_fk" FOREIGN KEY ("applied_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_applications" ADD CONSTRAINT "expense_applications_company_id_row_id_expense_import_rows_company_id_id_fk" FOREIGN KEY ("company_id","row_id") REFERENCES "public"."expense_import_rows"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_applications" ADD CONSTRAINT "expense_applications_company_id_payable_id_payables_company_id_id_fk" FOREIGN KEY ("company_id","payable_id") REFERENCES "public"."payables"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_applications" ADD CONSTRAINT "expense_applications_company_id_payment_id_payable_payments_company_id_id_fk" FOREIGN KEY ("company_id","payment_id") REFERENCES "public"."payable_payments"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_applications" ADD CONSTRAINT "expense_applications_company_id_entry_id_partner_entries_company_id_id_fk" FOREIGN KEY ("company_id","entry_id") REFERENCES "public"."partner_entries"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expense_applications_row_uq" ON "expense_applications" USING btree ("row_id");--> statement-breakpoint
-- D3b: o vínculo linha da planilha → conta/baixa/lançamento nunca muda nem some. Corrigir é cancelar/estornar pelos fluxos normais.
CREATE FUNCTION expense_applications_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'o vínculo da planilha de despesas com o sistema é imutável: corrija estornando ou cancelando pelos fluxos normais' USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER expense_applications_immutable_trg BEFORE UPDATE OR DELETE ON expense_applications FOR EACH ROW EXECUTE FUNCTION expense_applications_guard();
