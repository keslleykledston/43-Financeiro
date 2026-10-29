CREATE TABLE "whatsapp_send_authorizations" (
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
	CONSTRAINT "whatsapp_send_auth_ref_chk" CHECK (char_length("whatsapp_send_authorizations"."reference") between 5 and 200),
	CONSTRAINT "whatsapp_send_auth_allowed_chk" CHECK (cardinality("whatsapp_send_authorizations"."allowed") between 1 and 10),
	CONSTRAINT "whatsapp_send_auth_limit_chk" CHECK ("whatsapp_send_authorizations"."daily_limit" between 1 and 10),
	CONSTRAINT "whatsapp_send_auth_revoked_chk" CHECK ("whatsapp_send_authorizations"."active" = ("whatsapp_send_authorizations"."revoked_at" is null))
);
--> statement-breakpoint
CREATE TABLE "whatsapp_send_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"kind" text DEFAULT 'teste' NOT NULL,
	"phone_masked" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'enviando' NOT NULL,
	"provider_ref" text,
	"error" text,
	"actor_id" uuid,
	"finished_at" timestamp with time zone,
	CONSTRAINT "whatsapp_send_log_idem_chk" CHECK ("whatsapp_send_log"."idempotency_key" ~ '^[A-Za-z0-9_-]{8,64}$'),
	CONSTRAINT "whatsapp_send_log_kind_chk" CHECK ("whatsapp_send_log"."kind" in ('teste')),
	CONSTRAINT "whatsapp_send_log_status_chk" CHECK ("whatsapp_send_log"."status" in ('enviando', 'enviado', 'falhou', 'desconhecido')),
	CONSTRAINT "whatsapp_send_log_finished_chk" CHECK (("whatsapp_send_log"."status" = 'enviando') = ("whatsapp_send_log"."finished_at" is null))
);
--> statement-breakpoint
CREATE TABLE "whatsapp_session_companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"session_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"sender_identity" text NOT NULL,
	"authorized_by" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "whatsapp_session_companies_sender_chk" CHECK (char_length("whatsapp_session_companies"."sender_identity") between 3 and 80)
);
--> statement-breakpoint
CREATE TABLE "whatsapp_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider" text DEFAULT 'waha' NOT NULL,
	"provider_session" text NOT NULL,
	"display_name" text NOT NULL,
	"phone_masked" text,
	"status" text DEFAULT 'CREATED' NOT NULL,
	"paused" boolean DEFAULT true NOT NULL,
	"engine" text,
	"last_seen_at" timestamp with time zone,
	"last_error" text,
	"created_by" uuid NOT NULL,
	CONSTRAINT "whatsapp_sessions_status_chk" CHECK ("whatsapp_sessions"."status" in ('CREATED', 'STARTING', 'QR_REQUIRED', 'CONNECTED', 'DISCONNECTED', 'DEGRADED', 'REVOKED')),
	CONSTRAINT "whatsapp_sessions_name_chk" CHECK (char_length("whatsapp_sessions"."display_name") between 2 and 64 and "whatsapp_sessions"."provider_session" ~ '^k3g-[a-f0-9]{8}$')
);
--> statement-breakpoint
ALTER TABLE "whatsapp_send_authorizations" ADD CONSTRAINT "whatsapp_send_authorizations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_send_authorizations" ADD CONSTRAINT "whatsapp_send_authorizations_authorized_by_users_id_fk" FOREIGN KEY ("authorized_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_send_authorizations" ADD CONSTRAINT "whatsapp_send_authorizations_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_send_log" ADD CONSTRAINT "whatsapp_send_log_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_send_log" ADD CONSTRAINT "whatsapp_send_log_session_id_whatsapp_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."whatsapp_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_send_log" ADD CONSTRAINT "whatsapp_send_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_session_companies" ADD CONSTRAINT "whatsapp_session_companies_session_id_whatsapp_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."whatsapp_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_session_companies" ADD CONSTRAINT "whatsapp_session_companies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_session_companies" ADD CONSTRAINT "whatsapp_session_companies_authorized_by_users_id_fk" FOREIGN KEY ("authorized_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_session_companies" ADD CONSTRAINT "whatsapp_session_companies_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_sessions" ADD CONSTRAINT "whatsapp_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_send_auth_active_uq" ON "whatsapp_send_authorizations" USING btree ("company_id") WHERE "whatsapp_send_authorizations"."active";--> statement-breakpoint
CREATE INDEX "whatsapp_send_log_company_idx" ON "whatsapp_send_log" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "whatsapp_send_log_session_idx" ON "whatsapp_send_log" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_send_log_idem_uq" ON "whatsapp_send_log" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_session_companies_active_uq" ON "whatsapp_session_companies" USING btree ("session_id","company_id") WHERE "whatsapp_session_companies"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "whatsapp_session_companies_company_idx" ON "whatsapp_session_companies" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_sessions_provider_session_uq" ON "whatsapp_sessions" USING btree ("provider","provider_session");--> statement-breakpoint
CREATE FUNCTION whatsapp_send_authorizations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'autorizações de envio de WhatsApp são permanentes: revogue em vez de apagar' USING ERRCODE = '23514'; END IF;
  IF OLD.active AND NOT NEW.active AND NEW.revoked_at IS NOT NULL AND NEW.revoked_by IS NOT NULL
     AND NEW.company_id = OLD.company_id AND NEW.reference = OLD.reference AND NEW.allowed = OLD.allowed AND NEW.daily_limit = OLD.daily_limit
     AND NEW.authorized_by = OLD.authorized_by AND NEW.created_at = OLD.created_at THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'autorização de envio de WhatsApp só pode ser revogada, nunca editada' USING ERRCODE = '23514';
END $$;--> statement-breakpoint
CREATE TRIGGER whatsapp_send_authorizations_guard_trg BEFORE UPDATE OR DELETE ON whatsapp_send_authorizations FOR EACH ROW EXECUTE FUNCTION whatsapp_send_authorizations_guard();--> statement-breakpoint
CREATE FUNCTION whatsapp_send_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'o registro de envios de WhatsApp é permanente' USING ERRCODE = '23514'; END IF;
  IF OLD.status = 'enviando' AND NEW.status <> 'enviando' AND NEW.company_id = OLD.company_id AND NEW.session_id = OLD.session_id AND NEW.kind = OLD.kind
     AND NEW.phone_masked = OLD.phone_masked AND NEW.idempotency_key = OLD.idempotency_key AND NEW.actor_id IS NOT DISTINCT FROM OLD.actor_id AND NEW.created_at = OLD.created_at THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'o registro de envios de WhatsApp só sai de "enviando" uma vez' USING ERRCODE = '23514';
END $$;--> statement-breakpoint
CREATE TRIGGER whatsapp_send_log_guard_trg BEFORE UPDATE OR DELETE ON whatsapp_send_log FOR EACH ROW EXECUTE FUNCTION whatsapp_send_log_guard();--> statement-breakpoint
CREATE FUNCTION whatsapp_session_companies_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'o vínculo de empresa com a conexão é permanente: revogue em vez de apagar' USING ERRCODE = '23514'; END IF;
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND NEW.revoked_by IS NOT NULL AND NEW.session_id = OLD.session_id AND NEW.company_id = OLD.company_id
     AND NEW.sender_identity = OLD.sender_identity AND NEW.authorized_by = OLD.authorized_by AND NEW.created_at = OLD.created_at THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'o vínculo só pode ser revogado, nunca editado' USING ERRCODE = '23514';
END $$;--> statement-breakpoint
CREATE TRIGGER whatsapp_session_companies_guard_trg BEFORE UPDATE OR DELETE ON whatsapp_session_companies FOR EACH ROW EXECUTE FUNCTION whatsapp_session_companies_guard();--> statement-breakpoint
CREATE FUNCTION whatsapp_sessions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'conexões de WhatsApp não são apagadas: o histórico fica (use desconectar)' USING ERRCODE = '23514'; END IF;
  IF NEW.provider = OLD.provider AND NEW.provider_session = OLD.provider_session AND NEW.created_by = OLD.created_by AND NEW.created_at = OLD.created_at THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'a identidade da conexão não pode ser alterada' USING ERRCODE = '23514';
END $$;--> statement-breakpoint
CREATE TRIGGER whatsapp_sessions_guard_trg BEFORE UPDATE OR DELETE ON whatsapp_sessions FOR EACH ROW EXECUTE FUNCTION whatsapp_sessions_guard();--> statement-breakpoint
CREATE TRIGGER whatsapp_send_authorizations_no_truncate_trg BEFORE TRUNCATE ON whatsapp_send_authorizations FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate_guard();--> statement-breakpoint
CREATE TRIGGER whatsapp_send_log_no_truncate_trg BEFORE TRUNCATE ON whatsapp_send_log FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate_guard();--> statement-breakpoint
CREATE TRIGGER whatsapp_session_companies_no_truncate_trg BEFORE TRUNCATE ON whatsapp_session_companies FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate_guard();--> statement-breakpoint
CREATE TRIGGER whatsapp_sessions_no_truncate_trg BEFORE TRUNCATE ON whatsapp_sessions FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate_guard();
