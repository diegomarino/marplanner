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

/** Every migration the repository ships, in the order the runner applies them: the squashed
 * baseline first, then forward migrations such as `0001_reminder_content.sql`. */
export const SHIPPED_MIGRATION_FILES: readonly string[] = fs
  .readdirSync(path.resolve(process.cwd(), "drizzle"))
  .filter((file) => file.endsWith(".sql"))
  .sort();

/** `execBaseline`, then every later shipped migration, with foreign keys off as the runner does
 * (a table rebuild must not cascade). Records nothing in `drizzle_universe_migrations`. */
export function execShippedMigrations(
  db: Database.Database,
  capturedAt = "2026-10-16T00:00:00.000Z"
): void {
  execBaseline(db, capturedAt);
  const foreignKeys = db.pragma("foreign_keys", { simple: true });
  db.pragma("foreign_keys = OFF");
  try {
    for (const file of SHIPPED_MIGRATION_FILES.filter((name) => name !== BASELINE_FILE)) {
      db.exec(fs.readFileSync(path.resolve(process.cwd(), "drizzle", file), "utf8"));
    }
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }
}

/** Copy every shipped migration into `directory`, for tests that build their own migrations
 * folder: the runner refuses a ledger entry the folder does not ship. */
export function copyShippedMigrations(directory: string): void {
  for (const file of SHIPPED_MIGRATION_FILES) {
    fs.copyFileSync(path.resolve(process.cwd(), "drizzle", file), path.join(directory, file));
  }
}
