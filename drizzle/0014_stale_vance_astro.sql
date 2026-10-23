CREATE TABLE "messaging_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"auto_dispatch" boolean DEFAULT false NOT NULL,
	"email_enabled" boolean DEFAULT true NOT NULL,
	"whatsapp_enabled" boolean DEFAULT false NOT NULL,
	"window_start" text DEFAULT '09:00' NOT NULL,
	"window_end" text DEFAULT '18:00' NOT NULL,
	"weekdays" integer[] DEFAULT '{1,2,3,4,5}'::integer[] NOT NULL,
	"skip_holidays" boolean DEFAULT true NOT NULL,
	"max_per_run" integer DEFAULT 50 NOT NULL,
	"max_per_hour" integer DEFAULT 30 NOT NULL,
	"max_late_days" integer DEFAULT 2 NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "messaging_settings_company_uq" UNIQUE("company_id"),
	CONSTRAINT "messaging_settings_window_chk" CHECK ("messaging_settings"."window_start" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and "messaging_settings"."window_end" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and "messaging_settings"."window_start" < "messaging_settings"."window_end"),
	CONSTRAINT "messaging_settings_limits_chk" CHECK ("messaging_settings"."max_per_run" between 1 and 500 and "messaging_settings"."max_per_hour" between 1 and 2000 and "messaging_settings"."max_late_days" between 0 and 30),
	CONSTRAINT "messaging_settings_weekdays_chk" CHECK (cardinality("messaging_settings"."weekdays") between 1 and 7 and "messaging_settings"."weekdays" <@ array[0,1,2,3,4,5,6])
);
--> statement-breakpoint
ALTER TABLE "message_queue" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "message_queue" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "message_queue" ADD COLUMN "provider_ref" text;--> statement-breakpoint
ALTER TABLE "messaging_settings" ADD CONSTRAINT "messaging_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_settings" ADD CONSTRAINT "messaging_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;