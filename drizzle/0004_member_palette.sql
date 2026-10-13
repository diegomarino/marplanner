-- The member palette shrinks from sixteen colours to ten. Each member on a retired colour moves
-- to its nearest survivor, unless another active member already has that one: then the member
-- takes the first colour no active member uses. Archived members hold no colour, so they are
-- simply moved to the survivor. A database created before the baseline's CHECK was narrowed
-- to the ten still accepts the retired names, which is what lets this run there; on a fresh
-- database there is nothing to move.
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
