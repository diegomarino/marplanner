/** The FULL, current `sqlite_master` table set produced by the reviewed
 * `drizzle/0000_current_baseline.sql` and the default `runMigrations` path,
 * plus `drizzle_universe_migrations` (the runner's own bookkeeping table,
 * created by `ensureMigrationsTable` in `src/server/db/migrate.ts`, not by a
 * `.sql` file). Single source of truth shared by every test that needs the
 * whole table inventory — `tests/boundary/migrate-runner.test.ts` (SC-006 /
 * BACKGROUND-JOBS-SCHEDULER-INV-03 schema snapshot) and
 * `tests/integration/scheduler-lifecycle.test.ts` (BACKGROUND-JOBS-SCHEDULER-
 * INV-05 pure-reads sweep, which snapshots row counts on every one of these
 * tables, not just the two the scheduler's own jobs touch).
 * Hardcoded (not derived at runtime) so a stray future migration is caught by
 * a failing diff rather than silently rewriting its own oracle.
 * Re-derived this list from the complete current TypeScript schema through a
 * clean Drizzle generation, then cross-checked it against a real fresh
 * `runMigrations` run's `sqlite_master`.
 */
export const ALL_SCHEMA_TABLES: readonly string[] = [
  "admin_config",
  "api_keys",
  "calendar_assignments",
  "calendar_events",
  "calendar_external_event_meta",
  "calendar_external_sources",
  "calendar_highlight_rules",
  "chore_completions",
  "chores",
  "client_log",
  "daily_briefing",
  "daily_briefing_block_cache",
  "daily_briefing_block_order",
  "daily_briefing_member_block_settings",
  "daily_briefing_optin",
  "daily_briefing_settings",
  "daily_messages",
  "day_periods",
  "drizzle_universe_migrations",
  "installation_lineage",
  "meal_entries",
  "meal_plans",
  "members",
  "network_devices",
  "plugin_activation_registry",
  "plugin_lifecycle_operations",
  "plugin_migration_journal",
  "print_jobs",
  "print_records",
  "printer_capabilities",
  "recipes",
  "reminder",
  "reminder_assignment",
  "routine_assignments",
  "routines",
  "seed_profile_state",
  "settings_objects",
  "time_announcements",
];
