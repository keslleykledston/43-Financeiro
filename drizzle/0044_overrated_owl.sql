ALTER TABLE "boleto_cancellations" DROP CONSTRAINT "boleto_cancellations_mode_chk";--> statement-breakpoint
ALTER TABLE "issuance_requests" DROP CONSTRAINT "issuance_requests_mode_chk";--> statement-breakpoint
ALTER TABLE "issuance_settings" DROP CONSTRAINT "issuance_settings_provider_chk";--> statement-breakpoint
ALTER TABLE "issuance_settings" ADD COLUMN "live_authorized_by" uuid;--> statement-breakpoint
ALTER TABLE "issuance_settings" ADD COLUMN "live_authorized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issuance_settings" ADD COLUMN "live_canary" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "issuance_settings" ADD CONSTRAINT "issuance_settings_live_authorized_by_users_id_fk" FOREIGN KEY ("live_authorized_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boleto_cancellations" ADD CONSTRAINT "boleto_cancellations_mode_chk" CHECK ("boleto_cancellations"."mode" in ('simulado', 'cora_homologacao', 'cora_producao'));--> statement-breakpoint
ALTER TABLE "issuance_requests" ADD CONSTRAINT "issuance_requests_mode_chk" CHECK ("issuance_requests"."mode" in ('simulado', 'cora_homologacao', 'cora_producao'));--> statement-breakpoint
ALTER TABLE "issuance_settings" ADD CONSTRAINT "issuance_settings_live_auth_chk" CHECK ("issuance_settings"."boleto_provider" <> 'cora_producao' or ("issuance_settings"."live_authorized_by" is not null and "issuance_settings"."live_authorized_at" is not null));--> statement-breakpoint
ALTER TABLE "issuance_settings" ADD CONSTRAINT "issuance_settings_provider_chk" CHECK ("issuance_settings"."boleto_provider" in ('simulado', 'cora_homologacao', 'cora_producao'));