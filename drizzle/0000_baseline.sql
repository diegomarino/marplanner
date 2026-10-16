-- MarPlanner v2 database baseline: the one and only migration (squashed 2026-10-16).
--
-- Everything above the "Hand additions" marker is verbatim `drizzle-kit generate` output for
-- src/server/db/schema.ts, except `STRICT` appended to calendar_external_sources,
-- calendar_external_event_meta and calendar_highlight_rules (drizzle-kit cannot express STRICT).
-- tests/integration/database-baseline.test.ts proves the file is equivalent to a clean
-- generation. To regenerate after a schema change, run drizzle-kit generate with
-- `out` pointing at a scratch directory, replace the generated part, and re-apply STRICT.
--
-- Databases and backups created before the squash (ledger holding 0000_current_baseline.sql
-- and 0001..0005) are unsupported: the runner refuses them and restore reports unsupported
-- lineage.
CREATE TABLE `admin_config` (
	`id` integer PRIMARY KEY NOT NULL,
	`pin_hash` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "admin_config_id_check" CHECK("admin_config"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`key_hash` text NOT NULL,
	`scope` text DEFAULT '*' NOT NULL,
	`kind` text NOT NULL,
	`label` text,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	CONSTRAINT "api_keys_kind_check" CHECK("api_keys"."kind" IN ('device', 'integration', 'bootstrap'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `calendar_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`member_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `calendar_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_assignments_unique_event_member` ON `calendar_assignments` (`event_id`,`member_id`);--> statement-breakpoint
CREATE TABLE `calendar_events` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`title` text NOT NULL,
	`all_day` integer NOT NULL,
	`start_date` text,
	`end_date` text,
	`start_utc` text,
	`end_utc` text,
	`tzid` text,
	`rrule` text,
	`exdates` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`description` text,
	`location` text,
	CONSTRAINT "calendar_events_source_check" CHECK("calendar_events"."source" IN ('local', 'external')),
	CONSTRAINT "calendar_events_all_day_check" CHECK("calendar_events"."all_day" IN (0, 1)),
	CONSTRAINT "calendar_events_dates_check" CHECK((
        (
          "calendar_events"."all_day" = 1
          AND "calendar_events"."start_date" IS NOT NULL
          AND "calendar_events"."end_date" IS NOT NULL
          AND "calendar_events"."start_utc" IS NULL
          AND "calendar_events"."end_utc" IS NULL
          AND "calendar_events"."tzid" IS NULL
        )
        OR (
          "calendar_events"."all_day" = 0
          AND "calendar_events"."start_date" IS NULL
          AND "calendar_events"."end_date" IS NULL
          AND "calendar_events"."start_utc" IS NOT NULL
          AND "calendar_events"."end_utc" IS NOT NULL
          AND "calendar_events"."tzid" IS NOT NULL
        )
      ))
);
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
	CONSTRAINT "calendar_external_event_meta_external_uid_check" CHECK(length(trim("calendar_external_event_meta"."external_uid")) > 0),
	CONSTRAINT "calendar_external_event_meta_status_check" CHECK("calendar_external_event_meta"."status" IN ('active', 'cancelled')),
	CONSTRAINT "calendar_external_event_meta_raw_hash_check" CHECK(length("calendar_external_event_meta"."raw_hash") = 64 AND "calendar_external_event_meta"."raw_hash" NOT GLOB '*[^0-9a-f]*')
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_external_event_meta_identity_unique` ON `calendar_external_event_meta` (`source_id`,`external_uid`,`recurrence_id`);--> statement-breakpoint
CREATE TABLE `calendar_external_sources` (
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
	CONSTRAINT "calendar_external_sources_id_check" CHECK(length(trim("calendar_external_sources"."id")) > 0),
	CONSTRAINT "calendar_external_sources_name_check" CHECK(length(trim("calendar_external_sources"."name")) > 0),
	CONSTRAINT "calendar_external_sources_provider_check" CHECK("calendar_external_sources"."provider" IN ('google', 'microsoft', 'apple', 'ics_generic')),
	CONSTRAINT "calendar_external_sources_enabled_check" CHECK("calendar_external_sources"."enabled" IN (0, 1)),
	CONSTRAINT "calendar_external_sources_poll_interval_check" CHECK("calendar_external_sources"."poll_interval_min" BETWEEN 1 AND 1440),
	CONSTRAINT "calendar_external_sources_content_hash_check" CHECK("calendar_external_sources"."content_hash" IS NULL OR (length("calendar_external_sources"."content_hash") = 64 AND "calendar_external_sources"."content_hash" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "calendar_external_sources_last_error_code_check" CHECK("calendar_external_sources"."last_error_code" IS NULL OR "calendar_external_sources"."last_error_code" IN ('unsafe_url', 'unavailable', 'timeout', 'too_large', 'invalid_calendar', 'parse_failed', 'reconcile_failed')),
	CONSTRAINT "calendar_external_sources_consecutive_failures_check" CHECK("calendar_external_sources"."consecutive_failures" >= 0),
	CONSTRAINT "calendar_external_sources_last_imported_count_check" CHECK("calendar_external_sources"."last_imported_count" >= 0),
	CONSTRAINT "calendar_external_sources_last_skipped_count_check" CHECK("calendar_external_sources"."last_skipped_count" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_external_sources_feed_url_unique` ON `calendar_external_sources` (`feed_url`);--> statement-breakpoint
CREATE TABLE `calendar_highlight_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`emoji` text NOT NULL,
	`keywords_json` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`priority` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "calendar_highlight_rules_id_check" CHECK(length(trim("calendar_highlight_rules"."id")) > 0),
	CONSTRAINT "calendar_highlight_rules_emoji_check" CHECK(length(trim("calendar_highlight_rules"."emoji")) BETWEEN 1 AND 32),
	CONSTRAINT "calendar_highlight_rules_keywords_json_check" CHECK(json_valid("calendar_highlight_rules"."keywords_json") AND json_type("calendar_highlight_rules"."keywords_json") = 'array'),
	CONSTRAINT "calendar_highlight_rules_enabled_check" CHECK("calendar_highlight_rules"."enabled" IN (0, 1)),
	CONSTRAINT "calendar_highlight_rules_priority_check" CHECK("calendar_highlight_rules"."priority" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_highlight_rules_priority_unique` ON `calendar_highlight_rules` (`priority`);--> statement-breakpoint
CREATE TABLE `chore_completions` (
	`id` text PRIMARY KEY NOT NULL,
	`chore_id` text NOT NULL,
	`member_id` text NOT NULL,
	`date` text NOT NULL,
	`completed_at` integer NOT NULL,
	FOREIGN KEY (`chore_id`) REFERENCES `chores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chore_completions_unique_member_chore_date` ON `chore_completions` (`member_id`,`chore_id`,`date`);--> statement-breakpoint
CREATE TABLE `chores` (
	`id` text PRIMARY KEY NOT NULL,
	`routine_id` text NOT NULL,
	`name` text NOT NULL,
	`icon` text,
	`sort_order` integer NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`routine_id`) REFERENCES `routines`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chores_active_check" CHECK("chores"."active" IN (0, 1)),
	CONSTRAINT "chores_sort_order_check" CHECK("chores"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE `client_log` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`event_time` integer,
	`received_at` integer NOT NULL,
	`level` text NOT NULL,
	`component` text NOT NULL,
	`message` text NOT NULL,
	`data` text,
	CONSTRAINT "client_log_level_check" CHECK("client_log"."level" IN ('debug', 'info', 'warn', 'error'))
);
--> statement-breakpoint
CREATE INDEX `client_log_received_at_idx` ON `client_log` (`received_at`);--> statement-breakpoint
CREATE INDEX `client_log_component_idx` ON `client_log` (`component`);--> statement-breakpoint
CREATE TABLE `daily_briefing_block_cache` (
	`date` text NOT NULL,
	`block_type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_briefing_block_cache_pk` ON `daily_briefing_block_cache` (`date`,`block_type`);--> statement-breakpoint
CREATE TABLE `daily_briefing_block_order` (
	`id` integer PRIMARY KEY NOT NULL,
	`order_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "daily_briefing_block_order_single_row_check" CHECK("daily_briefing_block_order"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `daily_briefing_member_block_settings` (
	`member_id` text NOT NULL,
	`block_type` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`weekdays` text,
	`params` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "daily_briefing_member_block_settings_enabled_check" CHECK("daily_briefing_member_block_settings"."enabled" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_briefing_member_block_settings_pk` ON `daily_briefing_member_block_settings` (`member_id`,`block_type`);--> statement-breakpoint
CREATE TABLE `daily_briefing_optin` (
	`member_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`weekdays` text,
	CONSTRAINT "daily_briefing_optin_enabled_check" CHECK("daily_briefing_optin"."enabled" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `daily_briefing_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`generation_time` text DEFAULT '06:00' NOT NULL,
	`auto_print_trigger` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT "daily_briefing_settings_single_row_check" CHECK("daily_briefing_settings"."id" = 1),
	CONSTRAINT "daily_briefing_settings_auto_print_trigger_check" CHECK("daily_briefing_settings"."auto_print_trigger" IS NULL OR "daily_briefing_settings"."auto_print_trigger" IN ('morning_complete'))
);
--> statement-breakpoint
CREATE TABLE `daily_briefing` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`date` text NOT NULL,
	`status` text NOT NULL,
	`payload` text NOT NULL,
	`failed_render_blocks` text DEFAULT '[]' NOT NULL,
	`unrendered_blocks` text DEFAULT '[]' NOT NULL,
	`raster_bits` blob,
	`raster_height` integer,
	`png` blob,
	`last_print_state` text,
	`last_print_at` integer,
	`last_print_generation` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "daily_briefing_status_check" CHECK("daily_briefing"."status" IN ('pending','ready','partial','failed','render-failed')),
	CONSTRAINT "daily_briefing_last_print_state_check" CHECK("daily_briefing"."last_print_state" IS NULL OR "daily_briefing"."last_print_state" IN ('completed','failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_briefing_unique_member_date` ON `daily_briefing` (`member_id`,`date`);--> statement-breakpoint
CREATE TABLE `daily_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`date` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "daily_messages_text_check" CHECK(length(trim("daily_messages"."text")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_messages_unique_member_date` ON `daily_messages` (`member_id`,`date`);--> statement-breakpoint
CREATE TABLE `day_periods` (
	`id` text PRIMARY KEY NOT NULL,
	`label_key` text NOT NULL,
	`start_minutes` integer NOT NULL,
	`sort_order` integer NOT NULL,
	CONSTRAINT "day_periods_id_check" CHECK("day_periods"."id" IN ('morning','afternoon','evening','night')),
	CONSTRAINT "day_periods_start_minutes_check" CHECK("day_periods"."start_minutes" BETWEEN 0 AND 1439),
	CONSTRAINT "day_periods_sort_order_check" CHECK("day_periods"."sort_order" BETWEEN 0 AND 3)
);
--> statement-breakpoint
CREATE TABLE `installation_lineage` (
	`singleton_id` integer PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`pre_run_migration_files` text NOT NULL,
	`captured_at` text NOT NULL,
	CONSTRAINT "installation_lineage_singleton_check" CHECK("installation_lineage"."singleton_id" = 1),
	CONSTRAINT "installation_lineage_kind_check" CHECK("installation_lineage"."kind" IN ('fresh')),
	CONSTRAINT "installation_lineage_history_check" CHECK(json_valid("installation_lineage"."pre_run_migration_files") AND json_type("installation_lineage"."pre_run_migration_files") = 'array'),
	CONSTRAINT "installation_lineage_captured_at_check" CHECK(length("installation_lineage"."captured_at") = 24
        AND "installation_lineage"."captured_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
        AND strftime('%Y-%m-%dT%H:%M:%fZ', "installation_lineage"."captured_at") = "installation_lineage"."captured_at")
);
--> statement-breakpoint
CREATE TABLE `meal_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`meal_plan_id` text,
	`weekday` text,
	`entry_date` text,
	`slot` text NOT NULL,
	`recipe_id` text,
	`note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`meal_plan_id`) REFERENCES `meal_plans`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "meal_entries_kind_check" CHECK(("meal_entries"."meal_plan_id" IS NOT NULL AND "meal_entries"."weekday" IS NOT NULL AND "meal_entries"."entry_date" IS NULL) OR ("meal_entries"."entry_date" IS NOT NULL AND "meal_entries"."meal_plan_id" IS NULL AND "meal_entries"."weekday" IS NULL)),
	CONSTRAINT "meal_entries_content_check" CHECK(("meal_entries"."recipe_id" IS NOT NULL AND "meal_entries"."note" IS NULL) OR ("meal_entries"."recipe_id" IS NULL AND "meal_entries"."note" IS NOT NULL)),
	CONSTRAINT "meal_entries_slot_check" CHECK("meal_entries"."slot" IN ('breakfast','lunch','snack','dinner')),
	CONSTRAINT "meal_entries_weekday_check" CHECK("meal_entries"."weekday" IS NULL OR "meal_entries"."weekday" IN ('mon','tue','wed','thu','fri','sat','sun'))
);
--> statement-breakpoint
CREATE INDEX `meal_entries_recipe_id_idx` ON `meal_entries` (`recipe_id`);--> statement-breakpoint
CREATE INDEX `meal_entries_entry_date_slot_idx` ON `meal_entries` (`entry_date`,`slot`);--> statement-breakpoint
CREATE INDEX `meal_entries_meal_plan_id_weekday_slot_idx` ON `meal_entries` (`meal_plan_id`,`weekday`,`slot`);--> statement-breakpoint
CREATE TABLE `meal_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "meal_plans_name_check" CHECK(length(trim("meal_plans"."name")) > 0),
	CONSTRAINT "meal_plans_active_check" CHECK("meal_plans"."active" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`color_key` text DEFAULT 'blue' NOT NULL,
	`role` text NOT NULL,
	`lifecycle` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`birth_month` integer,
	`birth_day` integer,
	`birth_year` integer,
	CONSTRAINT "members_display_name_check" CHECK(length(trim("members"."display_name")) > 0),
	CONSTRAINT "members_role_check" CHECK("members"."role" IN ('parent', 'child')),
	CONSTRAINT "members_color_key_check" CHECK("members"."color_key" IN ('blue', 'sky', 'teal', 'green', 'lime', 'amber', 'orange', 'red', 'pink', 'violet')),
	CONSTRAINT "members_lifecycle_check" CHECK("members"."lifecycle" IN ('active', 'archived'))
);
--> statement-breakpoint
CREATE TABLE `network_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`mac` text NOT NULL,
	`alias` text NOT NULL,
	`member_id` text,
	`is_blocked` integer DEFAULT 0 NOT NULL,
	`belief_diverged_at` integer,
	`last_seen_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "network_devices_is_blocked_check" CHECK("network_devices"."is_blocked" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `network_devices_mac_unique` ON `network_devices` (`mac`);--> statement-breakpoint
CREATE TABLE `plugin_activation_registry` (
	`plugin_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`activated_at` text,
	`updated_at` text NOT NULL,
	`error_code` text,
	`error_message` text,
	CONSTRAINT "plugin_activation_registry_plugin_id_check" CHECK("plugin_activation_registry"."plugin_id" IN ('daily-briefing', 'printing', 'weather', 'time-announcements', 'backups', 'network-devices', 'meals-recipes', 'reminders', 'daily-messages')),
	CONSTRAINT "plugin_activation_registry_state_check" CHECK("plugin_activation_registry"."state" IN ('active', 'inactive', 'errored')),
	CONSTRAINT "plugin_activation_registry_activated_at_check" CHECK("plugin_activation_registry"."activated_at" IS NULL OR (
        length("plugin_activation_registry"."activated_at") = 24
        AND "plugin_activation_registry"."activated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
        AND strftime('%Y-%m-%dT%H:%M:%fZ', "plugin_activation_registry"."activated_at") = "plugin_activation_registry"."activated_at"
      )),
	CONSTRAINT "plugin_activation_registry_updated_at_check" CHECK(length("plugin_activation_registry"."updated_at") = 24
        AND "plugin_activation_registry"."updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
        AND strftime('%Y-%m-%dT%H:%M:%fZ', "plugin_activation_registry"."updated_at") = "plugin_activation_registry"."updated_at"),
	CONSTRAINT "plugin_activation_registry_error_check" CHECK((
        ("plugin_activation_registry"."error_code" IS NULL AND "plugin_activation_registry"."error_message" IS NULL)
        OR (
          "plugin_activation_registry"."state" = 'errored'
          AND "plugin_activation_registry"."error_code" IS NOT NULL
          AND "plugin_activation_registry"."error_message" IS NOT NULL
          AND (
            ("plugin_activation_registry"."error_code" = 'settings_initialization_failed' AND "plugin_activation_registry"."error_message" = 'Plugin settings could not be prepared.')
            OR ("plugin_activation_registry"."error_code" = 'migration_failed' AND "plugin_activation_registry"."error_message" = 'Plugin data could not be prepared.')
            OR ("plugin_activation_registry"."error_code" = 'runtime_mount_failed' AND "plugin_activation_registry"."error_message" = 'Plugin services could not be started.')
            OR ("plugin_activation_registry"."error_code" = 'drain_failed' AND "plugin_activation_registry"."error_message" = 'Plugin work could not stop safely.')
            OR ("plugin_activation_registry"."error_code" = 'runtime_unmount_failed' AND "plugin_activation_registry"."error_message" = 'Plugin services could not be stopped.')
            OR ("plugin_activation_registry"."error_code" = 'contribution_failed' AND "plugin_activation_registry"."error_message" = 'A plugin contribution failed.')
            OR ("plugin_activation_registry"."error_code" = 'reconciliation_failed' AND "plugin_activation_registry"."error_message" = 'Plugin recovery requires attention.')
          )
        )
      ))
);
--> statement-breakpoint
CREATE TABLE `plugin_lifecycle_operations` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`plugin_id` text NOT NULL,
	`target_state` text NOT NULL,
	`phase` text NOT NULL,
	`started_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`plugin_id`) REFERENCES `plugin_activation_registry`(`plugin_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "plugin_lifecycle_operations_operation_id_check" CHECK(length(trim("plugin_lifecycle_operations"."operation_id")) > 0),
	CONSTRAINT "plugin_lifecycle_operations_target_phase_check" CHECK((
        ("plugin_lifecycle_operations"."target_state" = 'active' AND "plugin_lifecycle_operations"."phase" IN ('preparing-settings', 'running-migrations', 'mounting', 'committing-active'))
        OR
        ("plugin_lifecycle_operations"."target_state" = 'inactive' AND "plugin_lifecycle_operations"."phase" IN ('blocking-claims', 'draining', 'unmounting', 'committing-inactive'))
      )),
	CONSTRAINT "plugin_lifecycle_operations_started_at_check" CHECK(length("plugin_lifecycle_operations"."started_at") = 24
        AND "plugin_lifecycle_operations"."started_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
        AND strftime('%Y-%m-%dT%H:%M:%fZ', "plugin_lifecycle_operations"."started_at") = "plugin_lifecycle_operations"."started_at"),
	CONSTRAINT "plugin_lifecycle_operations_updated_at_check" CHECK(length("plugin_lifecycle_operations"."updated_at") = 24
        AND "plugin_lifecycle_operations"."updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
        AND strftime('%Y-%m-%dT%H:%M:%fZ', "plugin_lifecycle_operations"."updated_at") = "plugin_lifecycle_operations"."updated_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_lifecycle_operations_plugin_id_unique` ON `plugin_lifecycle_operations` (`plugin_id`);--> statement-breakpoint
CREATE TABLE `plugin_migration_journal` (
	`plugin_id` text NOT NULL,
	`migration_id` text NOT NULL,
	`applied_at` text NOT NULL,
	PRIMARY KEY(`plugin_id`, `migration_id`),
	FOREIGN KEY (`plugin_id`) REFERENCES `plugin_activation_registry`(`plugin_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "plugin_migration_journal_migration_id_check" CHECK(length(trim("plugin_migration_journal"."migration_id")) > 0),
	CONSTRAINT "plugin_migration_journal_applied_at_check" CHECK(length("plugin_migration_journal"."applied_at") = 24
        AND "plugin_migration_journal"."applied_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
        AND strftime('%Y-%m-%dT%H:%M:%fZ', "plugin_migration_journal"."applied_at") = "plugin_migration_journal"."applied_at")
);
--> statement-breakpoint
CREATE TABLE `print_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`record_id` text NOT NULL,
	`member_id` text,
	`target_date` text NOT NULL,
	`state` text NOT NULL,
	`output_ref` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease_token` text,
	`lease_expires_at` integer,
	`claimed_at` integer,
	`printed_at` integer,
	`failure_reason` text,
	`payload_served_at` integer,
	`generation` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`record_id`) REFERENCES `print_records`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "print_jobs_state_check" CHECK("print_jobs"."state" IN ('pending','claimed','printed','failed','cancelled'))
);
--> statement-breakpoint
CREATE INDEX `print_jobs_target_date_state_idx` ON `print_jobs` (`target_date`,`state`);--> statement-breakpoint
CREATE INDEX `print_jobs_record_id_idx` ON `print_jobs` (`record_id`);--> statement-breakpoint
CREATE TABLE `print_records` (
	`id` text PRIMARY KEY NOT NULL,
	`record_key` text NOT NULL,
	`target_date` text NOT NULL,
	`superseded_at` integer,
	`printed_job_id` text,
	`generation` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `print_records_unique_record_key_target_date` ON `print_records` (`record_key`,`target_date`);--> statement-breakpoint
CREATE TABLE `printer_capabilities` (
	`key_id` text PRIMARY KEY NOT NULL,
	`registered_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recipes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`ingredients` text,
	`instructions` text,
	`slots` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "recipes_name_check" CHECK(length(trim("recipes"."name")) > 0)
);
--> statement-breakpoint
CREATE INDEX `recipes_name_idx` ON `recipes` (`name`);--> statement-breakpoint
CREATE TABLE `reminder_assignment` (
	`id` text PRIMARY KEY NOT NULL,
	`reminder_id` text NOT NULL,
	`member_id` text NOT NULL,
	`weekdays` text DEFAULT '[]' NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`reminder_id`) REFERENCES `reminder`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "reminder_assignments_active_check" CHECK("reminder_assignment"."active" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reminder_assignments_unique_reminder_member` ON `reminder_assignment` (`reminder_id`,`member_id`);--> statement-breakpoint
CREATE TABLE `reminder` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`targeting_mode` text NOT NULL,
	`text` text NOT NULL,
	`weekdays` text,
	`query` text,
	`query_fields` text,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "reminders_kind_check" CHECK("reminder"."kind" IN ('scheduled','calendar_gated')),
	CONSTRAINT "reminders_targeting_mode_check" CHECK("reminder"."targeting_mode" IN ('apply_to_all','specific')),
	CONSTRAINT "reminders_discriminant_check" CHECK(("reminder"."kind" = 'scheduled' AND "reminder"."query" IS NULL AND "reminder"."query_fields" IS NULL AND (("reminder"."targeting_mode" = 'apply_to_all' AND "reminder"."weekdays" IS NOT NULL) OR ("reminder"."targeting_mode" = 'specific' AND "reminder"."weekdays" IS NULL))) OR ("reminder"."kind" = 'calendar_gated' AND "reminder"."query" IS NOT NULL AND "reminder"."query_fields" IS NOT NULL AND "reminder"."weekdays" IS NULL)),
	CONSTRAINT "reminders_active_check" CHECK("reminder"."active" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `routine_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`routine_id` text NOT NULL,
	`member_id` text NOT NULL,
	`weekdays` text DEFAULT '[]' NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`routine_id`) REFERENCES `routines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "routine_assignments_active_check" CHECK("routine_assignments"."active" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `routine_assignments_unique_routine_member` ON `routine_assignments` (`routine_id`,`member_id`);--> statement-breakpoint
CREATE TABLE `routines` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`day_period_id` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`day_period_id`) REFERENCES `day_periods`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "routines_active_check" CHECK("routines"."active" IN (0, 1)),
	CONSTRAINT "routines_day_period_id_check" CHECK("routines"."day_period_id" IN ('morning','afternoon','evening','night'))
);
--> statement-breakpoint
CREATE TABLE `seed_profile_state` (
	`profile` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`as_of_date` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	CONSTRAINT "seed_profile_state_version_check" CHECK("seed_profile_state"."version" > 0),
	CONSTRAINT "seed_profile_state_as_of_date_shape_check" CHECK("seed_profile_state"."as_of_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "seed_profile_state_status_check" CHECK("seed_profile_state"."status" IN ('running', 'complete')),
	CONSTRAINT "seed_profile_state_completion_check" CHECK(("seed_profile_state"."status" = 'running' AND "seed_profile_state"."completed_at" IS NULL) OR ("seed_profile_state"."status" = 'complete' AND "seed_profile_state"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `settings_objects` (
	`object_name` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `time_announcements` (
	`id` text PRIMARY KEY NOT NULL,
	`time` text NOT NULL,
	`week_days` text NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "time_announcements_time_check" CHECK("time_announcements"."time" GLOB '[0-2][0-9]:[0-5][0-9]' AND CAST(substr("time_announcements"."time", 1, 2) AS INTEGER) BETWEEN 0 AND 23),
	CONSTRAINT "time_announcements_week_days_check" CHECK(length(trim("time_announcements"."week_days")) > 0),
	CONSTRAINT "time_announcements_is_active_check" CHECK("time_announcements"."is_active" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `time_announcements_time_idx` ON `time_announcements` (`time`);
--> statement-breakpoint
-- Hand additions: fixed rows every database starts with.
INSERT INTO `day_periods` (`id`, `label_key`, `start_minutes`, `sort_order`) VALUES ('morning', 'dayPeriod.morning', 300, 0);--> statement-breakpoint
INSERT INTO `day_periods` (`id`, `label_key`, `start_minutes`, `sort_order`) VALUES ('afternoon', 'dayPeriod.afternoon', 720, 1);--> statement-breakpoint
INSERT INTO `day_periods` (`id`, `label_key`, `start_minutes`, `sort_order`) VALUES ('evening', 'dayPeriod.evening', 1080, 2);--> statement-breakpoint
INSERT INTO `day_periods` (`id`, `label_key`, `start_minutes`, `sort_order`) VALUES ('night', 'dayPeriod.night', 1260, 3);--> statement-breakpoint
-- The runner hands over the installation lineage (always `fresh`, empty pre-run journal, and the
-- capture time from its injectable clock) through a connection-scoped temp table.
INSERT INTO `installation_lineage` (`singleton_id`, `kind`, `pre_run_migration_files`, `captured_at`)
SELECT 1, `kind`, `pre_run_migration_files`, `captured_at`
FROM temp.`plugin_lifecycle_migration_context`;
--> statement-breakpoint
-- Every plugin starts inactive; the owner activates them from Admin.
WITH `plugin_ids` (`plugin_id`) AS (
	VALUES
		('daily-briefing'),
		('printing'),
		('weather'),
		('time-announcements'),
		('backups'),
		('network-devices'),
		('meals-recipes'),
		('reminders'),
		('daily-messages')
)
INSERT INTO `plugin_activation_registry` (`plugin_id`, `state`, `activated_at`, `updated_at`, `error_code`, `error_message`)
SELECT `plugin_ids`.`plugin_id`, 'inactive', NULL, `installation_lineage`.`captured_at`, NULL, NULL
FROM `plugin_ids`
CROSS JOIN `installation_lineage`;
