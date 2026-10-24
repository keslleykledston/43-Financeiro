CREATE TABLE "charge_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"competence_month" date NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "charge_adjustments_kind_chk" CHECK ("charge_adjustments"."kind" in ('excedente', 'acrescimo', 'desconto')),
	CONSTRAINT "charge_adjustments_amount_chk" CHECK ("charge_adjustments"."amount" > 0 and "charge_adjustments"."amount" <= 99999999999.99),
	CONSTRAINT "charge_adjustments_text_chk" CHECK (char_length("charge_adjustments"."description") between 2 and 120),
	CONSTRAINT "charge_adjustments_day_chk" CHECK (extract(day from "charge_adjustments"."competence_month") = 1)
);
--> statement-breakpoint
ALTER TABLE "charges" ADD COLUMN "base_amount" numeric(18, 2);--> statement-breakpoint
UPDATE "charges" SET "base_amount" = "amount";--> statement-breakpoint
ALTER TABLE "charges" ALTER COLUMN "base_amount" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "charges" ADD COLUMN "adjustment_amount" numeric(18, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "interest_amount" numeric(18, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "discount_amount" numeric(18, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "charge_adjustments" ADD CONSTRAINT "charge_adjustments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_adjustments" ADD CONSTRAINT "charge_adjustments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_adjustments" ADD CONSTRAINT "charge_adjustments_company_id_contract_id_contracts_company_id_id_fk" FOREIGN KEY ("company_id","contract_id") REFERENCES "public"."contracts"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "charge_adjustments_idx" ON "charge_adjustments" USING btree ("company_id","contract_id","competence_month");--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_composition_chk" CHECK ("charges"."amount" = "charges"."base_amount" + "charges"."adjustment_amount");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_extras_chk" CHECK ("payments"."interest_amount" >= 0 and "payments"."interest_amount" <= 99999999999.99 and "payments"."discount_amount" >= 0 and "payments"."discount_amount" < "payments"."amount" + "payments"."interest_amount");
--> statement-breakpoint
-- Ajustes da competência: sem edição; só entram/saem enquanto NÃO há cobrança aprovada da competência; no máximo 10 por contrato/competência.
CREATE FUNCTION charge_adjustments_guard() RETURNS trigger AS $$
DECLARE r charge_adjustments%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'adjustment_immutable'; END IF;
  r := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF EXISTS (SELECT 1 FROM charges WHERE company_id = r.company_id AND contract_id = r.contract_id AND competence_month = r.competence_month AND status = 'aprovada') THEN RAISE EXCEPTION 'adjustment_locked'; END IF;
  IF TG_OP = 'INSERT' AND (SELECT count(*) FROM charge_adjustments WHERE company_id = r.company_id AND contract_id = r.contract_id AND competence_month = r.competence_month) >= 10 THEN RAISE EXCEPTION 'adjustment_too_many'; END IF;
  RETURN r;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER charge_adjustments_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON charge_adjustments FOR EACH ROW EXECUTE FUNCTION charge_adjustments_guard();
--> statement-breakpoint
-- payments_guard (versão da migração 0016) + juros/multa e desconto imutáveis junto com o resto
CREATE OR REPLACE FUNCTION payments_guard() RETURNS trigger AS $$
DECLARE amt numeric; st text; tot numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'payment_undeletable'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'estornado' THEN RAISE EXCEPTION 'payment_immutable'; END IF;
    IF NEW.status <> 'estornado' OR NEW.company_id <> OLD.company_id OR NEW.charge_id <> OLD.charge_id OR NEW.amount <> OLD.amount
       OR NEW.interest_amount <> OLD.interest_amount OR NEW.discount_amount <> OLD.discount_amount
       OR NEW.paid_at <> OLD.paid_at OR NEW.method <> OLD.method OR NEW.registered_by <> OLD.registered_by
       OR NEW.note IS DISTINCT FROM OLD.note OR NEW.request_key IS DISTINCT FROM OLD.request_key THEN
      RAISE EXCEPTION 'payment_immutable';
    END IF;
    IF COALESCE(current_setting('k3g.bank_undo', true), '') <> 'on'
       AND EXISTS (SELECT 1 FROM bank_allocations WHERE company_id = OLD.company_id AND payment_id = OLD.id AND status = 'ativa') THEN
      RAISE EXCEPTION 'payment_bound_to_bank';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> 'ativo' THEN RAISE EXCEPTION 'payment_insert_not_active'; END IF;
  SELECT amount, status INTO amt, st FROM charges WHERE company_id = NEW.company_id AND id = NEW.charge_id FOR UPDATE;
  IF st IS DISTINCT FROM 'aprovada' THEN RAISE EXCEPTION 'payment_charge_not_approved'; END IF;
  SELECT COALESCE(SUM(amount), 0) INTO tot FROM payments WHERE company_id = NEW.company_id AND charge_id = NEW.charge_id AND status = 'ativo';
  IF tot + NEW.amount > amt THEN RAISE EXCEPTION 'payment_exceeds_open'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
-- bank_allocations_guard (versão da 0016): o vínculo consome do crédito o DINHEIRO recebido (principal + juros − desconto)
CREATE OR REPLACE FUNCTION bank_allocations_guard() RETURNS trigger AS $$
DECLARE tx_amt numeric; tx_st text; tot numeric; pay_ok boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'bank_alloc_undeletable'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'desfeita' THEN RAISE EXCEPTION 'bank_alloc_immutable'; END IF;
    IF NEW.status <> 'desfeita' OR NEW.company_id <> OLD.company_id OR NEW.transaction_id <> OLD.transaction_id OR NEW.charge_id <> OLD.charge_id
       OR NEW.payment_id <> OLD.payment_id OR NEW.amount <> OLD.amount OR NEW.created_by <> OLD.created_by OR NEW.request_key IS DISTINCT FROM OLD.request_key THEN
      RAISE EXCEPTION 'bank_alloc_immutable';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM payments WHERE company_id = OLD.company_id AND id = OLD.payment_id AND status = 'estornado') THEN RAISE EXCEPTION 'bank_alloc_payment_still_active'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> 'ativa' THEN RAISE EXCEPTION 'bank_alloc_insert_not_active'; END IF;
  SELECT amount, status INTO tx_amt, tx_st FROM bank_transactions WHERE company_id = NEW.company_id AND id = NEW.transaction_id FOR UPDATE;
  IF tx_st IS DISTINCT FROM 'ativa' OR tx_amt <= 0 THEN RAISE EXCEPTION 'bank_alloc_tx_not_credit'; END IF;
  IF EXISTS (SELECT 1 FROM bank_transaction_marks WHERE company_id = NEW.company_id AND transaction_id = NEW.transaction_id) THEN RAISE EXCEPTION 'bank_alloc_tx_marked'; END IF;
  SELECT COALESCE(SUM(amount), 0) INTO tot FROM bank_allocations WHERE company_id = NEW.company_id AND transaction_id = NEW.transaction_id AND status = 'ativa';
  IF tot + NEW.amount > tx_amt THEN RAISE EXCEPTION 'bank_alloc_exceeds_credit'; END IF;
  SELECT (charge_id = NEW.charge_id AND (amount + interest_amount - discount_amount) = NEW.amount AND status = 'ativo') INTO pay_ok FROM payments WHERE company_id = NEW.company_id AND id = NEW.payment_id;
  IF pay_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'bank_alloc_payment_mismatch'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
