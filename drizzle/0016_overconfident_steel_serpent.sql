CREATE TABLE "bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"bank" text NOT NULL,
	"last4" text,
	"opening_balance" numeric(18, 2) DEFAULT '0' NOT NULL,
	"opening_date" date NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	CONSTRAINT "bank_accounts_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "bank_accounts_company_name_uq" UNIQUE("company_id","name"),
	CONSTRAINT "bank_accounts_last4_chk" CHECK ("bank_accounts"."last4" is null or "bank_accounts"."last4" ~ '^[0-9]{4}$'),
	CONSTRAINT "bank_accounts_opening_chk" CHECK (abs("bank_accounts"."opening_balance") <= 99999999999.99)
);
--> statement-breakpoint
CREATE TABLE "bank_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"charge_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"request_key" text,
	"status" text DEFAULT 'ativa' NOT NULL,
	"created_by" uuid NOT NULL,
	"undone_by" uuid,
	"undone_at" timestamp with time zone,
	"undo_reason" text,
	CONSTRAINT "bank_allocations_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "bank_allocations_payment_uq" UNIQUE("payment_id"),
	CONSTRAINT "bank_allocations_amount_chk" CHECK ("bank_allocations"."amount" > 0 and "bank_allocations"."amount" <= 99999999999.99),
	CONSTRAINT "bank_allocations_status_chk" CHECK ("bank_allocations"."status" in ('ativa', 'desfeita')),
	CONSTRAINT "bank_allocations_undo_chk" CHECK (("bank_allocations"."status" = 'desfeita' and "bank_allocations"."undone_by" is not null and "bank_allocations"."undone_at" is not null and "bank_allocations"."undo_reason" is not null) or ("bank_allocations"."status" = 'ativa' and "bank_allocations"."undone_by" is null and "bank_allocations"."undone_at" is null and "bank_allocations"."undo_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "bank_import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"format" text NOT NULL,
	"file_name" text NOT NULL,
	"checksum" text NOT NULL,
	"status" text DEFAULT 'previa' NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"new_count" integer DEFAULT 0 NOT NULL,
	"dup_count" integer DEFAULT 0 NOT NULL,
	"period_start" date,
	"period_end" date,
	"ledger_balance" numeric(18, 2),
	"ledger_date" date,
	"imported_by" uuid NOT NULL,
	"applied_by" uuid,
	"applied_at" timestamp with time zone,
	"undone_by" uuid,
	"undone_at" timestamp with time zone,
	"undo_reason" text,
	CONSTRAINT "bank_import_batches_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "bank_import_batches_status_chk" CHECK ("bank_import_batches"."status" in ('previa', 'aplicado', 'desfeito', 'cancelado')),
	CONSTRAINT "bank_import_batches_format_chk" CHECK ("bank_import_batches"."format" in ('ofx', 'csv'))
);
--> statement-breakpoint
CREATE TABLE "bank_import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"posted_at" date NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"description" text NOT NULL,
	"external_ref" text,
	"ref_key" text NOT NULL,
	"duplicate" boolean DEFAULT false NOT NULL,
	CONSTRAINT "bank_import_rows_batch_key_uq" UNIQUE("batch_id","ref_key")
);
--> statement-breakpoint
CREATE TABLE "bank_transaction_marks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"note" text,
	"created_by" uuid NOT NULL,
	CONSTRAINT "bank_transaction_marks_tx_uq" UNIQUE("transaction_id"),
	CONSTRAINT "bank_transaction_marks_kind_chk" CHECK ("bank_transaction_marks"."kind" in ('tarifa', 'transferencia_grupo', 'outro')),
	CONSTRAINT "bank_transaction_marks_note_chk" CHECK ("bank_transaction_marks"."note" is null or char_length("bank_transaction_marks"."note") <= 200)
);
--> statement-breakpoint
CREATE TABLE "bank_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"posted_at" date NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"description" text NOT NULL,
	"external_ref" text,
	"ref_key" text NOT NULL,
	"status" text DEFAULT 'ativa' NOT NULL,
	CONSTRAINT "bank_transactions_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "bank_transactions_amount_chk" CHECK ("bank_transactions"."amount" <> 0 and abs("bank_transactions"."amount") <= 99999999999.99),
	CONSTRAINT "bank_transactions_status_chk" CHECK ("bank_transactions"."status" in ('ativa', 'desfeita'))
);
--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_method_chk";--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_allocations" ADD CONSTRAINT "bank_allocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_allocations" ADD CONSTRAINT "bank_allocations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_allocations" ADD CONSTRAINT "bank_allocations_undone_by_users_id_fk" FOREIGN KEY ("undone_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_allocations" ADD CONSTRAINT "bank_allocations_company_id_transaction_id_bank_transactions_company_id_id_fk" FOREIGN KEY ("company_id","transaction_id") REFERENCES "public"."bank_transactions"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_allocations" ADD CONSTRAINT "bank_allocations_company_id_charge_id_charges_company_id_id_fk" FOREIGN KEY ("company_id","charge_id") REFERENCES "public"."charges"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_allocations" ADD CONSTRAINT "bank_allocations_company_id_payment_id_payments_company_id_id_fk" FOREIGN KEY ("company_id","payment_id") REFERENCES "public"."payments"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_batches" ADD CONSTRAINT "bank_import_batches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_batches" ADD CONSTRAINT "bank_import_batches_imported_by_users_id_fk" FOREIGN KEY ("imported_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_batches" ADD CONSTRAINT "bank_import_batches_applied_by_users_id_fk" FOREIGN KEY ("applied_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_batches" ADD CONSTRAINT "bank_import_batches_undone_by_users_id_fk" FOREIGN KEY ("undone_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_batches" ADD CONSTRAINT "bank_import_batches_company_id_account_id_bank_accounts_company_id_id_fk" FOREIGN KEY ("company_id","account_id") REFERENCES "public"."bank_accounts"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_rows" ADD CONSTRAINT "bank_import_rows_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_rows" ADD CONSTRAINT "bank_import_rows_company_id_batch_id_bank_import_batches_company_id_id_fk" FOREIGN KEY ("company_id","batch_id") REFERENCES "public"."bank_import_batches"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction_marks" ADD CONSTRAINT "bank_transaction_marks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction_marks" ADD CONSTRAINT "bank_transaction_marks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction_marks" ADD CONSTRAINT "bank_transaction_marks_company_id_transaction_id_bank_transactions_company_id_id_fk" FOREIGN KEY ("company_id","transaction_id") REFERENCES "public"."bank_transactions"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_company_id_account_id_bank_accounts_company_id_id_fk" FOREIGN KEY ("company_id","account_id") REFERENCES "public"."bank_accounts"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_company_id_batch_id_bank_import_batches_company_id_id_fk" FOREIGN KEY ("company_id","batch_id") REFERENCES "public"."bank_import_batches"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_allocations_request_key_uq" ON "bank_allocations" USING btree ("company_id","request_key") WHERE "bank_allocations"."request_key" is not null;--> statement-breakpoint
CREATE INDEX "bank_allocations_tx_idx" ON "bank_allocations" USING btree ("company_id","transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_import_batches_checksum_uq" ON "bank_import_batches" USING btree ("company_id","account_id","checksum") WHERE "bank_import_batches"."status" in ('previa', 'aplicado');--> statement-breakpoint
CREATE UNIQUE INDEX "bank_transactions_ref_uq" ON "bank_transactions" USING btree ("company_id","account_id","ref_key") WHERE "bank_transactions"."status" = 'ativa';--> statement-breakpoint
CREATE INDEX "bank_transactions_account_idx" ON "bank_transactions" USING btree ("company_id","account_id","posted_at");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_method_chk" CHECK ("payments"."method" in ('pix', 'boleto', 'transferencia', 'dinheiro', 'outro', 'extrato'));
--> statement-breakpoint
-- Defesa em profundidade da conciliação. Transação importada é imutável (só pode virar "desfeita" junto com a importação); nada se apaga.
CREATE FUNCTION bank_transactions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'bank_tx_undeletable'; END IF;
  IF OLD.status = 'desfeita' THEN RAISE EXCEPTION 'bank_tx_immutable'; END IF;
  IF NEW.status <> 'desfeita' OR NEW.company_id <> OLD.company_id OR NEW.account_id <> OLD.account_id OR NEW.batch_id <> OLD.batch_id
     OR NEW.posted_at <> OLD.posted_at OR NEW.amount <> OLD.amount OR NEW.description <> OLD.description
     OR NEW.external_ref IS DISTINCT FROM OLD.external_ref OR NEW.ref_key <> OLD.ref_key THEN
    RAISE EXCEPTION 'bank_tx_immutable';
  END IF;
  IF EXISTS (SELECT 1 FROM bank_allocations WHERE company_id = OLD.company_id AND transaction_id = OLD.id AND status = 'ativa') THEN RAISE EXCEPTION 'bank_tx_has_allocations'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER bank_transactions_guard_trg BEFORE UPDATE OR DELETE ON bank_transactions FOR EACH ROW EXECUTE FUNCTION bank_transactions_guard();
--> statement-breakpoint
-- Vínculo: só crédito ativo; soma dos vínculos ativos nunca passa do crédito; sem classificação; o pagamento tem a mesma cobrança e o mesmo valor.
CREATE FUNCTION bank_allocations_guard() RETURNS trigger AS $$
DECLARE tx_amt numeric; tx_st text; tot numeric; pay_ok boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'bank_alloc_undeletable'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'desfeita' THEN RAISE EXCEPTION 'bank_alloc_immutable'; END IF;
    IF NEW.status <> 'desfeita' OR NEW.company_id <> OLD.company_id OR NEW.transaction_id <> OLD.transaction_id OR NEW.charge_id <> OLD.charge_id
       OR NEW.payment_id <> OLD.payment_id OR NEW.amount <> OLD.amount OR NEW.created_by <> OLD.created_by OR NEW.request_key IS DISTINCT FROM OLD.request_key THEN
      RAISE EXCEPTION 'bank_alloc_immutable';
    END IF;
    -- desfazer o vínculo exige o pagamento correspondente já estornado (consistência dos dois lados)
    IF NOT EXISTS (SELECT 1 FROM payments WHERE company_id = OLD.company_id AND id = OLD.payment_id AND status = 'estornado') THEN RAISE EXCEPTION 'bank_alloc_payment_still_active'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> 'ativa' THEN RAISE EXCEPTION 'bank_alloc_insert_not_active'; END IF;
  SELECT amount, status INTO tx_amt, tx_st FROM bank_transactions WHERE company_id = NEW.company_id AND id = NEW.transaction_id FOR UPDATE;
  IF tx_st IS DISTINCT FROM 'ativa' OR tx_amt <= 0 THEN RAISE EXCEPTION 'bank_alloc_tx_not_credit'; END IF;
  IF EXISTS (SELECT 1 FROM bank_transaction_marks WHERE company_id = NEW.company_id AND transaction_id = NEW.transaction_id) THEN RAISE EXCEPTION 'bank_alloc_tx_marked'; END IF;
  SELECT COALESCE(SUM(amount), 0) INTO tot FROM bank_allocations WHERE company_id = NEW.company_id AND transaction_id = NEW.transaction_id AND status = 'ativa';
  IF tot + NEW.amount > tx_amt THEN RAISE EXCEPTION 'bank_alloc_exceeds_credit'; END IF;
  SELECT (charge_id = NEW.charge_id AND amount = NEW.amount AND status = 'ativo') INTO pay_ok FROM payments WHERE company_id = NEW.company_id AND id = NEW.payment_id;
  IF pay_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'bank_alloc_payment_mismatch'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER bank_allocations_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON bank_allocations FOR EACH ROW EXECUTE FUNCTION bank_allocations_guard();
--> statement-breakpoint
CREATE FUNCTION bank_marks_guard() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM bank_allocations WHERE company_id = NEW.company_id AND transaction_id = NEW.transaction_id AND status = 'ativa') THEN RAISE EXCEPTION 'bank_mark_tx_allocated'; END IF;
  IF NOT EXISTS (SELECT 1 FROM bank_transactions WHERE company_id = NEW.company_id AND id = NEW.transaction_id AND status = 'ativa') THEN RAISE EXCEPTION 'bank_mark_tx_inactive'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER bank_marks_guard_trg BEFORE INSERT ON bank_transaction_marks FOR EACH ROW EXECUTE FUNCTION bank_marks_guard();
--> statement-breakpoint
-- Pagamento ligado a um vínculo bancário ATIVO só pode ser estornado dentro do desfazer-vínculo (k3g.bank_undo, local à transação).
CREATE OR REPLACE FUNCTION payments_guard() RETURNS trigger AS $$
DECLARE amt numeric; st text; tot numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'payment_undeletable'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'estornado' THEN RAISE EXCEPTION 'payment_immutable'; END IF;
    IF NEW.status <> 'estornado' OR NEW.company_id <> OLD.company_id OR NEW.charge_id <> OLD.charge_id OR NEW.amount <> OLD.amount
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
