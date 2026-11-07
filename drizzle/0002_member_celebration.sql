-- Second delta after the squashed baseline (issue #92): each member picks the emojis of the
-- confetti played when they finish a block of chores. Existing rows get `confetti`, the
-- coloured-paper set with no emojis; `celebration_emojis` holds a JSON array only for `custom`.
-- The table is rebuilt the way `drizzle-kit generate` rebuilds a SQLite table, so it ends up
-- exactly as src/server/db/schema.ts declares it. The runner turns foreign keys off around the
-- batch, so dropping the old table cascades nothing.
CREATE TABLE `__new_members` (
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
	`celebration_preset` text DEFAULT 'confetti' NOT NULL,
	`celebration_emojis` text,
	CONSTRAINT "members_display_name_check" CHECK(length(trim("__new_members"."display_name")) > 0),
	CONSTRAINT "members_role_check" CHECK("__new_members"."role" IN ('parent', 'child')),
	CONSTRAINT "members_color_key_check" CHECK("__new_members"."color_key" IN ('blue', 'sky', 'teal', 'green', 'lime', 'amber', 'orange', 'red', 'pink', 'violet')),
	CONSTRAINT "members_lifecycle_check" CHECK("__new_members"."lifecycle" IN ('active', 'archived')),
	CONSTRAINT "members_celebration_preset_check" CHECK("__new_members"."celebration_preset" IN ('confetti', 'stars', 'videogames', 'soccer', 'fairytale', 'custom')),
	CONSTRAINT "members_celebration_emojis_check" CHECK(CASE WHEN "__new_members"."celebration_preset" = 'custom' THEN "__new_members"."celebration_emojis" IS NOT NULL AND json_valid("__new_members"."celebration_emojis") AND json_array_length("__new_members"."celebration_emojis") BETWEEN 1 AND 6 ELSE "__new_members"."celebration_emojis" IS NULL END)
);;--> statement-breakpoint
INSERT INTO `__new_members`("id", "display_name", "color_key", "role", "lifecycle", "created_at", "updated_at", "birth_month", "birth_day", "birth_year") SELECT "id", "display_name", "color_key", "role", "lifecycle", "created_at", "updated_at", "birth_month", "birth_day", "birth_year" FROM `members`;--> statement-breakpoint
DROP TABLE `members`;--> statement-breakpoint
ALTER TABLE `__new_members` RENAME TO `members`;
