CREATE TABLE `filings` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`action` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`source` text DEFAULT 'auto' NOT NULL,
	`summary` text NOT NULL,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`ask_message_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`decided_at` text,
	`decided_by` text
);
--> statement-breakpoint
CREATE INDEX `filings_status_type_idx` ON `filings` (`status`,`target_type`);--> statement-breakpoint
CREATE INDEX `filings_target_idx` ON `filings` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `filings_document_idx` ON `filings` (`document_id`);