CREATE TABLE "contract_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "contract_imports_company_id_uq" UNIQUE("company_id","id")
);
--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "import_id" uuid;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "commission_partner" text;--> statement-breakpoint
ALTER TABLE "contract_imports" ADD CONSTRAINT "contract_imports_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_imports" ADD CONSTRAINT "contract_imports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_company_id_import_id_contract_imports_company_id_id_fk" FOREIGN KEY ("company_id","import_id") REFERENCES "public"."contract_imports"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_commission_chk" CHECK ("contracts"."commission_partner" is null or char_length("contracts"."commission_partner") between 2 and 60);--> statement-breakpoint
CREATE OR REPLACE FUNCTION contract_imports_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'contract_imports: lote de importação não pode ser apagado'; END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.created_by <> OLD.created_by OR NEW.summary <> OLD.summary THEN
    RAISE EXCEPTION 'contract_imports: lote é imutável';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER contract_imports_guard_trg BEFORE UPDATE OR DELETE ON contract_imports FOR EACH ROW EXECUTE FUNCTION contract_imports_guard();
