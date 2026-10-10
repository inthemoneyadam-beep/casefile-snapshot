CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`user_id` text,
	`user_name` text,
	`action` text NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`summary` text
);
--> statement-breakpoint
CREATE INDEX `audit_log_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE INDEX `audit_log_user_idx` ON `audit_log` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT 'viewer' NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_login_at` text
);
--> statement-breakpoint
ALTER TABLE `documents` ADD `source_tier` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `author_role` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `title_source` text DEFAULT 'filename' NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `brief_json` text;--> statement-breakpoint
ALTER TABLE `facts` ADD `asserted_by` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `facts` ADD `objectivity` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `facts` ADD `overridden_by_fact_id` text;--> statement-breakpoint
ALTER TABLE `facts` ADD `override_reason` text;--> statement-breakpoint
ALTER TABLE `medication_events` ADD `deleted_at` text;