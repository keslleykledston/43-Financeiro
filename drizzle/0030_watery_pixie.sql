ALTER TABLE "customers" ADD COLUMN "cep" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "street" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "street_number" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "complement" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "district" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "city_name" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "city_ibge" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "uf" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "nf_text" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "boleto_text" text;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_extras_chk" CHECK (("customers"."cep" is null or "customers"."cep" ~ '^[0-9]{8}$') and ("customers"."city_ibge" is null or "customers"."city_ibge" ~ '^[0-9]{7}$') and ("customers"."uf" is null or "customers"."uf" ~ '^[A-Z]{2}$')
    and char_length("customers"."street") <= 160 and char_length("customers"."street_number") <= 20 and char_length("customers"."complement") <= 80 and char_length("customers"."district") <= 80 and char_length("customers"."city_name") <= 80
    and char_length("customers"."nf_text") <= 1000 and char_length("customers"."boleto_text") <= 400);