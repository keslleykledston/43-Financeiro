CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"charge_id" uuid NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"paid_at" date NOT NULL,
	"method" text NOT NULL,
	"note" text,
	"request_key" text,
	"status" text DEFAULT 'ativo' NOT NULL,
	"registered_by" uuid NOT NULL,
	"reversed_by" uuid,
	"reversed_at" timestamp with time zone,
	"reverse_reason" text,
	CONSTRAINT "payments_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "payments_amount_chk" CHECK ("payments"."amount" > 0 and "payments"."amount" <= 99999999999.99),
	CONSTRAINT "payments_method_chk" CHECK ("payments"."method" in ('pix', 'boleto', 'transferencia', 'dinheiro', 'outro')),
	CONSTRAINT "payments_status_chk" CHECK ("payments"."status" in ('ativo', 'estornado')),
	CONSTRAINT "payments_reversal_chk" CHECK (("payments"."status" = 'estornado' and "payments"."reversed_by" is not null and "payments"."reversed_at" is not null and "payments"."reverse_reason" is not null) or ("payments"."status" = 'ativo' and "payments"."reversed_by" is null and "payments"."reversed_at" is null and "payments"."reverse_reason" is null)),
	CONSTRAINT "payments_note_chk" CHECK ("payments"."note" is null or char_length("payments"."note") <= 200)
);
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_registered_by_users_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_reversed_by_users_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_company_id_charge_id_charges_company_id_id_fk" FOREIGN KEY ("company_id","charge_id") REFERENCES "public"."charges"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_request_key_uq" ON "payments" USING btree ("company_id","request_key") WHERE "payments"."request_key" is not null;--> statement-breakpoint
CREATE INDEX "payments_charge_idx" ON "payments" USING btree ("company_id","charge_id");--> statement-breakpoint
-- Defesa em profundidade (além do serviço). Pagamento: só nasce ATIVO; o total ativo nunca passa do valor da cobrança; só cobrança aprovada recebe;
-- ativo só pode virar estornado (sem mexer em valor/data/forma/cobrança); estornado é imutável; nunca se apaga.
CREATE FUNCTION payments_guard() RETURNS trigger AS $$
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
CREATE TRIGGER payments_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION payments_guard();
--> statement-breakpoint
-- Cobrança com pagamento (ou estorno) não pode sair de "aprovada" nem mudar de valor, mesmo que alguém reabra o lote por fora do serviço.
CREATE FUNCTION charges_payments_guard() RETURNS trigger AS $$
BEGIN
  IF (OLD.status = 'aprovada' AND NEW.status <> 'aprovada') OR NEW.amount <> OLD.amount THEN
    IF EXISTS (SELECT 1 FROM payments WHERE company_id = OLD.company_id AND charge_id = OLD.id) THEN RAISE EXCEPTION 'charge_has_payments'; END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER charges_payments_guard_trg BEFORE UPDATE OF status, amount ON charges FOR EACH ROW EXECUTE FUNCTION charges_payments_guard();
