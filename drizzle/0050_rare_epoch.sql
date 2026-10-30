ALTER TABLE "whatsapp_company_settings" ADD COLUMN "automation_kinds" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "whatsapp_company_settings" ADD COLUMN "automation_reference" text;--> statement-breakpoint
ALTER TABLE "whatsapp_company_settings" ADD COLUMN "automation_authorized_by" uuid;--> statement-breakpoint
ALTER TABLE "whatsapp_company_settings" ADD COLUMN "automation_authorized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "whatsapp_outbox" ADD COLUMN "origin" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "whatsapp_company_settings" ADD CONSTRAINT "whatsapp_company_settings_automation_authorized_by_users_id_fk" FOREIGN KEY ("automation_authorized_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "whatsapp_outbox_origin_idx" ON "whatsapp_outbox" USING btree ("company_id","origin","status");--> statement-breakpoint
ALTER TABLE "whatsapp_company_settings" ADD CONSTRAINT "whatsapp_company_settings_auto_chk" CHECK (not "whatsapp_company_settings"."automation_enabled" or ("whatsapp_company_settings"."send_enabled" and cardinality("whatsapp_company_settings"."automation_kinds") > 0 and "whatsapp_company_settings"."automation_reference" is not null and char_length("whatsapp_company_settings"."automation_reference") >= 5 and "whatsapp_company_settings"."automation_authorized_by" is not null));--> statement-breakpoint
ALTER TABLE "whatsapp_company_settings" ADD CONSTRAINT "whatsapp_company_settings_kinds_chk" CHECK ("whatsapp_company_settings"."automation_kinds" <@ array['d_menos_3', 'd0', 'd_mais_3', 'd_mais_7']::text[]);--> statement-breakpoint
ALTER TABLE "whatsapp_outbox" ADD CONSTRAINT "whatsapp_outbox_origin_chk" CHECK ("whatsapp_outbox"."origin" in ('manual', 'regua'));--> statement-breakpoint
CREATE OR REPLACE FUNCTION whatsapp_outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'o histórico de mensagens de WhatsApp é permanente' USING ERRCODE = '23514'; END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.charge_id IS DISTINCT FROM OLD.charge_id OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.template_version_id IS DISTINCT FROM OLD.template_version_id OR NEW.milestone IS DISTINCT FROM OLD.milestone OR NEW.phone IS DISTINCT FROM OLD.phone OR NEW.phone_masked IS DISTINCT FROM OLD.phone_masked
     OR NEW.body_enc IS DISTINCT FROM OLD.body_enc OR NEW.body_sha IS DISTINCT FROM OLD.body_sha OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.origin IS DISTINCT FROM OLD.origin THEN
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
END $$;
