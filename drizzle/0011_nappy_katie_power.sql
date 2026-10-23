ALTER TABLE "contract_versions" DROP CONSTRAINT "contract_versions_state_chk";--> statement-breakpoint
ALTER TABLE "contracts" DROP CONSTRAINT "contracts_amount_chk";--> statement-breakpoint
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_state_chk" CHECK ("contract_versions"."state" in ('pendente', 'aprovada', 'rejeitada', 'substituida'));--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_amount_chk" CHECK ("contracts"."monthly_amount" > 0 and "contracts"."monthly_amount" <= 99999999999.99);