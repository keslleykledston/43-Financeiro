CREATE TABLE "commission_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"charge_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"customer_name" text NOT NULL,
	"competence_month" date NOT NULL,
	"received_on" date NOT NULL,
	"base_amount" numeric(18, 2) NOT NULL,
	"bps" integer NOT NULL,
	"commission_amount" numeric(18, 2) NOT NULL,
	"voided_at" timestamp with time zone,
	CONSTRAINT "commission_lines_bps_chk" CHECK ("commission_lines"."bps" between 1 and 10000),
	CONSTRAINT "commission_lines_base_chk" CHECK ("commission_lines"."base_amount" > 0 and "commission_lines"."base_amount" <= 99999999999.99),
	CONSTRAINT "commission_lines_calc_chk" CHECK ("commission_lines"."commission_amount" = round("commission_lines"."base_amount" * "commission_lines"."bps" / 10000.0, 2)),
	CONSTRAINT "commission_lines_day_chk" CHECK (extract(day from "commission_lines"."competence_month") = 1)
);
--> statement-breakpoint
CREATE TABLE "commission_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"partner" text NOT NULL,
	"month" date NOT NULL,
	"status" text DEFAULT 'fechado' NOT NULL,
	"total_amount" numeric(18, 2) NOT NULL,
	"line_count" integer NOT NULL,
	"closed_by" uuid NOT NULL,
	"paid_on" date,
	"paid_by" uuid,
	"paid_note" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	CONSTRAINT "commission_statements_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "commission_statements_status_chk" CHECK ("commission_statements"."status" in ('fechado', 'pago', 'cancelado')),
	CONSTRAINT "commission_statements_month_chk" CHECK (extract(day from "commission_statements"."month") = 1),
	CONSTRAINT "commission_statements_partner_chk" CHECK (char_length("commission_statements"."partner") between 2 and 60),
	CONSTRAINT "commission_statements_total_chk" CHECK ("commission_statements"."total_amount" > 0 and "commission_statements"."total_amount" <= 99999999999.99 and "commission_statements"."line_count" > 0),
	CONSTRAINT "commission_statements_paid_chk" CHECK (("commission_statements"."status" = 'pago') = ("commission_statements"."paid_on" is not null and "commission_statements"."paid_by" is not null)),
	CONSTRAINT "commission_statements_cancel_chk" CHECK (("commission_statements"."status" = 'cancelado') = ("commission_statements"."cancelled_by" is not null and "commission_statements"."cancelled_at" is not null and "commission_statements"."cancel_reason" is not null)),
	CONSTRAINT "commission_statements_note_chk" CHECK ("commission_statements"."paid_note" is null or char_length("commission_statements"."paid_note") <= 200)
);
--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "commission_bps" integer;--> statement-breakpoint
ALTER TABLE "commission_lines" ADD CONSTRAINT "commission_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_lines" ADD CONSTRAINT "commission_lines_company_id_statement_id_commission_statements_company_id_id_fk" FOREIGN KEY ("company_id","statement_id") REFERENCES "public"."commission_statements"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_lines" ADD CONSTRAINT "commission_lines_company_id_charge_id_charges_company_id_id_fk" FOREIGN KEY ("company_id","charge_id") REFERENCES "public"."charges"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_lines" ADD CONSTRAINT "commission_lines_company_id_contract_id_contracts_company_id_id_fk" FOREIGN KEY ("company_id","contract_id") REFERENCES "public"."contracts"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_statements" ADD CONSTRAINT "commission_statements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_statements" ADD CONSTRAINT "commission_statements_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_statements" ADD CONSTRAINT "commission_statements_paid_by_users_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_statements" ADD CONSTRAINT "commission_statements_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commission_lines_charge_uq" ON "commission_lines" USING btree ("company_id","charge_id") WHERE "commission_lines"."voided_at" is null;--> statement-breakpoint
CREATE INDEX "commission_lines_statement_idx" ON "commission_lines" USING btree ("company_id","statement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_statements_one_uq" ON "commission_statements" USING btree ("company_id","partner","month") WHERE "commission_statements"."status" <> 'cancelado';--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_commission_bps_chk" CHECK ("contracts"."commission_bps" is null or ("contracts"."commission_bps" between 1 and 10000 and "contracts"."commission_partner" is not null));--> statement-breakpoint
CREATE OR REPLACE FUNCTION commission_statements_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'commission_statements: fechamento de comissão não pode ser apagado'; END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.partner <> OLD.partner OR NEW.month <> OLD.month OR NEW.total_amount <> OLD.total_amount
     OR NEW.line_count <> OLD.line_count OR NEW.closed_by <> OLD.closed_by THEN
    RAISE EXCEPTION 'commission_statements: dados do fechamento são imutáveis';
  END IF;
  IF OLD.status <> 'fechado' AND (NEW.status, NEW.paid_on, NEW.paid_by, NEW.paid_note, NEW.cancelled_by, NEW.cancelled_at, NEW.cancel_reason)
     IS DISTINCT FROM (OLD.status, OLD.paid_on, OLD.paid_by, OLD.paid_note, OLD.cancelled_by, OLD.cancelled_at, OLD.cancel_reason) THEN
    RAISE EXCEPTION 'commission_statements: fechamento % é definitivo', OLD.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER commission_statements_guard_trg BEFORE UPDATE OR DELETE ON commission_statements FOR EACH ROW EXECUTE FUNCTION commission_statements_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION commission_lines_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'commission_lines: linha de comissão não pode ser apagada'; END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.statement_id <> OLD.statement_id OR NEW.charge_id <> OLD.charge_id OR NEW.contract_id <> OLD.contract_id
     OR NEW.customer_id <> OLD.customer_id OR NEW.customer_name <> OLD.customer_name OR NEW.competence_month <> OLD.competence_month OR NEW.received_on <> OLD.received_on
     OR NEW.base_amount <> OLD.base_amount OR NEW.bps <> OLD.bps OR NEW.commission_amount <> OLD.commission_amount THEN
    RAISE EXCEPTION 'commission_lines: linha de comissão é imutável';
  END IF;
  IF OLD.voided_at IS NOT NULL AND NEW.voided_at IS DISTINCT FROM OLD.voided_at THEN
    RAISE EXCEPTION 'commission_lines: linha anulada não volta atrás';
  END IF;
  IF OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM commission_statements s WHERE s.company_id = NEW.company_id AND s.id = NEW.statement_id AND s.status = 'cancelado') THEN
    RAISE EXCEPTION 'commission_lines: só se anula linha de fechamento cancelado';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER commission_lines_guard_trg BEFORE UPDATE OR DELETE ON commission_lines FOR EACH ROW EXECUTE FUNCTION commission_lines_guard();
