ALTER TABLE "customers" ADD COLUMN "alias" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "issues_boleto" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "issues_invoice" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- cliente cujo contrato ativo/suspenso exige NF junto do boleto já nasce marcado como «emite nota fiscal» (só o cadastro; o comportamento do contrato não muda)
UPDATE "customers" SET "issues_invoice" = true WHERE EXISTS (SELECT 1 FROM "contracts" c WHERE c."company_id" = "customers"."company_id" AND c."customer_id" = "customers"."id" AND c."invoice_joint_required" AND c."status" IN ('ativo', 'suspenso'));--> statement-breakpoint
ALTER TABLE "customers" DROP CONSTRAINT "customers_extras_chk";--> statement-breakpoint
ALTER TABLE "customers" drop column "display_name";--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "display_name" text GENERATED ALWAYS AS (CASE WHEN coalesce(btrim(alias), '') <> '' THEN btrim(alias) WHEN legal_name ~* '^[0-9]{2}[.]?[0-9]{3}[.]?[0-9]{3}([/]?[0-9]{4}[-]?[0-9]{2})?( (ltda|s/?a|s[.]a[.]?|me|epp|eireli|slu))?[.]?$' AND coalesce(btrim(trade_name), '') <> '' THEN btrim(trade_name) ELSE legal_name END) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "public_name" text GENERATED ALWAYS AS (CASE WHEN legal_name ~* '^[0-9]{2}[.]?[0-9]{3}[.]?[0-9]{3}([/]?[0-9]{4}[-]?[0-9]{2})?( (ltda|s/?a|s[.]a[.]?|me|epp|eireli|slu))?[.]?$' AND coalesce(btrim(trade_name), '') <> '' THEN btrim(trade_name) ELSE legal_name END) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_extras_chk" CHECK (("customers"."cep" is null or "customers"."cep" ~ '^[0-9]{8}$') and ("customers"."city_ibge" is null or "customers"."city_ibge" ~ '^[0-9]{7}$') and ("customers"."uf" is null or "customers"."uf" ~ '^[A-Z]{2}$')
    and char_length("customers"."street") <= 160 and char_length("customers"."street_number") <= 20 and char_length("customers"."complement") <= 80 and char_length("customers"."district") <= 80 and char_length("customers"."city_name") <= 80
    and char_length("customers"."nf_text") <= 1000 and char_length("customers"."boleto_text") <= 400 and char_length("customers"."alias") <= 120);
