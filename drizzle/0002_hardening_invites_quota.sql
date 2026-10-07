CREATE TABLE `ai_usage` (
	`company_id` text NOT NULL,
	`day` text NOT NULL,
	`analyses` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`company_id`, `day`),
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`email` text,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`used_by_user_id` text,
	`revoked_at` integer,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`used_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_token_hash_unique` ON `invites` (`token_hash`);--> statement-breakpoint
ALTER TABLE `candidates` ADD `cv_sha256` text;--> statement-breakpoint
ALTER TABLE `candidates` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `candidates_upload_job_sha_uq` ON `candidates` (`job_id`,`cv_sha256`) WHERE source = 'upload';--> statement-breakpoint
ALTER TABLE `users` ADD `is_platform_admin` integer DEFAULT false NOT NULL;