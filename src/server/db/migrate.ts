import fs from "node:fs";
import path from "node:path";
import { getDb } from "./client";

const DRIZZLE_DIR = path.resolve(process.cwd(), "drizzle");

const MIGRATIONS_TABLE = "drizzle_universe_migrations";
const LIFECYCLE_MIGRATION = "0002_plugin_lifecycle.sql";
const SUPPORTED_BASELINE_MIGRATION = "0000_current_baseline.sql";
const LIFECYCLE_CONTEXT_TABLE = "plugin_lifecycle_migration_context";

export interface MigrationOptions {
  now?: () => number;
}

interface LifecycleMigrationContext {
  kind: "fresh" | "prior_baseline";
  preRunMigrationFiles: string;
  capturedAt: string;
}

function ensureMigrationsTable(db: ReturnType<typeof import("better-sqlite3")>): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS \`${MIGRATIONS_TABLE}\` (\`fileName\` TEXT PRIMARY KEY NOT NULL, \`appliedAt\` INTEGER NOT NULL)`
  );
}

function getAppliedMigrations(db: ReturnType<typeof import("better-sqlite3")>): Set<string> {
  const rows = db.prepare(`SELECT fileName FROM \`${MIGRATIONS_TABLE}\``).all() as {
    fileName: string;
  }[];
  return new Set(rows.map((r) => r.fileName));
}

function getPendingMigrations(migrationsDir: string, applied: ReadonlySet<string>): string[] {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files.filter((f) => !applied.has(f));
}

function classifyLifecycleHistory(
  applied: ReadonlySet<string>,
  capturedAt: string
): LifecycleMigrationContext {
  const preRunFiles = [...applied].sort();
  if (preRunFiles.length === 0) {
    return {
      kind: "fresh",
      preRunMigrationFiles: "[]",
      capturedAt,
    };
  }
  if (preRunFiles.length === 1 && preRunFiles[0] === SUPPORTED_BASELINE_MIGRATION) {
    return {
      kind: "prior_baseline",
      preRunMigrationFiles: JSON.stringify(preRunFiles),
      capturedAt,
    };
  }
  throw new Error("Unsupported pre-lifecycle migration history.");
}

function createLifecycleContext(
  db: ReturnType<typeof import("better-sqlite3")>,
  context: LifecycleMigrationContext
): void {
  db.exec(`DROP TABLE IF EXISTS temp.${LIFECYCLE_CONTEXT_TABLE}`);
  db.exec(
    `CREATE TEMP TABLE ${LIFECYCLE_CONTEXT_TABLE} (` +
      "kind TEXT NOT NULL, " +
      "pre_run_migration_files TEXT NOT NULL, " +
      "captured_at TEXT NOT NULL" +
      ")"
  );
  db.prepare(
    `INSERT INTO temp.${LIFECYCLE_CONTEXT_TABLE} ` +
      "(kind, pre_run_migration_files, captured_at) VALUES (?, ?, ?)"
  ).run(context.kind, context.preRunMigrationFiles, context.capturedAt);
}

function dropLifecycleContext(db: ReturnType<typeof import("better-sqlite3")>): void {
  db.exec(`DROP TABLE IF EXISTS temp.${LIFECYCLE_CONTEXT_TABLE}`);
}

function assertCompleteLifecycleMetadata(db: ReturnType<typeof import("better-sqlite3")>): void {
  const requiredTables = [
    "installation_lineage",
    "plugin_activation_registry",
    "plugin_lifecycle_operations",
    "plugin_migration_journal",
  ];
  const placeholders = requiredTables.map(() => "?").join(", ");
  const existing = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`)
    .all(...requiredTables) as { name: string }[];
  if (existing.length !== requiredTables.length) {
    throw new Error("Incomplete plugin lifecycle migration history.");
  }

  const lineage = db.prepare("SELECT COUNT(*) AS count FROM installation_lineage").get() as {
    count: number;
  };
  const registry = db.prepare("SELECT COUNT(*) AS count FROM plugin_activation_registry").get() as {
    count: number;
  };
  if (lineage.count !== 1 || registry.count !== 9) {
    throw new Error("Incomplete plugin lifecycle migration history.");
  }
}

export function runMigrations(
  migrationsDir: string = DRIZZLE_DIR,
  options: MigrationOptions = {}
): void {
  const db = getDb();
  const now = options.now ?? Date.now;
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(
      `Migration directory does not exist: ${migrationsDir}. ` +
        "Ensure the 'drizzle/' directory exists with migration SQL files."
    );
  }

  ensureMigrationsTable(db);

  const applied = getAppliedMigrations(db);
  if (applied.has(LIFECYCLE_MIGRATION)) {
    assertCompleteLifecycleMetadata(db);
  }

  const pending = getPendingMigrations(migrationsDir, applied);

  if (pending.length === 0) {
    return;
  }

  const lifecycleContext = pending.includes(LIFECYCLE_MIGRATION)
    ? classifyLifecycleHistory(applied, new Date(now()).toISOString())
    : undefined;

  if (lifecycleContext) {
    createLifecycleContext(db, lifecycleContext);
  }

  const applyAll = db.transaction((files: string[]) => {
    for (const fileName of files) {
      const filePath = path.join(migrationsDir, fileName);
      const sql = fs.readFileSync(filePath, "utf-8");
      db.exec(sql);
      const appliedAt = now();
      db.prepare(
        `INSERT INTO \`${MIGRATIONS_TABLE}\` (\`fileName\`, \`appliedAt\`) VALUES (?, ?)`
      ).run(fileName, appliedAt);
    }

    // Checked INSIDE the transaction, before commit: throwing here rolls back both the
    // migration's data AND its bookkeeping insert atomically. Checking after commit would let
    // an invalid batch land permanently — the empty-pending early-return above would then skip
    // the check forever, booting the app on a silently corrupt DB.
    const violations = db.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) {
      throw new Error(
        `Migration batch left ${violations.length} foreign key violation(s): ${JSON.stringify(violations)}`
      );
    }
  });

  // SQLite no-ops `PRAGMA foreign_keys` while a transaction is active, so a table-rebuild
  // migration can't disable it from inside its own SQL — DROP TABLE would still fire the
  // implicit ON DELETE CASCADE on any child rows. Toggle it OFF here, before BEGIN, and restore
  // it unconditionally after the migration completes.
  db.pragma("foreign_keys = OFF");
  try {
    applyAll(pending);
  } finally {
    db.pragma("foreign_keys = ON");
    if (lifecycleContext) {
      dropLifecycleContext(db);
    }
  }
}
