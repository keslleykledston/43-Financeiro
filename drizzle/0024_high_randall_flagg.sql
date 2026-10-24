CREATE TABLE "boleto_cancellations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"charge_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"external_ref" text NOT NULL,
	"mode" text DEFAULT 'simulado' NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'enviando' NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"last_error" text,
	"requested_by" uuid NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "boleto_cancellations_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "boleto_cancellations_mode_chk" CHECK ("boleto_cancellations"."mode" = 'simulado'),
	CONSTRAINT "boleto_cancellations_status_chk" CHECK ("boleto_cancellations"."status" in ('enviando', 'cancelado', 'desconhecido', 'falhou')),
	CONSTRAINT "boleto_cancellations_reason_chk" CHECK (char_length("boleto_cancellations"."reason") between 3 and 200),
	CONSTRAINT "boleto_cancellations_attempts_chk" CHECK ("boleto_cancellations"."attempts" between 1 and 20),
	CONSTRAINT "boleto_cancellations_resolved_chk" CHECK (("boleto_cancellations"."status" in ('cancelado', 'falhou')) = ("boleto_cancellations"."resolved_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "boleto_cancellations" ADD CONSTRAINT "boleto_cancellations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boleto_cancellations" ADD CONSTRAINT "boleto_cancellations_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boleto_cancellations" ADD CONSTRAINT "boleto_cancellations_company_id_charge_id_charges_company_id_id_fk" FOREIGN KEY ("company_id","charge_id") REFERENCES "public"."charges"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boleto_cancellations" ADD CONSTRAINT "boleto_cancellations_company_id_request_id_issuance_requests_company_id_id_fk" FOREIGN KEY ("company_id","request_id") REFERENCES "public"."issuance_requests"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "boleto_cancellations_one_active_uq" ON "boleto_cancellations" USING btree ("company_id","request_id") WHERE "boleto_cancellations"."status" in ('enviando', 'cancelado', 'desconhecido');--> statement-breakpoint
CREATE INDEX "boleto_cancellations_charge_idx" ON "boleto_cancellations" USING btree ("company_id","charge_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION boleto_cancellations_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'boleto_cancellations: registro de cancelamento não pode ser apagado'; END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.charge_id <> OLD.charge_id OR NEW.request_id <> OLD.request_id OR NEW.external_ref <> OLD.external_ref
     OR NEW.mode <> OLD.mode OR NEW.reason <> OLD.reason OR NEW.requested_by <> OLD.requested_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'boleto_cancellations: quem, quando, por quê e qual boleto são imutáveis';
  END IF;
  IF OLD.status IN ('cancelado', 'falhou') AND (NEW.status, NEW.attempts, NEW.last_error, NEW.resolved_at) IS DISTINCT FROM (OLD.status, OLD.attempts, OLD.last_error, OLD.resolved_at) THEN
    RAISE EXCEPTION 'boleto_cancellations: cancelamento % é definitivo', OLD.status;
  END IF;
  IF NEW.attempts < OLD.attempts THEN RAISE EXCEPTION 'boleto_cancellations: tentativas não diminuem'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER boleto_cancellations_guard_trg BEFORE UPDATE OR DELETE ON boleto_cancellations FOR EACH ROW EXECUTE FUNCTION boleto_cancellations_guard();
