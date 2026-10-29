DROP INDEX "message_queue_one_uq";--> statement-breakpoint
ALTER TABLE "message_queue" ADD COLUMN "generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "message_queue_one_uq" ON "message_queue" USING btree ("company_id","charge_id","kind","channel","generation") WHERE "message_queue"."status" <> 'cancelado';--> statement-breakpoint
ALTER TABLE "message_queue" ADD CONSTRAINT "message_queue_generation_chk" CHECK ("message_queue"."generation" >= 0 and ("message_queue"."generation" = 0 or "message_queue"."kind" = 'emissao'));