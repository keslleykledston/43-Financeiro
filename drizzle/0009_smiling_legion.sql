ALTER TABLE "customers" ADD COLUMN "status" text DEFAULT 'ativo' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "status" text DEFAULT 'ativo' NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_status_chk" CHECK ("customers"."status" in ('ativo', 'suspenso', 'cancelado'));--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_status_chk" CHECK ("vendors"."status" in ('ativo', 'suspenso', 'cancelado'));