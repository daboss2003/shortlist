ALTER TABLE `companies` ADD `retention_days` integer DEFAULT 90;--> statement-breakpoint
ALTER TABLE `jobs` ADD `closed_at` integer;--> statement-breakpoint
UPDATE `jobs` SET `closed_at` = `updated_at` WHERE `status` = 'closed';
