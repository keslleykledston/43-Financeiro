CREATE TABLE "charge_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"charge_id" uuid NOT NULL,
	"number" text NOT NULL,
	"issued_on" date NOT NULL,
	"verification_code" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'ativa' NOT NULL,
	"pdf" "bytea" NOT NULL,
	"pdf_sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_by" uuid,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	CONSTRAINT "charge_invoices_status_chk" CHECK ("charge_invoices"."status" in ('ativa', 'substituida', 'removida')),
	CONSTRAINT "charge_invoices_source_chk" CHECK ("charge_invoices"."source" in ('manual', 'provider')),
	CONSTRAINT "charge_invoices_size_chk" CHECK ("charge_invoices"."size_bytes" between 100 and 2097152 and octet_length("charge_invoices"."pdf") = "charge_invoices"."size_bytes"),
	CONSTRAINT "charge_invoices_text_chk" CHECK ("charge_invoices"."number" ~ '^[0-9A-Za-z][0-9A-Za-z./-]{0,29}$' and ("charge_invoices"."verification_code" is null or "charge_invoices"."verification_code" ~ '^[0-9A-Za-z./_-]{1,80}$')),
	CONSTRAINT "charge_invoices_pdf_chk" CHECK (encode(substring("charge_invoices"."pdf" from 1 for 5), 'escape') = '%PDF-' and "charge_invoices"."pdf_sha256" = encode(sha256("charge_invoices"."pdf"), 'hex')),
	CONSTRAINT "charge_invoices_closed_chk" CHECK (("charge_invoices"."status" = 'ativa') = ("charge_invoices"."closed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "charge_invoices" ADD CONSTRAINT "charge_invoices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_invoices" ADD CONSTRAINT "charge_invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_invoices" ADD CONSTRAINT "charge_invoices_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_invoices" ADD CONSTRAINT "charge_invoices_company_id_charge_id_charges_company_id_id_fk" FOREIGN KEY ("company_id","charge_id") REFERENCES "public"."charges"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "charge_invoices_one_active_uq" ON "charge_invoices" USING btree ("charge_id") WHERE "charge_invoices"."status" = 'ativa';--> statement-breakpoint
CREATE INDEX "charge_invoices_charge_idx" ON "charge_invoices" USING btree ("company_id","charge_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION charge_invoices_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'o histórico de notas fiscais é permanente' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'ativa' THEN RAISE EXCEPTION 'a nota fiscal nasce ativa' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.charge_id IS DISTINCT FROM OLD.charge_id OR NEW.number IS DISTINCT FROM OLD.number OR NEW.issued_on IS DISTINCT FROM OLD.issued_on
     OR NEW.verification_code IS DISTINCT FROM OLD.verification_code OR NEW.source IS DISTINCT FROM OLD.source OR NEW.pdf IS DISTINCT FROM OLD.pdf OR NEW.pdf_sha256 IS DISTINCT FROM OLD.pdf_sha256
     OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a nota fiscal anexada não pode ser alterada: substitua ou remova' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'ativa' AND NEW.status IS DISTINCT FROM OLD.status THEN RAISE EXCEPTION 'nota fiscal encerrada não pode ser reaberta' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER charge_invoices_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON "charge_invoices" FOR EACH ROW EXECUTE FUNCTION charge_invoices_guard();
