CREATE TABLE "profit_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"delinquency_bps" integer DEFAULT 300 NOT NULL,
	"unplanned_bps" integer DEFAULT 500 NOT NULL,
	"reserve_months" integer DEFAULT 2 NOT NULL,
	"retention_bps" integer DEFAULT 2000 NOT NULL,
	"cash_now" numeric(18, 2),
	"cash_as_of" date,
	"updated_by" uuid,
	CONSTRAINT "profit_settings_ranges_chk" CHECK ("profit_settings"."delinquency_bps" between 0 and 10000 and "profit_settings"."unplanned_bps" between 0 and 10000 and "profit_settings"."retention_bps" between 0 and 10000 and "profit_settings"."reserve_months" between 0 and 24),
	CONSTRAINT "profit_settings_cash_chk" CHECK (("profit_settings"."cash_now" is null) = ("profit_settings"."cash_as_of" is null) and ("profit_settings"."cash_now" is null or abs("profit_settings"."cash_now") <= 99999999999.99))
);
--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "planned_monthly" numeric(18, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "profit_settings" ADD CONSTRAINT "profit_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profit_settings" ADD CONSTRAINT "profit_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "profit_settings_company_uq" ON "profit_settings" USING btree ("company_id");--> statement-breakpoint
ALTER TABLE "partners" ADD CONSTRAINT "partners_planned_chk" CHECK ("partners"."planned_monthly" >= 0 and "partners"."planned_monthly" <= 99999999999.99);