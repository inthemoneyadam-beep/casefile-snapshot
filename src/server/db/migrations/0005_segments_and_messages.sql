CREATE TABLE `document_segments` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`seq` integer NOT NULL,
	`page_start` integer NOT NULL,
	`page_end` integer NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`header_text` text,
	`encounter_date` text,
	`encounter_date_precision` text DEFAULT 'unknown' NOT NULL,
	`encounter_date_text` text,
	`encounter_type` text,
	`department` text,
	`encounter_number` text,
	`source_tier` text,
	`text_hash` text,
	`duplicate_of_segment_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`skip_reason` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`extraction_run_id` text,
	`schema_version` integer,
	`facts_count` integer DEFAULT 0 NOT NULL,
	`messages_count` integer DEFAULT 0 NOT NULL,
	`encounter_id` text,
	`record_id` text,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`superseded_at` text
);
--> statement-breakpoint
CREATE INDEX `document_segments_doc_idx` ON `document_segments` (`document_id`,`seq`);--> statement-breakpoint
CREATE INDEX `document_segments_status_idx` ON `document_segments` (`document_id`,`status`);--> statement-breakpoint
CREATE INDEX `document_segments_hash_idx` ON `document_segments` (`text_hash`);--> statement-breakpoint
ALTER TABLE `communications` ADD `body` text;--> statement-breakpoint
ALTER TABLE `communications` ADD `thread_key` text;--> statement-breakpoint
ALTER TABLE `communications` ADD `external_key` text;--> statement-breakpoint
ALTER TABLE `communications` ADD `occurred_time` text;--> statement-breakpoint
ALTER TABLE `communications` ADD `details_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE INDEX `communications_thread_idx` ON `communications` (`thread_key`);--> statement-breakpoint
CREATE INDEX `communications_external_idx` ON `communications` (`external_key`);