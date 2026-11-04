ALTER TABLE "email_accounts" ADD COLUMN "system_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "email_accounts" ADD COLUMN "system_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_accounts" ADD COLUMN "system_enabled_by" uuid;--> statement-breakpoint
ALTER TABLE "email_accounts" ADD CONSTRAINT "email_accounts_system_enabled_by_users_id_fk" FOREIGN KEY ("system_enabled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;