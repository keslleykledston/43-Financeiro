ALTER TABLE "contract_versions" DROP CONSTRAINT "contract_versions_state_chk";--> statement-breakpoint
ALTER TABLE "contract_versions" ADD COLUMN "applied_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "contract_versions_one_scheduled_uq" ON "contract_versions" USING btree ("contract_id") WHERE "contract_versions"."state" = 'agendada';--> statement-breakpoint
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_state_chk" CHECK ("contract_versions"."state" in ('pendente', 'aprovada', 'rejeitada', 'substituida', 'agendada', 'cancelada'));