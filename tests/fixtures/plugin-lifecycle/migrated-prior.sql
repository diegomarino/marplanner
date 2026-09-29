-- Deterministic post-migration state for a store whose immutable lineage is prior_baseline.
UPDATE `plugin_activation_registry`
SET
  `state` = 'inactive',
  `activated_at` = '2026-09-27T11:30:00.000Z',
  `updated_at` = '2026-09-27T12:00:00.000Z'
WHERE `plugin_id` = 'weather';

INSERT INTO `settings_objects` (`object_name`, `data`, `updated_at`)
VALUES ('weather', '{"lat":40.4168,"lon":-3.7038,"label":"Synthetic retained fixture"}', 1790510400000);

INSERT INTO `plugin_migration_journal` (`plugin_id`, `migration_id`, `applied_at`)
VALUES ('weather', 'fixture-weather-v1', '2026-09-27T12:00:00.000Z');

INSERT INTO `members`
  (`id`, `display_name`, `color_key`, `role`, `lifecycle`, `created_at`, `updated_at`)
VALUES
  ('fixture-member', 'Synthetic Member', 'blue', 'parent', 'active', 1790510400000, 1790510400000);

INSERT INTO `daily_messages`
  (`id`, `member_id`, `date`, `text`, `created_at`, `updated_at`)
VALUES
  ('fixture-message', 'fixture-member', '2026-09-27', 'Synthetic retained data', 1790510400000, 1790510400000);
