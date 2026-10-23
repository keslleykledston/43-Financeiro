CREATE TABLE "payable_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"payable_id" uuid NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"paid_at" date NOT NULL,
	"method" text NOT NULL,
	"reference" text,
	"note" text,
	"request_key" text,
	"status" text DEFAULT 'ativo' NOT NULL,
	"registered_by" uuid NOT NULL,
	"reversed_by" uuid,
	"reversed_at" timestamp with time zone,
	"reverse_reason" text,
	CONSTRAINT "payable_payments_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "payable_payments_amount_chk" CHECK ("payable_payments"."amount" > 0 and "payable_payments"."amount" <= 99999999999.99),
	CONSTRAINT "payable_payments_method_chk" CHECK ("payable_payments"."method" in ('pix', 'boleto', 'ted', 'transferencia', 'outro')),
	CONSTRAINT "payable_payments_status_chk" CHECK ("payable_payments"."status" in ('ativo', 'estornado')),
	CONSTRAINT "payable_payments_reversal_chk" CHECK (("payable_payments"."status" = 'estornado' and "payable_payments"."reversed_by" is not null and "payable_payments"."reversed_at" is not null and "payable_payments"."reverse_reason" is not null) or ("payable_payments"."status" = 'ativo' and "payable_payments"."reversed_by" is null and "payable_payments"."reversed_at" is null and "payable_payments"."reverse_reason" is null)),
	CONSTRAINT "payable_payments_text_chk" CHECK (("payable_payments"."reference" is null or char_length("payable_payments"."reference") <= 60) and ("payable_payments"."note" is null or char_length("payable_payments"."note") <= 200))
);
--> statement-breakpoint
CREATE TABLE "payables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"description" text NOT NULL,
	"document_number" text,
	"amount" numeric(18, 2) NOT NULL,
	"due_date" date NOT NULL,
	"category" text,
	"status" text DEFAULT 'rascunho' NOT NULL,
	"created_by" uuid NOT NULL,
	"submitted_at" timestamp with time zone,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	CONSTRAINT "payables_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "payables_status_chk" CHECK ("payables"."status" in ('rascunho', 'aguardando_aprovacao', 'aprovado', 'rejeitado', 'cancelado')),
	CONSTRAINT "payables_amount_chk" CHECK ("payables"."amount" > 0 and "payables"."amount" <= 99999999999.99),
	CONSTRAINT "payables_text_chk" CHECK (char_length("payables"."description") between 2 and 200 and ("payables"."document_number" is null or char_length("payables"."document_number") between 1 and 40) and ("payables"."category" is null or char_length("payables"."category") <= 40)),
	CONSTRAINT "payables_decision_chk" CHECK (case when "payables"."status" in ('aprovado', 'rejeitado') then "payables"."decided_by" is not null and "payables"."decided_at" is not null when "payables"."status" in ('rascunho', 'aguardando_aprovacao') then "payables"."decided_by" is null else true end),
	CONSTRAINT "payables_reject_chk" CHECK ("payables"."status" <> 'rejeitado' or "payables"."decision_note" is not null),
	CONSTRAINT "payables_cancel_chk" CHECK (("payables"."status" = 'cancelado') = ("payables"."cancelled_by" is not null and "payables"."cancelled_at" is not null and "payables"."cancel_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "payables_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"manager_limit" numeric(18, 2) DEFAULT '5000.00' NOT NULL,
	"director_self_approval" boolean DEFAULT false NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "payables_settings_company_uq" UNIQUE("company_id"),
	CONSTRAINT "payables_settings_limit_chk" CHECK ("payables_settings"."manager_limit" >= 0 and "payables_settings"."manager_limit" <= 99999999999.99)
);
--> statement-breakpoint
ALTER TABLE "payable_payments" ADD CONSTRAINT "payable_payments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payable_payments" ADD CONSTRAINT "payable_payments_registered_by_users_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payable_payments" ADD CONSTRAINT "payable_payments_reversed_by_users_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payable_payments" ADD CONSTRAINT "payable_payments_company_id_payable_id_payables_company_id_id_fk" FOREIGN KEY ("company_id","payable_id") REFERENCES "public"."payables"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payables" ADD CONSTRAINT "payables_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payables" ADD CONSTRAINT "payables_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payables" ADD CONSTRAINT "payables_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payables" ADD CONSTRAINT "payables_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payables" ADD CONSTRAINT "payables_company_id_vendor_id_vendors_company_id_id_fk" FOREIGN KEY ("company_id","vendor_id") REFERENCES "public"."vendors"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payables_settings" ADD CONSTRAINT "payables_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payables_settings" ADD CONSTRAINT "payables_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payable_payments_request_key_uq" ON "payable_payments" USING btree ("company_id","request_key") WHERE "payable_payments"."request_key" is not null;--> statement-breakpoint
CREATE INDEX "payable_payments_payable_idx" ON "payable_payments" USING btree ("company_id","payable_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payables_doc_uq" ON "payables" USING btree ("company_id","vendor_id","document_number") WHERE "payables"."document_number" is not null and "payables"."status" not in ('cancelado', 'rejeitado');--> statement-breakpoint
CREATE INDEX "payables_due_idx" ON "payables" USING btree ("company_id","status","due_date");
--> statement-breakpoint
-- Defesa em profundidade das contas a pagar (além do serviço): máquina de estados, imutabilidade após o rascunho, nada se apaga.
CREATE FUNCTION payables_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'payable_undeletable'; END IF;
  IF OLD.status IN ('rejeitado', 'cancelado') THEN RAISE EXCEPTION 'payable_immutable'; END IF;
  IF OLD.status <> 'rascunho' AND (NEW.company_id <> OLD.company_id OR NEW.vendor_id <> OLD.vendor_id OR NEW.amount <> OLD.amount OR NEW.due_date <> OLD.due_date
     OR NEW.document_number IS DISTINCT FROM OLD.document_number OR NEW.description <> OLD.description OR NEW.category IS DISTINCT FROM OLD.category OR NEW.created_by <> OLD.created_by) THEN
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
--> statement-breakpoint
CREATE TRIGGER payables_guard_trg BEFORE UPDATE OR DELETE ON payables FOR EACH ROW EXECUTE FUNCTION payables_guard();
--> statement-breakpoint
-- Baixa: só em conta APROVADA; o total ativo nunca passa do valor; ativo só vira estornado; estornado é imutável; nunca se apaga.
CREATE FUNCTION payable_payments_guard() RETURNS trigger AS $$
DECLARE amt numeric; st text; tot numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'payable_payment_undeletable'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'estornado' THEN RAISE EXCEPTION 'payable_payment_immutable'; END IF;
    IF NEW.status <> 'estornado' OR NEW.company_id <> OLD.company_id OR NEW.payable_id <> OLD.payable_id OR NEW.amount <> OLD.amount
       OR NEW.paid_at <> OLD.paid_at OR NEW.method <> OLD.method OR NEW.registered_by <> OLD.registered_by
       OR NEW.reference IS DISTINCT FROM OLD.reference OR NEW.note IS DISTINCT FROM OLD.note OR NEW.request_key IS DISTINCT FROM OLD.request_key THEN
      RAISE EXCEPTION 'payable_payment_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> 'ativo' THEN RAISE EXCEPTION 'payable_payment_insert_not_active'; END IF;
  SELECT amount, status INTO amt, st FROM payables WHERE company_id = NEW.company_id AND id = NEW.payable_id FOR UPDATE;
  IF st IS DISTINCT FROM 'aprovado' THEN RAISE EXCEPTION 'payable_not_approved'; END IF;
  SELECT COALESCE(SUM(amount), 0) INTO tot FROM payable_payments WHERE company_id = NEW.company_id AND payable_id = NEW.payable_id AND status = 'ativo';
  IF tot + NEW.amount > amt THEN RAISE EXCEPTION 'payable_payment_exceeds_open'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payable_payments_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON payable_payments FOR EACH ROW EXECUTE FUNCTION payable_payments_guard();
