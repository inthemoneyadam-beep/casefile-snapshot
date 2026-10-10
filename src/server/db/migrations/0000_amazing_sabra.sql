CREATE TABLE `ai_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`purpose` text NOT NULL,
	`model` text NOT NULL,
	`job_id` text,
	`document_ids_json` text DEFAULT '[]' NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`estimated_usd` real DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`error` text,
	`request_summary` text,
	`stop_reason` text
);
--> statement-breakpoint
CREATE INDEX `ai_calls_created_idx` ON `ai_calls` (`created_at`);--> statement-breakpoint
CREATE INDEX `ai_calls_purpose_idx` ON `ai_calls` (`purpose`);--> statement-breakpoint
CREATE TABLE `ask_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`refused` integer DEFAULT false NOT NULL,
	`retrieval_json` text DEFAULT '[]' NOT NULL,
	`ai_call_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ask_messages_session_idx` ON `ask_messages` (`session_id`);--> statement-breakpoint
CREATE TABLE `ask_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `citations` (
	`id` text PRIMARY KEY NOT NULL,
	`fact_id` text,
	`finding_id` text,
	`communication_id` text,
	`ask_message_id` text,
	`document_id` text NOT NULL,
	`page_number` integer NOT NULL,
	`quote` text NOT NULL,
	`char_start` integer,
	`char_end` integer,
	`verified` integer DEFAULT false NOT NULL,
	`match_kind` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `citations_fact_idx` ON `citations` (`fact_id`);--> statement-breakpoint
CREATE INDEX `citations_finding_idx` ON `citations` (`finding_id`);--> statement-breakpoint
CREATE INDEX `citations_doc_page_idx` ON `citations` (`document_id`,`page_number`);--> statement-breakpoint
CREATE TABLE `communication_participants` (
	`id` text PRIMARY KEY NOT NULL,
	`communication_id` text NOT NULL,
	`person_id` text NOT NULL,
	`role` text DEFAULT 'to' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `comm_participants_comm_idx` ON `communication_participants` (`communication_id`);--> statement-breakpoint
CREATE INDEX `comm_participants_person_idx` ON `communication_participants` (`person_id`);--> statement-breakpoint
CREATE TABLE `communication_topics` (
	`id` text PRIMARY KEY NOT NULL,
	`communication_id` text NOT NULL,
	`topic` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `comm_topics_comm_idx` ON `communication_topics` (`communication_id`);--> statement-breakpoint
CREATE INDEX `comm_topics_topic_idx` ON `communication_topics` (`topic`);--> statement-breakpoint
CREATE TABLE `communications` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` text,
	`occurred_at_precision` text DEFAULT 'day' NOT NULL,
	`occurred_at_text` text,
	`direction` text DEFAULT 'outbound' NOT NULL,
	`channel` text DEFAULT 'portal' NOT NULL,
	`subject` text NOT NULL,
	`summary` text,
	`outcome` text,
	`follow_up_promised` text,
	`follow_up_due` text,
	`follow_up_done_at` text,
	`follow_up_owner_person_id` text,
	`document_id` text,
	`encounter_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `communications_date_idx` ON `communications` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `communications_followup_idx` ON `communications` (`follow_up_due`);--> statement-breakpoint
CREATE TABLE `crossref_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`finished_at` text,
	`model` text,
	`deep` integer DEFAULT false NOT NULL,
	`scope_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`findings_count` integer DEFAULT 0 NOT NULL,
	`rules_count` integer DEFAULT 0 NOT NULL,
	`ai_call_ids_json` text DEFAULT '[]' NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `daily_log` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`sleep_hours` real,
	`sleep_quality` integer,
	`energy` integer,
	`notes` text,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_log_date_unique` ON `daily_log` (`date`);--> statement-breakpoint
CREATE TABLE `document_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`page_number` integer NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`ocr` integer DEFAULT false NOT NULL,
	`confidence` real,
	`width` real,
	`height` real,
	`char_count` integer DEFAULT 0 NOT NULL,
	`boxes_json` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_pages_doc_page_idx` ON `document_pages` (`document_id`,`page_number`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`filename` text NOT NULL,
	`mime` text NOT NULL,
	`kind` text NOT NULL,
	`category` text DEFAULT 'other' NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`storage_key` text NOT NULL,
	`institution_id` text,
	`author_person_id` text,
	`document_date` text,
	`document_date_precision` text DEFAULT 'unknown' NOT NULL,
	`document_date_text` text,
	`page_count` integer DEFAULT 0 NOT NULL,
	`text_status` text DEFAULT 'pending' NOT NULL,
	`text_error` text,
	`ocr_applied` integer DEFAULT false NOT NULL,
	`extraction_status` text DEFAULT 'none' NOT NULL,
	`extraction_schema_version` integer,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `documents_date_idx` ON `documents` (`document_date`);--> statement-breakpoint
CREATE INDEX `documents_category_idx` ON `documents` (`category`);--> statement-breakpoint
CREATE INDEX `documents_sha_idx` ON `documents` (`sha256`);--> statement-breakpoint
CREATE TABLE `encounters` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`kind` text DEFAULT 'visit' NOT NULL,
	`status` text DEFAULT 'upcoming' NOT NULL,
	`occurred_at` text,
	`occurred_at_precision` text DEFAULT 'day' NOT NULL,
	`occurred_at_text` text,
	`time_text` text,
	`clinician_id` text,
	`institution_id` text,
	`location` text,
	`prep_notes` text,
	`questions_json` text DEFAULT '[]' NOT NULL,
	`outcomes` text,
	`document_ids_json` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `encounters_date_idx` ON `encounters` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `encounters_status_idx` ON `encounters` (`status`);--> statement-breakpoint
CREATE TABLE `export_packets` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`config_json` text DEFAULT '{}' NOT NULL,
	`storage_key` text,
	`size_bytes` integer,
	`page_count` integer,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE TABLE `extraction_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`schema_version` integer NOT NULL,
	`model` text NOT NULL,
	`deep` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`finished_at` text,
	`facts_count` integer DEFAULT 0 NOT NULL,
	`merges_proposed` integer DEFAULT 0 NOT NULL,
	`chunks` integer DEFAULT 0 NOT NULL,
	`ai_call_ids_json` text DEFAULT '[]' NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `extraction_runs_doc_idx` ON `extraction_runs` (`document_id`);--> statement-breakpoint
CREATE TABLE `fact_merges` (
	`id` text PRIMARY KEY NOT NULL,
	`fact_id_a` text NOT NULL,
	`fact_id_b` text NOT NULL,
	`reason` text NOT NULL,
	`similarity` real DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fact_merges_pair_idx` ON `fact_merges` (`fact_id_a`,`fact_id_b`);--> statement-breakpoint
CREATE INDEX `fact_merges_status_idx` ON `fact_merges` (`status`);--> statement-breakpoint
CREATE TABLE `facts` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`statement` text NOT NULL,
	`date` text,
	`date_precision` text DEFAULT 'unknown' NOT NULL,
	`date_text` text,
	`date_end` text,
	`attributes_json` text DEFAULT '{}' NOT NULL,
	`confidence` real DEFAULT 0.5 NOT NULL,
	`status` text DEFAULT 'unverified' NOT NULL,
	`superseded_by_id` text,
	`verdict_note` text,
	`verdict_at` text,
	`origin` text DEFAULT 'ai' NOT NULL,
	`source_document_id` text,
	`extraction_run_id` text,
	`dedup_key` text,
	`subject_key` text,
	`person_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `facts_type_idx` ON `facts` (`type`);--> statement-breakpoint
CREATE INDEX `facts_date_idx` ON `facts` (`date`);--> statement-breakpoint
CREATE INDEX `facts_status_idx` ON `facts` (`status`);--> statement-breakpoint
CREATE INDEX `facts_doc_idx` ON `facts` (`source_document_id`);--> statement-breakpoint
CREATE INDEX `facts_dedup_idx` ON `facts` (`dedup_key`);--> statement-breakpoint
CREATE INDEX `facts_subject_idx` ON `facts` (`subject_key`);--> statement-breakpoint
CREATE TABLE `finding_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`finding_id` text NOT NULL,
	`fact_id` text,
	`document_id` text,
	`citation_id` text,
	`communication_id` text,
	`lab_result_id` text,
	`note` text,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `finding_evidence_finding_idx` ON `finding_evidence` (`finding_id`);--> statement-breakpoint
CREATE INDEX `finding_evidence_fact_idx` ON `finding_evidence` (`fact_id`);--> statement-breakpoint
CREATE TABLE `findings` (
	`id` text PRIMARY KEY NOT NULL,
	`category` text NOT NULL,
	`title` text NOT NULL,
	`why_it_matters` text NOT NULL,
	`detail` text,
	`severity` text DEFAULT 'medium' NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`verdict_note` text,
	`verdict_at` text,
	`origin` text DEFAULT 'ai' NOT NULL,
	`rule_id` text,
	`fingerprint` text,
	`run_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `findings_category_idx` ON `findings` (`category`);--> statement-breakpoint
CREATE INDEX `findings_status_idx` ON `findings` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `findings_fingerprint_idx` ON `findings` (`fingerprint`);--> statement-breakpoint
CREATE TABLE `imaging_studies` (
	`id` text PRIMARY KEY NOT NULL,
	`modality` text DEFAULT 'other' NOT NULL,
	`body_part` text,
	`title` text NOT NULL,
	`performed_at` text,
	`performed_at_precision` text DEFAULT 'unknown' NOT NULL,
	`performed_at_text` text,
	`institution_id` text,
	`impression` text,
	`findings` text,
	`contrast` text,
	`document_id` text,
	`fact_id` text,
	`has_images` integer DEFAULT false NOT NULL,
	`dicom_document_ids_json` text DEFAULT '[]' NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `imaging_date_idx` ON `imaging_studies` (`performed_at`);--> statement-breakpoint
CREATE INDEX `imaging_modality_idx` ON `imaging_studies` (`modality`);--> statement-breakpoint
CREATE TABLE `intolerances` (
	`id` text PRIMARY KEY NOT NULL,
	`substance` text NOT NULL,
	`kind` text DEFAULT 'intolerance' NOT NULL,
	`reaction` text,
	`severity` text DEFAULT 'unknown' NOT NULL,
	`hard_stop` integer DEFAULT false NOT NULL,
	`date` text,
	`date_precision` text DEFAULT 'unknown' NOT NULL,
	`date_text` text,
	`notes` text,
	`source_fact_id` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `intolerances_hard_idx` ON `intolerances` (`hard_stop`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`lane` text DEFAULT 'ingest' NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 2 NOT NULL,
	`progress` real DEFAULT 0 NOT NULL,
	`progress_text` text,
	`error` text,
	`result_json` text,
	`document_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`started_at` text,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`,`lane`,`priority`);--> statement-breakpoint
CREATE INDEX `jobs_document_idx` ON `jobs` (`document_id`);--> statement-breakpoint
CREATE TABLE `lab_results` (
	`id` text PRIMARY KEY NOT NULL,
	`analyte` text NOT NULL,
	`analyte_key` text NOT NULL,
	`value_num` real,
	`value_text` text,
	`unit` text,
	`ref_low` real,
	`ref_high` real,
	`ref_text` text,
	`flag` text,
	`specimen` text DEFAULT 'serum' NOT NULL,
	`collected_at` text,
	`collected_at_precision` text DEFAULT 'unknown' NOT NULL,
	`collected_at_text` text,
	`lab_name` text,
	`institution_id` text,
	`document_id` text,
	`fact_id` text,
	`notes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `lab_results_key_idx` ON `lab_results` (`analyte_key`,`specimen`);--> statement-breakpoint
CREATE INDEX `lab_results_date_idx` ON `lab_results` (`collected_at`);--> statement-breakpoint
CREATE INDEX `lab_results_fact_idx` ON `lab_results` (`fact_id`);--> statement-breakpoint
CREATE TABLE `medication_events` (
	`id` text PRIMARY KEY NOT NULL,
	`medication_id` text NOT NULL,
	`kind` text NOT NULL,
	`date` text,
	`date_precision` text DEFAULT 'day' NOT NULL,
	`date_text` text,
	`detail` text,
	`dose` text,
	`source_fact_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `medication_events_med_idx` ON `medication_events` (`medication_id`);--> statement-breakpoint
CREATE INDEX `medication_events_date_idx` ON `medication_events` (`date`);--> statement-breakpoint
CREATE TABLE `medications` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`generic_name` text,
	`drug_class` text,
	`dose` text,
	`unit` text,
	`route` text,
	`frequency` text,
	`status` text DEFAULT 'unknown' NOT NULL,
	`start_date` text,
	`start_date_precision` text DEFAULT 'unknown' NOT NULL,
	`start_date_text` text,
	`stop_date` text,
	`stop_date_precision` text DEFAULT 'unknown' NOT NULL,
	`stop_date_text` text,
	`prescriber_id` text,
	`indication` text,
	`reason_stopped` text,
	`effect` text,
	`notes` text,
	`source_fact_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `medications_status_idx` ON `medications` (`status`);--> statement-breakpoint
CREATE INDEX `medications_name_idx` ON `medications` (`name`);--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'clinician' NOT NULL,
	`role` text,
	`specialty` text,
	`institution_id` text,
	`phone` text,
	`fax` text,
	`email` text,
	`portal` text,
	`address` text,
	`preferred_channel` text,
	`notes` text,
	`aliases_json` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `people_kind_idx` ON `people` (`kind`);--> statement-breakpoint
CREATE INDEX `people_name_idx` ON `people` (`name`);--> statement-breakpoint
CREATE TABLE `records_inventory` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`record_type` text DEFAULT 'other' NOT NULL,
	`institution_id` text,
	`system` text,
	`format` text DEFAULT 'unknown' NOT NULL,
	`held` integer DEFAULT false NOT NULL,
	`held_form` text,
	`document_id` text,
	`status` text DEFAULT 'unknown' NOT NULL,
	`record_date` text,
	`record_date_precision` text DEFAULT 'unknown' NOT NULL,
	`record_date_text` text,
	`requested_at` text,
	`received_at` text,
	`expected_by` text,
	`source_fact_id` text,
	`notes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `records_status_idx` ON `records_inventory` (`status`);--> statement-breakpoint
CREATE INDEX `records_type_idx` ON `records_inventory` (`record_type`);--> statement-breakpoint
CREATE INDEX `records_fact_idx` ON `records_inventory` (`source_fact_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `symptom_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `symptom_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`symptom_id` text NOT NULL,
	`score` integer NOT NULL,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `symptom_entries_day_idx` ON `symptom_entries` (`date`,`symptom_id`);--> statement-breakpoint
CREATE INDEX `symptom_entries_date_idx` ON `symptom_entries` (`date`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`detail` text,
	`owner` text DEFAULT 'me' NOT NULL,
	`owner_person_id` text,
	`due_at` text,
	`remind_at` text,
	`status` text DEFAULT 'open' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`source_type` text DEFAULT 'manual' NOT NULL,
	`source_id` text,
	`completed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `tasks_status_due_idx` ON `tasks` (`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `tasks_source_idx` ON `tasks` (`source_type`,`source_id`);