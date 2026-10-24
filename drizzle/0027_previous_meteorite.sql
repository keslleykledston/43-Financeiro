CREATE TABLE "email_live_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"allowed" text[] NOT NULL,
	"daily_limit" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"authorized_by" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "email_live_auth_ref_chk" CHECK (char_length("email_live_authorizations"."reference") between 5 and 200),
	CONSTRAINT "email_live_auth_allowed_chk" CHECK (cardinality("email_live_authorizations"."allowed") between 1 and 20),
	CONSTRAINT "email_live_auth_limit_chk" CHECK ("email_live_authorizations"."daily_limit" between 1 and 200),
	CONSTRAINT "email_live_auth_revoked_chk" CHECK ("email_live_authorizations"."active" = ("email_live_authorizations"."revoked_at" is null))
);
--> statement-breakpoint
CREATE TABLE "email_send_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"queue_id" uuid,
	"recipient_domains" text NOT NULL,
	"recipients" integer NOT NULL,
	"status" text DEFAULT 'enviando' NOT NULL,
	"provider_ref" text,
	"error" text,
	"actor_id" uuid,
	"finished_at" timestamp with time zone,
	CONSTRAINT "email_send_log_kind_chk" CHECK ("email_send_log"."kind" in ('fila', 'teste')),
	CONSTRAINT "email_send_log_status_chk" CHECK ("email_send_log"."status" in ('enviando', 'enviado', 'falhou', 'desconhecido')),
	CONSTRAINT "email_send_log_finished_chk" CHECK (("email_send_log"."status" = 'enviando') = ("email_send_log"."finished_at" is null))
);
--> statement-breakpoint
ALTER TABLE "message_queue" DROP CONSTRAINT "message_queue_status_chk";--> statement-breakpoint
ALTER TABLE "email_live_authorizations" ADD CONSTRAINT "email_live_authorizations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_live_authorizations" ADD CONSTRAINT "email_live_authorizations_authorized_by_users_id_fk" FOREIGN KEY ("authorized_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_live_authorizations" ADD CONSTRAINT "email_live_authorizations_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_send_log" ADD CONSTRAINT "email_send_log_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_send_log" ADD CONSTRAINT "email_send_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_live_auth_active_uq" ON "email_live_authorizations" USING btree ("company_id") WHERE "email_live_authorizations"."active";--> statement-breakpoint
CREATE INDEX "email_send_log_company_idx" ON "email_send_log" USING btree ("company_id","created_at");--> statement-breakpoint
ALTER TABLE "message_queue" ADD CONSTRAINT "message_queue_status_chk" CHECK ("message_queue"."status" in ('pendente', 'enviando', 'enviado', 'bloqueado', 'simulado', 'cancelado'));--> statement-breakpoint
CREATE FUNCTION email_live_authorizations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'autorizações de envio real são permanentes: revogue em vez de apagar' USING ERRCODE = '23514'; END IF;
  IF OLD.active AND NOT NEW.active AND NEW.revoked_at IS NOT NULL AND NEW.revoked_by IS NOT NULL
     AND NEW.company_id = OLD.company_id AND NEW.reference = OLD.reference AND NEW.allowed = OLD.allowed AND NEW.daily_limit = OLD.daily_limit
     AND NEW.authorized_by = OLD.authorized_by AND NEW.created_at = OLD.created_at THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'autorização de envio real só pode ser revogada, nunca editada' USING ERRCODE = '23514';
END $$;--> statement-breakpoint
CREATE TRIGGER email_live_authorizations_guard_trg BEFORE UPDATE OR DELETE ON email_live_authorizations FOR EACH ROW EXECUTE FUNCTION email_live_authorizations_guard();--> statement-breakpoint
CREATE FUNCTION email_send_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'o registro de envios de e-mail é permanente' USING ERRCODE = '23514'; END IF;
  IF OLD.status = 'enviando' AND NEW.status <> 'enviando' AND NEW.company_id = OLD.company_id AND NEW.kind = OLD.kind AND NEW.queue_id IS NOT DISTINCT FROM OLD.queue_id
     AND NEW.recipient_domains = OLD.recipient_domains AND NEW.recipients = OLD.recipients AND NEW.actor_id IS NOT DISTINCT FROM OLD.actor_id AND NEW.created_at = OLD.created_at THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'o registro de envios de e-mail só sai de "enviando" uma vez' USING ERRCODE = '23514';
END $$;--> statement-breakpoint
CREATE TRIGGER email_send_log_guard_trg BEFORE UPDATE OR DELETE ON email_send_log FOR EACH ROW EXECUTE FUNCTION email_send_log_guard();--> statement-breakpoint
CREATE FUNCTION message_queue_real_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('enviando', 'enviado') THEN RAISE EXCEPTION 'mensagem com envio real não pode ser apagada (preserva o histórico de envios)' USING ERRCODE = '23514'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'enviado' THEN RAISE EXCEPTION 'mensagem já enviada não pode ser alterada' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER message_queue_real_guard_trg BEFORE UPDATE OR DELETE ON message_queue FOR EACH ROW EXECUTE FUNCTION message_queue_real_guard();
