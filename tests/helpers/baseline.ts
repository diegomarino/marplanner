import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

export const BASELINE_FILE = "0000_baseline.sql";
export const BASELINE_PATH = path.resolve(process.cwd(), "drizzle", BASELINE_FILE);

/** Execute `drizzle/0000_baseline.sql` on a raw connection outside the runner, handing it the
 * same connection-scoped lineage context `runMigrations` creates (fresh, empty pre-run journal).
 * Records nothing in `drizzle_universe_migrations`; callers that need a ledger write it. */
export function execBaseline(db: Database.Database, capturedAt = "2026-10-16T00:00:00.000Z"): void {
  db.exec(
    `CREATE TEMP TABLE plugin_lifecycle_migration_context (
       kind TEXT NOT NULL,
       pre_run_migration_files TEXT NOT NULL,
       captured_at TEXT NOT NULL
     )`
  );
  db.prepare(
    `INSERT INTO temp.plugin_lifecycle_migration_context
       (kind, pre_run_migration_files, captured_at)
     VALUES ('fresh', '[]', ?)`
  ).run(capturedAt);
  try {
    db.exec(fs.readFileSync(BASELINE_PATH, "utf8"));
  } finally {
    db.exec("DROP TABLE temp.plugin_lifecycle_migration_context");
  }
}
