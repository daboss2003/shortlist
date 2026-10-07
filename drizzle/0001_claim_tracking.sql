DROP INDEX "candidates_status_idx";--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "claim_token" text;--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "candidates_status_idx" ON "candidates" USING btree ("status","claimed_at");