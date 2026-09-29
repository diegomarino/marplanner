CREATE TABLE `installation_lineage` (
	`singleton_id` integer PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`pre_run_migration_files` text NOT NULL,
	`captured_at` text NOT NULL,
	CONSTRAINT `installation_lineage_singleton_check` CHECK (`singleton_id` = 1),
	CONSTRAINT `installation_lineage_kind_check` CHECK (`kind` IN ('fresh', 'prior_baseline')),
	CONSTRAINT `installation_lineage_history_check` CHECK (json_valid(`pre_run_migration_files`) AND json_type(`pre_run_migration_files`) = 'array'),
	CONSTRAINT `installation_lineage_captured_at_check` CHECK (
		length(`captured_at`) = 24
		AND `captured_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
		AND strftime('%Y-%m-%dT%H:%M:%fZ', `captured_at`) = `captured_at`
	)
);
--> statement-breakpoint
INSERT INTO `installation_lineage` (`singleton_id`, `kind`, `pre_run_migration_files`, `captured_at`)
SELECT 1, `kind`, `pre_run_migration_files`, `captured_at`
FROM temp.`plugin_lifecycle_migration_context`;
--> statement-breakpoint
CREATE TABLE `plugin_activation_registry` (
	`plugin_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`activated_at` text,
	`updated_at` text NOT NULL,
	`error_code` text,
	`error_message` text,
	CONSTRAINT `plugin_activation_registry_plugin_id_check` CHECK (`plugin_id` IN ('daily-briefing', 'printing', 'weather', 'time-announcements', 'backups', 'network-devices', 'meals-recipes', 'reminders', 'daily-messages')),
	CONSTRAINT `plugin_activation_registry_state_check` CHECK (`state` IN ('active', 'inactive', 'errored')),
	CONSTRAINT `plugin_activation_registry_activated_at_check` CHECK (
		`activated_at` IS NULL OR (
			length(`activated_at`) = 24
			AND `activated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
			AND strftime('%Y-%m-%dT%H:%M:%fZ', `activated_at`) = `activated_at`
		)
	),
	CONSTRAINT `plugin_activation_registry_updated_at_check` CHECK (
		length(`updated_at`) = 24
		AND `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
		AND strftime('%Y-%m-%dT%H:%M:%fZ', `updated_at`) = `updated_at`
	),
	CONSTRAINT `plugin_activation_registry_error_check` CHECK (
		(`error_code` IS NULL AND `error_message` IS NULL)
		OR (
			`state` = 'errored'
			AND `error_code` IS NOT NULL
			AND `error_message` IS NOT NULL
			AND (
				(`error_code` = 'settings_initialization_failed' AND `error_message` = 'Plugin settings could not be prepared.')
				OR (`error_code` = 'migration_failed' AND `error_message` = 'Plugin data could not be prepared.')
				OR (`error_code` = 'runtime_mount_failed' AND `error_message` = 'Plugin services could not be started.')
				OR (`error_code` = 'drain_failed' AND `error_message` = 'Plugin work could not stop safely.')
				OR (`error_code` = 'runtime_unmount_failed' AND `error_message` = 'Plugin services could not be stopped.')
				OR (`error_code` = 'contribution_failed' AND `error_message` = 'A plugin contribution failed.')
				OR (`error_code` = 'reconciliation_failed' AND `error_message` = 'Plugin recovery requires attention.')
			)
		)
	)
);
--> statement-breakpoint
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
SELECT
	`plugin_ids`.`plugin_id`,
	CASE `installation_lineage`.`kind` WHEN 'prior_baseline' THEN 'active' ELSE 'inactive' END,
	NULL,
	`installation_lineage`.`captured_at`,
	NULL,
	NULL
FROM `plugin_ids`
CROSS JOIN `installation_lineage`;
--> statement-breakpoint
CREATE TABLE `plugin_lifecycle_operations` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`plugin_id` text NOT NULL,
	`target_state` text NOT NULL,
	`phase` text NOT NULL,
	`started_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `plugin_lifecycle_operations_plugin_id_unique` UNIQUE (`plugin_id`),
	CONSTRAINT `plugin_lifecycle_operations_plugin_id_fk` FOREIGN KEY (`plugin_id`) REFERENCES `plugin_activation_registry`(`plugin_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `plugin_lifecycle_operations_operation_id_check` CHECK (length(trim(`operation_id`)) > 0),
	CONSTRAINT `plugin_lifecycle_operations_target_phase_check` CHECK (
		(`target_state` = 'active' AND `phase` IN ('preparing-settings', 'running-migrations', 'mounting', 'committing-active'))
		OR
		(`target_state` = 'inactive' AND `phase` IN ('blocking-claims', 'draining', 'unmounting', 'committing-inactive'))
	),
	CONSTRAINT `plugin_lifecycle_operations_started_at_check` CHECK (
		length(`started_at`) = 24
		AND `started_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
		AND strftime('%Y-%m-%dT%H:%M:%fZ', `started_at`) = `started_at`
	),
	CONSTRAINT `plugin_lifecycle_operations_updated_at_check` CHECK (
		length(`updated_at`) = 24
		AND `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
		AND strftime('%Y-%m-%dT%H:%M:%fZ', `updated_at`) = `updated_at`
	)
);
--> statement-breakpoint
CREATE TABLE `plugin_migration_journal` (
	`plugin_id` text NOT NULL,
	`migration_id` text NOT NULL,
	`applied_at` text NOT NULL,
	PRIMARY KEY (`plugin_id`, `migration_id`),
	CONSTRAINT `plugin_migration_journal_plugin_id_fk` FOREIGN KEY (`plugin_id`) REFERENCES `plugin_activation_registry`(`plugin_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `plugin_migration_journal_migration_id_check` CHECK (length(trim(`migration_id`)) > 0),
	CONSTRAINT `plugin_migration_journal_applied_at_check` CHECK (
		length(`applied_at`) = 24
		AND `applied_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
		AND strftime('%Y-%m-%dT%H:%M:%fZ', `applied_at`) = `applied_at`
	)
);
