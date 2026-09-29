CREATE TABLE `calendar_external_sources_new` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`feed_url` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`poll_interval_min` integer DEFAULT 15 NOT NULL,
	`etag` text,
	`last_modified` text,
	`content_hash` text,
	`last_attempt_at` integer,
	`last_success_at` integer,
	`last_error_code` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`last_imported_count` integer DEFAULT 0 NOT NULL,
	`last_skipped_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `calendar_external_sources_id_check` CHECK(length(trim(`id`)) > 0),
	CONSTRAINT `calendar_external_sources_name_check` CHECK(length(trim(`name`)) > 0),
	CONSTRAINT `calendar_external_sources_provider_check` CHECK(`provider` IN ('google', 'microsoft', 'apple', 'ics_generic')),
	CONSTRAINT `calendar_external_sources_enabled_check` CHECK(`enabled` IN (0, 1)),
	CONSTRAINT `calendar_external_sources_poll_interval_check` CHECK(`poll_interval_min` BETWEEN 1 AND 1440),
	CONSTRAINT `calendar_external_sources_content_hash_check` CHECK(`content_hash` IS NULL OR (length(`content_hash`) = 64 AND `content_hash` NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT `calendar_external_sources_last_error_code_check` CHECK(`last_error_code` IS NULL OR `last_error_code` IN ('unsafe_url', 'unavailable', 'timeout', 'too_large', 'invalid_calendar', 'parse_failed', 'reconcile_failed')),
	CONSTRAINT `calendar_external_sources_consecutive_failures_check` CHECK(`consecutive_failures` >= 0),
	CONSTRAINT `calendar_external_sources_last_imported_count_check` CHECK(`last_imported_count` >= 0),
	CONSTRAINT `calendar_external_sources_last_skipped_count_check` CHECK(`last_skipped_count` >= 0)
) STRICT;
--> statement-breakpoint
INSERT INTO `calendar_external_sources_new` (
	`id`,
	`name`,
	`provider`,
	`feed_url`,
	`enabled`,
	`poll_interval_min`,
	`created_at`,
	`updated_at`
)
SELECT
	`id`,
	`name`,
	`provider`,
	`feed_url`,
	`enabled`,
	`poll_interval_min`,
	`created_at`,
	`updated_at`
FROM `calendar_external_sources`;
--> statement-breakpoint
DROP TABLE `calendar_external_sources`;
--> statement-breakpoint
ALTER TABLE `calendar_external_sources_new` RENAME TO `calendar_external_sources`;
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_external_sources_feed_url_unique` ON `calendar_external_sources` (`feed_url`);
--> statement-breakpoint
CREATE TABLE `calendar_external_event_meta` (
	`event_id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`external_uid` text NOT NULL,
	`recurrence_id` text DEFAULT '' NOT NULL,
	`description` text,
	`location` text,
	`status` text DEFAULT 'active' NOT NULL,
	`raw_hash` text NOT NULL,
	`source_updated_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `calendar_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `calendar_external_sources`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `calendar_external_event_meta_external_uid_check` CHECK(length(trim(`external_uid`)) > 0),
	CONSTRAINT `calendar_external_event_meta_status_check` CHECK(`status` IN ('active', 'cancelled')),
	CONSTRAINT `calendar_external_event_meta_raw_hash_check` CHECK(length(`raw_hash`) = 64 AND `raw_hash` NOT GLOB '*[^0-9a-f]*')
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_external_event_meta_identity_unique` ON `calendar_external_event_meta` (`source_id`, `external_uid`, `recurrence_id`);
--> statement-breakpoint
CREATE TABLE `calendar_highlight_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`emoji` text NOT NULL,
	`keywords_json` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`priority` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `calendar_highlight_rules_id_check` CHECK(length(trim(`id`)) > 0),
	CONSTRAINT `calendar_highlight_rules_emoji_check` CHECK(length(trim(`emoji`)) BETWEEN 1 AND 32),
	CONSTRAINT `calendar_highlight_rules_keywords_json_check` CHECK(json_valid(`keywords_json`) AND json_type(`keywords_json`) = 'array'),
	CONSTRAINT `calendar_highlight_rules_enabled_check` CHECK(`enabled` IN (0, 1)),
	CONSTRAINT `calendar_highlight_rules_priority_check` CHECK(`priority` >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_highlight_rules_priority_unique` ON `calendar_highlight_rules` (`priority`);
