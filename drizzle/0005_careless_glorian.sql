CREATE TABLE "customer_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"is_financial" boolean DEFAULT false NOT NULL,
	"customer_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"legal_name" text NOT NULL,
	"trade_name" text,
	"doc_type" "doc_type" NOT NULL,
	"document" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	"source" text DEFAULT 'manual' NOT NULL,
	"external_id" text,
	"external_synced_at" timestamp with time zone,
	CONSTRAINT "customers_company_id_uq" UNIQUE("company_id","id")
);
--> statement-breakpoint
CREATE TABLE "vendor_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"is_financial" boolean DEFAULT false NOT NULL,
	"vendor_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"legal_name" text NOT NULL,
	"trade_name" text,
	"doc_type" "doc_type" NOT NULL,
	"document" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	"source" text DEFAULT 'manual' NOT NULL,
	"external_id" text,
	"external_synced_at" timestamp with time zone,
	CONSTRAINT "vendors_company_id_uq" UNIQUE("company_id","id")
);
--> statement-breakpoint
-- Preserva dados existentes (mesmos IDs, para os contatos continuarem ligados)
INSERT INTO "customers" ("id","created_at","updated_at","company_id","legal_name","trade_name","doc_type","document","archived_at","created_by")
  SELECT "id","created_at","updated_at","company_id","legal_name","trade_name","doc_type","document","archived_at","created_by" FROM "parties" WHERE "kind" = 'cliente';--> statement-breakpoint
INSERT INTO "vendors" ("id","created_at","updated_at","company_id","legal_name","trade_name","doc_type","document","archived_at","created_by")
  SELECT "id","created_at","updated_at","company_id","legal_name","trade_name","doc_type","document","archived_at","created_by" FROM "parties" WHERE "kind" = 'fornecedor';--> statement-breakpoint
INSERT INTO "customer_contacts" ("id","created_at","updated_at","company_id","name","email","phone","is_financial","customer_id")
  SELECT c."id",c."created_at",c."updated_at",c."company_id",c."name",c."email",c."phone",c."is_financial",c."party_id" FROM "party_contacts" c JOIN "parties" p ON p."id" = c."party_id" WHERE p."kind" = 'cliente';--> statement-breakpoint
INSERT INTO "vendor_contacts" ("id","created_at","updated_at","company_id","name","email","phone","is_financial","vendor_id")
  SELECT c."id",c."created_at",c."updated_at",c."company_id",c."name",c."email",c."phone",c."is_financial",c."party_id" FROM "party_contacts" c JOIN "parties" p ON p."id" = c."party_id" WHERE p."kind" = 'fornecedor';--> statement-breakpoint
DROP TABLE "parties" CASCADE;--> statement-breakpoint
DROP TABLE "party_contacts" CASCADE;--> statement-breakpoint
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_company_id_customer_id_customers_company_id_id_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."customers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_contacts" ADD CONSTRAINT "vendor_contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_contacts" ADD CONSTRAINT "vendor_contacts_company_id_vendor_id_vendors_company_id_id_fk" FOREIGN KEY ("company_id","vendor_id") REFERENCES "public"."vendors"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_contacts_customer_idx" ON "customer_contacts" USING btree ("company_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_company_doc_uq" ON "customers" USING btree ("company_id","document") WHERE "customers"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_company_source_ext_uq" ON "customers" USING btree ("company_id","source","external_id") WHERE "customers"."external_id" is not null;--> statement-breakpoint
CREATE INDEX "customers_company_name_idx" ON "customers" USING btree ("company_id","legal_name");--> statement-breakpoint
CREATE INDEX "vendor_contacts_vendor_idx" ON "vendor_contacts" USING btree ("company_id","vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendors_company_doc_uq" ON "vendors" USING btree ("company_id","document") WHERE "vendors"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "vendors_company_source_ext_uq" ON "vendors" USING btree ("company_id","source","external_id") WHERE "vendors"."external_id" is not null;--> statement-breakpoint
CREATE INDEX "vendors_company_name_idx" ON "vendors" USING btree ("company_id","legal_name");--> statement-breakpoint
DROP TYPE "public"."party_kind";