CREATE TABLE `care_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text,
	`name` text NOT NULL,
	`practice` text,
	`city` text,
	`state` text,
	`phone` text,
	`website` text,
	`licensed_states_json` text DEFAULT '[]' NOT NULL,
	`role` text,
	`status` text DEFAULT 'found' NOT NULL,
	`review` text DEFAULT 'accepted' NOT NULL,
	`notes` text,
	`flare_test_json` text DEFAULT '{}' NOT NULL,
	`sources_json` text DEFAULT '{}' NOT NULL,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `care_candidates_status_idx` ON `care_candidates` (`review`,`status`);--> statement-breakpoint
CREATE INDEX `care_candidates_person_idx` ON `care_candidates` (`person_id`);--> statement-breakpoint
CREATE TABLE `plan_items` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`parent_id` text,
	`seq` integer DEFAULT 0 NOT NULL,
	`kind` text DEFAULT 'step' NOT NULL,
	`title` text NOT NULL,
	`detail` text,
	`owner` text,
	`due` text,
	`due_precision` text DEFAULT 'unknown' NOT NULL,
	`due_text` text,
	`condition` text,
	`status` text DEFAULT 'open' NOT NULL,
	`done_at` text,
	`done_by` text,
	`note` text,
	`task_id` text,
	`citations_json` text DEFAULT '[]' NOT NULL,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `plan_items_plan_idx` ON `plan_items` (`plan_id`,`seq`);--> statement-breakpoint
CREATE INDEX `plan_items_task_idx` ON `plan_items` (`task_id`);--> statement-breakpoint
CREATE TABLE `plans` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text,
	`title` text NOT NULL,
	`status` text DEFAULT 'current' NOT NULL,
	`summary` text,
	`framework_json` text DEFAULT '{}' NOT NULL,
	`plan_date` text,
	`plan_date_precision` text DEFAULT 'unknown' NOT NULL,
	`plan_date_text` text,
	`extraction_run_id` text,
	`schema_version` integer,
	`created_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `plans_status_idx` ON `plans` (`status`);--> statement-breakpoint
CREATE INDEX `plans_document_idx` ON `plans` (`document_id`);