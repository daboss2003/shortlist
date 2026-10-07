CREATE TABLE `candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`company_id` text NOT NULL,
	`source` text NOT NULL,
	`name` text,
	`email` text,
	`phone` text,
	`cv_file_key` text NOT NULL,
	`cv_file_name` text NOT NULL,
	`cv_mime_type` text NOT NULL,
	`cv_size` integer NOT NULL,
	`cv_text` text,
	`profile` text,
	`evaluation` text,
	`score` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`ai_provider` text,
	`ai_model` text,
	`stage` text DEFAULT 'new' NOT NULL,
	`created_at` integer NOT NULL,
	`processed_at` integer,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `candidates_job_score_idx` ON `candidates` (`job_id`,`score`);--> statement-breakpoint
CREATE INDEX `candidates_company_idx` ON `candidates` (`company_id`);--> statement-breakpoint
CREATE INDEX `candidates_status_idx` ON `candidates` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `candidates_public_job_email_uq` ON `candidates` (`job_id`,`email`) WHERE source = 'public';--> statement-breakpoint
CREATE TABLE `companies` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`website` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`department` text,
	`location` text,
	`employment_type` text,
	`description` text NOT NULL,
	`requirements` text DEFAULT '' NOT NULL,
	`skills` text DEFAULT '[]' NOT NULL,
	`min_experience_years` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_slug_unique` ON `jobs` (`slug`);--> statement-breakpoint
CREATE INDEX `jobs_company_idx` ON `jobs` (`company_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);