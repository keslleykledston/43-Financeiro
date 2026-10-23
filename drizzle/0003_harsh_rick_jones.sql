CREATE TYPE "public"."doc_type" AS ENUM('cpf', 'cnpj');--> statement-breakpoint
CREATE TYPE "public"."party_kind" AS ENUM('cliente', 'fornecedor');--> statement-breakpoint
CREATE TABLE "parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" "party_kind" NOT NULL,
	"legal_name" text NOT NULL,
	"trade_name" text,
	"doc_type" "doc_type" NOT NULL,
	"document" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "party_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"is_financial" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_contacts" ADD CONSTRAINT "party_contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_contacts" ADD CONSTRAINT "party_contacts_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "parties_company_kind_doc_uq" ON "parties" USING btree ("company_id","kind","document") WHERE "parties"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "parties_company_name_idx" ON "parties" USING btree ("company_id","legal_name");--> statement-breakpoint
CREATE INDEX "party_contacts_party_idx" ON "party_contacts" USING btree ("company_id","party_id");