ALTER TABLE "boleto_cancellations" DROP CONSTRAINT "boleto_cancellations_mode_chk";--> statement-breakpoint
ALTER TABLE "issuance_requests" DROP CONSTRAINT "issuance_requests_mode_chk";--> statement-breakpoint
ALTER TABLE "issuance_settings" ADD COLUMN "boleto_provider" text DEFAULT 'simulado' NOT NULL;--> statement-breakpoint
ALTER TABLE "boleto_cancellations" ADD CONSTRAINT "boleto_cancellations_mode_chk" CHECK ("boleto_cancellations"."mode" in ('simulado', 'cora_homologacao'));--> statement-breakpoint
ALTER TABLE "issuance_requests" ADD CONSTRAINT "issuance_requests_mode_chk" CHECK ("issuance_requests"."mode" in ('simulado', 'cora_homologacao'));--> statement-breakpoint
ALTER TABLE "issuance_settings" ADD CONSTRAINT "issuance_settings_provider_chk" CHECK ("issuance_settings"."boleto_provider" in ('simulado', 'cora_homologacao'));--> statement-breakpoint
-- E10b-1: solicitação com provedor REAL (Cora de testes) não pode ser apagada (nem em cascata ao remover a cobrança) nem trocar de modo: o boleto existe lá fora.
CREATE OR REPLACE FUNCTION issuance_requests_live_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.mode <> 'simulado' AND OLD.status <> 'cancelado' THEN
      RAISE EXCEPTION 'issuance_live_protected: solicitacao com provedor real nao pode ser apagada' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.mode <> 'simulado' AND NEW.mode <> OLD.mode THEN
    RAISE EXCEPTION 'issuance_live_protected: o modo do provedor nao muda depois de definido' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER issuance_requests_live_guard_trg BEFORE UPDATE OR DELETE ON issuance_requests FOR EACH ROW EXECUTE FUNCTION issuance_requests_live_guard();
