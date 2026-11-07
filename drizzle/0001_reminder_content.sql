-- Image reminders (#96): a reminder's content is `text` or `images` (an ordered JSON list of
-- catalog emojis). Adds `content_type` and `emojis` to `reminder` plus the
-- `reminders_content_check` CHECK. SQLite cannot add a table CHECK in place, so the table is
-- rebuilt; the runner turns foreign keys off around the batch, so dropping the old table leaves
-- the `reminder_assignment` rows (and their FK by name) intact. Every existing rule becomes a
-- `text` rule, as it was. The result matches `drizzle-kit generate` for src/server/db/schema.ts
-- (tests/integration/database-baseline.test.ts compares the migrated schema with it).
CREATE TABLE `__new_reminder` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`targeting_mode` text NOT NULL,
	`text` text NOT NULL,
	`content_type` text DEFAULT 'text' NOT NULL,
	`emojis` text,
	`weekdays` text,
	`query` text,
	`query_fields` text,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "reminders_kind_check" CHECK("kind" IN ('scheduled','calendar_gated')),
	CONSTRAINT "reminders_targeting_mode_check" CHECK("targeting_mode" IN ('apply_to_all','specific')),
	CONSTRAINT "reminders_discriminant_check" CHECK(("kind" = 'scheduled' AND "query" IS NULL AND "query_fields" IS NULL AND (("targeting_mode" = 'apply_to_all' AND "weekdays" IS NOT NULL) OR ("targeting_mode" = 'specific' AND "weekdays" IS NULL))) OR ("kind" = 'calendar_gated' AND "query" IS NOT NULL AND "query_fields" IS NOT NULL AND "weekdays" IS NULL)),
	CONSTRAINT "reminders_active_check" CHECK("active" IN (0, 1)),
	CONSTRAINT "reminders_content_check" CHECK(("content_type" = 'text' AND "emojis" IS NULL AND length(trim("text")) > 0) OR ("content_type" = 'images' AND "emojis" IS NOT NULL AND "emojis" <> '[]'))
);
--> statement-breakpoint
INSERT INTO `__new_reminder` (`id`, `kind`, `targeting_mode`, `text`, `content_type`, `emojis`, `weekdays`, `query`, `query_fields`, `active`, `created_at`, `updated_at`)
SELECT `id`, `kind`, `targeting_mode`, `text`, 'text', NULL, `weekdays`, `query`, `query_fields`, `active`, `created_at`, `updated_at` FROM `reminder`;
--> statement-breakpoint
DROP TABLE `reminder`;
--> statement-breakpoint
ALTER TABLE `__new_reminder` RENAME TO `reminder`;
