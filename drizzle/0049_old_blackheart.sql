CREATE TABLE "whatsapp_inbound_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_key" text NOT NULL,
	"event_type" text NOT NULL,
	"provider_session" text NOT NULL,
	"session_id" uuid,
	"company_id" uuid,
	"customer_id" uuid,
	"peer" text,
	"phone" text,
	"phone_masked" text,
	"ref_hash" text,
	"ack" text,
	"kind" text DEFAULT 'texto' NOT NULL,
	"body_enc" text,
	"classification" text,
	"routing" text DEFAULT 'pendente' NOT NULL,
	"handling" text DEFAULT 'novo' NOT NULL,
	"dispute" boolean DEFAULT false NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"optout_applied" text,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"event_at" timestamp with time zone,
	CONSTRAINT "whatsapp_inbound_type_chk" CHECK ("whatsapp_inbound_events"."event_type" in ('message', 'message.ack', 'session.status')),
	CONSTRAINT "whatsapp_inbound_kind_chk" CHECK ("whatsapp_inbound_events"."kind" in ('texto', 'midia', 'outro')),
	CONSTRAINT "whatsapp_inbound_routing_chk" CHECK ("whatsapp_inbound_events"."routing" in ('pendente', 'atribuida', 'triagem', 'ignorada', 'descartada', 'atribuida_manual')),
	CONSTRAINT "whatsapp_inbound_handling_chk" CHECK ("whatsapp_inbound_events"."handling" in ('novo', 'em_atendimento', 'resolvido')),
	CONSTRAINT "whatsapp_inbound_optout_chk" CHECK ("whatsapp_inbound_events"."optout_applied" is null or "whatsapp_inbound_events"."optout_applied" in ('company', 'global')),
	CONSTRAINT "whatsapp_inbound_key_chk" CHECK (char_length("whatsapp_inbound_events"."event_key") between 3 and 120)
);
--> statement-breakpoint
ALTER TABLE "whatsapp_inbound_events" ADD CONSTRAINT "whatsapp_inbound_events_session_id_whatsapp_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."whatsapp_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_inbound_events" ADD CONSTRAINT "whatsapp_inbound_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_inbound_events" ADD CONSTRAINT "whatsapp_inbound_events_company_id_customer_id_customers_company_id_id_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."customers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_inbound_event_key_uq" ON "whatsapp_inbound_events" USING btree ("event_key");--> statement-breakpoint
CREATE INDEX "whatsapp_inbound_company_idx" ON "whatsapp_inbound_events" USING btree ("company_id","routing","handling","created_at");--> statement-breakpoint
CREATE INDEX "whatsapp_inbound_phone_idx" ON "whatsapp_inbound_events" USING btree ("phone","created_at");--> statement-breakpoint
CREATE INDEX "whatsapp_inbound_pending_idx" ON "whatsapp_inbound_events" USING btree ("routing","created_at");--> statement-breakpoint
CREATE FUNCTION whatsapp_inbound_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'o registro de eventos do WhatsApp é permanente' USING ERRCODE = '23514'; END IF;
  IF NEW.event_key IS DISTINCT FROM OLD.event_key OR NEW.event_type IS DISTINCT FROM OLD.event_type OR NEW.provider_session IS DISTINCT FROM OLD.provider_session OR (OLD.phone IS NOT NULL AND NEW.phone IS DISTINCT FROM OLD.phone)
     OR NEW.peer IS DISTINCT FROM OLD.peer OR NEW.ref_hash IS DISTINCT FROM OLD.ref_hash OR (OLD.phone_masked IS NOT NULL AND NEW.phone_masked IS DISTINCT FROM OLD.phone_masked) OR NEW.body_enc IS DISTINCT FROM OLD.body_enc OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'o conteúdo do evento recebido não pode ser alterado' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER whatsapp_inbound_events_guard_trg BEFORE UPDATE OR DELETE ON whatsapp_inbound_events FOR EACH ROW EXECUTE FUNCTION whatsapp_inbound_events_guard();--> statement-breakpoint
CREATE TRIGGER whatsapp_inbound_events_no_truncate_trg BEFORE TRUNCATE ON whatsapp_inbound_events FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate_guard();
