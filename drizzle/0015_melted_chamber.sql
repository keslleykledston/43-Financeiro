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
	CONSTRAINT "payments_reversal_chk" CHECK (("payments"."status" = 'estornado') = ("payments"."reversed_by" is not null and "payments"."reversed_at" is not null and "payments"."reverse_reason" is not null)),
	CONSTRAINT "payments_note_chk" CHECK ("payments"."note" is null or char_length("payments"."note") <= 200)
);
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_registered_by_users_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_reversed_by_users_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_company_id_charge_id_charges_company_id_id_fk" FOREIGN KEY ("company_id","charge_id") REFERENCES "public"."charges"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_request_key_uq" ON "payments" USING btree ("company_id","request_key") WHERE "payments"."request_key" is not null;--> statement-breakpoint
CREATE INDEX "payments_charge_idx" ON "payments" USING btree ("company_id","charge_id");--> statement-breakpoint
-- Defesa em profundidade (além do serviço): o total PAGO ATIVO nunca passa do valor da cobrança, e só cobrança aprovada recebe pagamento.
CREATE FUNCTION payments_guard() RETURNS trigger AS $$
DECLARE amt numeric; st text; tot numeric;
BEGIN
  IF NEW.status <> 'ativo' THEN RETURN NEW; END IF;
  SELECT amount, status INTO amt, st FROM charges WHERE company_id = NEW.company_id AND id = NEW.charge_id FOR UPDATE;
  IF st IS DISTINCT FROM 'aprovada' THEN RAISE EXCEPTION 'payment_charge_not_approved'; END IF;
  SELECT COALESCE(SUM(amount), 0) INTO tot FROM payments WHERE company_id = NEW.company_id AND charge_id = NEW.charge_id AND status = 'ativo' AND id <> NEW.id;
  IF tot + NEW.amount > amt THEN RAISE EXCEPTION 'payment_exceeds_open'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payments_guard_trg BEFORE INSERT OR UPDATE OF amount, status, charge_id ON payments FOR EACH ROW EXECUTE FUNCTION payments_guard();
