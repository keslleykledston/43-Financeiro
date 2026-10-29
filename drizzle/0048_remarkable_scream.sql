CREATE TABLE "whatsapp_company_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"send_enabled" boolean DEFAULT false NOT NULL,
	"automation_enabled" boolean DEFAULT false NOT NULL,
	"daily_cap" integer DEFAULT 10 NOT NULL,
	"reference" text,
	"authorized_by" uuid,
	"authorized_at" timestamp with time zone,
	CONSTRAINT "whatsapp_company_settings_cap_chk" CHECK ("whatsapp_company_settings"."daily_cap" between 1 and 10),
	CONSTRAINT "whatsapp_company_settings_auth_chk" CHECK (not ("whatsapp_company_settings"."send_enabled" or "whatsapp_company_settings"."automation_enabled") or ("whatsapp_company_settings"."reference" is not null and char_length("whatsapp_company_settings"."reference") >= 5 and "whatsapp_company_settings"."authorized_by" is not null and "whatsapp_company_settings"."authorized_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "whatsapp_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"charge_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"template_version_id" uuid NOT NULL,
	"milestone" text NOT NULL,
	"phone" text NOT NULL,
	"phone_masked" text NOT NULL,
	"body_enc" text NOT NULL,
	"body_sha" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'na_fila' NOT NULL,
	"reason" text,
	"provider_ref" text,
	"delivery" text,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"requested_by" uuid NOT NULL,
	CONSTRAINT "whatsapp_outbox_status_chk" CHECK ("whatsapp_outbox"."status" in ('na_fila', 'enviando', 'enviado', 'desconhecido', 'falhou', 'suprimido', 'cancelado')),
	CONSTRAINT "whatsapp_outbox_phone_chk" CHECK ("whatsapp_outbox"."phone" ~ '^55[0-9]{10,11}$'),
	CONSTRAINT "whatsapp_outbox_milestone_chk" CHECK ("whatsapp_outbox"."milestone" in ('emissao', 'd_menos_3', 'd0', 'd_mais_3', 'd_mais_7')),
	CONSTRAINT "whatsapp_outbox_idem_chk" CHECK ("whatsapp_outbox"."idempotency_key" ~ '^[A-Za-z0-9_-]{8,64}$'),
	CONSTRAINT "whatsapp_outbox_delivery_chk" CHECK ("whatsapp_outbox"."delivery" is null or "whatsapp_outbox"."delivery" in ('entregue', 'lido')),
	CONSTRAINT "whatsapp_outbox_finished_chk" CHECK (("whatsapp_outbox"."status" in ('enviado', 'desconhecido', 'falhou', 'suprimido', 'cancelado')) = ("whatsapp_outbox"."finished_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "whatsapp_company_settings" ADD CONSTRAINT "whatsapp_company_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_company_settings" ADD CONSTRAINT "whatsapp_company_settings_authorized_by_users_id_fk" FOREIGN KEY ("authorized_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_outbox" ADD CONSTRAINT "whatsapp_outbox_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_outbox" ADD CONSTRAINT "whatsapp_outbox_session_id_whatsapp_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."whatsapp_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_outbox" ADD CONSTRAINT "whatsapp_outbox_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_outbox" ADD CONSTRAINT "whatsapp_outbox_company_id_charge_id_charges_company_id_id_fk" FOREIGN KEY ("company_id","charge_id") REFERENCES "public"."charges"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_outbox" ADD CONSTRAINT "whatsapp_outbox_company_id_customer_id_customers_company_id_id_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."customers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_outbox" ADD CONSTRAINT "whatsapp_outbox_company_id_template_version_id_message_template_versions_company_id_id_fk" FOREIGN KEY ("company_id","template_version_id") REFERENCES "public"."message_template_versions"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_company_settings_company_uq" ON "whatsapp_company_settings" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_outbox_idem_uq" ON "whatsapp_outbox" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_outbox_dedupe_uq" ON "whatsapp_outbox" USING btree ("company_id","charge_id","milestone","phone") WHERE "whatsapp_outbox"."status" in ('na_fila', 'enviando', 'enviado', 'desconhecido');--> statement-breakpoint
CREATE INDEX "whatsapp_outbox_company_idx" ON "whatsapp_outbox" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "whatsapp_outbox_customer_idx" ON "whatsapp_outbox" USING btree ("company_id","customer_id","created_at");--> statement-breakpoint
CREATE INDEX "whatsapp_outbox_ref_idx" ON "whatsapp_outbox" USING btree ("provider_ref");--> statement-breakpoint
CREATE FUNCTION whatsapp_outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'o histórico de mensagens de WhatsApp é permanente' USING ERRCODE = '23514'; END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.charge_id IS DISTINCT FROM OLD.charge_id OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.template_version_id IS DISTINCT FROM OLD.template_version_id OR NEW.milestone IS DISTINCT FROM OLD.milestone OR NEW.phone IS DISTINCT FROM OLD.phone OR NEW.phone_masked IS DISTINCT FROM OLD.phone_masked
     OR NEW.body_enc IS DISTINCT FROM OLD.body_enc OR NEW.body_sha IS DISTINCT FROM OLD.body_sha OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a identidade e o texto da mensagem não podem ser alterados' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = NEW.status THEN
    IF OLD.status IN ('falhou', 'suprimido', 'cancelado') THEN RAISE EXCEPTION 'mensagem encerrada não pode ser alterada' USING ERRCODE = '23514'; END IF;
    IF OLD.status IN ('enviado', 'desconhecido') AND (NEW.reason IS DISTINCT FROM OLD.reason OR NEW.provider_ref IS DISTINCT FROM OLD.provider_ref OR NEW.sent_at IS DISTINCT FROM OLD.sent_at OR NEW.finished_at IS DISTINCT FROM OLD.finished_at) THEN
      RAISE EXCEPTION 'resultado do envio não pode ser alterado (só a confirmação de entrega/leitura)' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.status = 'na_fila' AND NEW.status IN ('enviando', 'suprimido', 'cancelado'))
     OR (OLD.status = 'enviando' AND NEW.status IN ('enviado', 'desconhecido', 'falhou', 'suprimido'))
     OR (OLD.status = 'desconhecido' AND NEW.status IN ('enviado', 'falhou')) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'transição de estado da mensagem não permitida (% → %)', OLD.status, NEW.status USING ERRCODE = '23514';
END $$;--> statement-breakpoint
CREATE TRIGGER whatsapp_outbox_guard_trg BEFORE UPDATE OR DELETE ON whatsapp_outbox FOR EACH ROW EXECUTE FUNCTION whatsapp_outbox_guard();--> statement-breakpoint
CREATE TRIGGER whatsapp_outbox_no_truncate_trg BEFORE TRUNCATE ON whatsapp_outbox FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate_guard();--> statement-breakpoint
CREATE FUNCTION whatsapp_company_settings_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a configuração de WhatsApp da empresa não é apagada' USING ERRCODE = '23514';
END $$;--> statement-breakpoint
CREATE TRIGGER whatsapp_company_settings_nodelete_trg BEFORE DELETE ON whatsapp_company_settings FOR EACH ROW EXECUTE FUNCTION whatsapp_company_settings_guard();--> statement-breakpoint
CREATE TRIGGER whatsapp_company_settings_no_truncate_trg BEFORE TRUNCATE ON whatsapp_company_settings FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate_guard();
