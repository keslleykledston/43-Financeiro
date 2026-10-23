ALTER TABLE "parties" ADD CONSTRAINT "parties_company_id_uq" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "party_contacts" DROP CONSTRAINT "party_contacts_party_id_parties_id_fk";--> statement-breakpoint
ALTER TABLE "party_contacts" ADD CONSTRAINT "party_contacts_company_id_party_id_parties_company_id_id_fk" FOREIGN KEY ("company_id","party_id") REFERENCES "public"."parties"("company_id","id") ON DELETE no action ON UPDATE no action;
