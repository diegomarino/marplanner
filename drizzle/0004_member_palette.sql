-- The member palette shrinks from sixteen colours to ten. Each member on a retired colour moves
-- to its nearest survivor, unless another active member already has that one: then the member
-- takes the first colour no active member uses. Archived members hold no colour, so they are
-- simply moved to the survivor.
--
-- The table is then rebuilt, because a CHECK cannot be altered in place: an upgraded database
-- must refuse the retired names exactly as a fresh one does. The migration runner switches
-- foreign keys off around the batch, so dropping the old table does not touch the rows that
-- reference a member, and it verifies every foreign key before committing.
WITH
  retired(old_key, new_key) AS (
    VALUES ('cyan', 'teal'), ('yellow', 'amber'), ('rose', 'red'),
           ('fuchsia', 'pink'), ('purple', 'violet'), ('indigo', 'blue')
  ),
  palette(key, position) AS (
    VALUES ('blue', 1), ('sky', 2), ('teal', 3), ('green', 4), ('lime', 5),
           ('amber', 6), ('orange', 7), ('red', 8), ('pink', 9), ('violet', 10)
  )
UPDATE `members`
SET `color_key` = CASE
  WHEN `members`.`lifecycle` <> 'active'
    OR NOT EXISTS (
      SELECT 1 FROM `members` AS other
      WHERE other.`lifecycle` = 'active'
        AND other.`id` <> `members`.`id`
        AND other.`color_key` = (SELECT new_key FROM retired WHERE old_key = `members`.`color_key`)
    )
  THEN (SELECT new_key FROM retired WHERE old_key = `members`.`color_key`)
  ELSE COALESCE(
    (
      SELECT palette.key FROM palette
      WHERE NOT EXISTS (
        SELECT 1 FROM `members` AS other
        WHERE other.`lifecycle` = 'active'
          AND other.`id` <> `members`.`id`
          AND (
            other.`color_key` = palette.key
            OR other.`color_key` IN (SELECT old_key FROM retired WHERE new_key = palette.key)
          )
      )
      ORDER BY palette.position
      LIMIT 1
    ),
    (SELECT new_key FROM retired WHERE old_key = `members`.`color_key`)
  )
END
WHERE `color_key` IN ('cyan', 'yellow', 'rose', 'fuchsia', 'purple', 'indigo');
--> statement-breakpoint
CREATE TABLE `members_new` (
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
	CONSTRAINT `members_display_name_check` CHECK(length(trim(`display_name`)) > 0),
	CONSTRAINT `members_role_check` CHECK(`role` IN ('parent', 'child')),
	CONSTRAINT `members_color_key_check` CHECK(`color_key` IN ('blue', 'sky', 'teal', 'green', 'lime', 'amber', 'orange', 'red', 'pink', 'violet')),
	CONSTRAINT `members_lifecycle_check` CHECK(`lifecycle` IN ('active', 'archived'))
);
--> statement-breakpoint
INSERT INTO `members_new` (
	`id`, `display_name`, `color_key`, `role`, `lifecycle`,
	`created_at`, `updated_at`, `birth_month`, `birth_day`, `birth_year`
)
SELECT
	`id`, `display_name`, `color_key`, `role`, `lifecycle`,
	`created_at`, `updated_at`, `birth_month`, `birth_day`, `birth_year`
FROM `members`;
--> statement-breakpoint
DROP TABLE `members`;
--> statement-breakpoint
ALTER TABLE `members_new` RENAME TO `members`;
