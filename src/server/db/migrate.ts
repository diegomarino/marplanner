import fs from "node:fs";
import path from "node:path";
import { getDb } from "./client";

const DRIZZLE_DIR = path.resolve(process.cwd(), "drizzle");

const MIGRATIONS_TABLE = "drizzle_universe_migrations";
/** The baseline every ledger starts with (squashed 2026-10-16); later forward migrations apply after
 * it. It also seeds the installation lineage and the plugin registry from the context handed over
 * below. */
const BASELINE_MIGRATION = "0000_baseline.sql";
const LIFECYCLE_CONTEXT_TABLE = "plugin_lifecycle_migration_context";

export interface MigrationOptions {
  now?: () => number;
}

interface LifecycleMigrationContext {
  kind: "fresh";
  preRunMigrationFiles: string;
  capturedAt: string;
}

function syncPath(file: string): void {
  const fd = fs.openSync(file, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function createBackupDirectory(directory: string): void {
  const parent = path.dirname(directory);
  if (parent !== directory) createBackupDirectory(parent);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  // Re-sync existing ancestors too: an earlier attempt may have created them before fsync failed.
  syncPath(directory);
  if (parent !== directory) syncPath(parent);
}

function createPreMigrationBackup(db: ReturnType<typeof getDb>): string {
  try {
    const configuredRoot = path.resolve(
      process.env.BACKUPS_ROOT || path.join(process.env.DATA_DIR ?? process.cwd(), "backups")
    );
    createBackupDirectory(configuredRoot);
    const root = fs.realpathSync(configuredRoot);
    const lane = path.join(root, "pre-migration");
    if (fs.existsSync(lane) && !fs.lstatSync(lane).isDirectory())
      throw new Error("Pre-migration recovery directory must be a real directory");
    createBackupDirectory(lane);
    fs.chmodSync(lane, 0o700);
    const directory = fs.mkdtempSync(path.join(lane, "snapshot-"));
    syncPath(lane);
    const pending = path.join(directory, ".pending.db");
    const snapshot = path.join(directory, "database.db");
    // VACUUM INTO copies committed WAL data without allocating the whole DB in Node memory.
    // It preserves explicit keys; this is a logical snapshot, not a byte-identical copy.
    db.prepare("VACUUM INTO ?").run(pending);
    fs.chmodSync(pending, 0o600);
    syncPath(pending);
    fs.renameSync(pending, snapshot);
    syncPath(directory);
    return snapshot;
  } catch (cause) {
    throw new Error("Pre-migration backup failed; no migration was applied", { cause });
  }
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

function listMigrationFiles(migrationsDir: string): string[] {
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function getPendingMigrations(migrationsDir: string, applied: ReadonlySet<string>): string[] {
  return listMigrationFiles(migrationsDir).filter((f) => !applied.has(f));
}

/** Only an empty ledger may receive the baseline. A ledger from before the 2026-10-16 squash
 * (or any other history) is refused before anything is written. */
function classifyLifecycleHistory(
  applied: ReadonlySet<string>,
  capturedAt: string
): LifecycleMigrationContext {
  if (applied.size > 0) throw new Error("Unsupported migration history.");
  return { kind: "fresh", preRunMigrationFiles: "[]", capturedAt };
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

  const hasLedger = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(MIGRATIONS_TABLE);
  const applied = hasLedger ? getAppliedMigrations(db) : new Set<string>();
  // A ledger entry this build does not ship (e.g. written by a newer build) means a schema this
  // code does not know; refuse it even when nothing is pending.
  const known = new Set(listMigrationFiles(migrationsDir));
  if ([...applied].some((fileName) => !known.has(fileName))) {
    throw new Error("Unsupported migration history.");
  }
  if (applied.has(BASELINE_MIGRATION)) {
    assertCompleteLifecycleMetadata(db);
  }

  const pending = getPendingMigrations(migrationsDir, applied);

  if (pending.length === 0) {
    return;
  }

  if (db.inTransaction) throw new Error("Cannot migrate within an active transaction");

  const lifecycleContext = pending.includes(BASELINE_MIGRATION)
    ? classifyLifecycleHistory(applied, new Date(now()).toISOString())
    : undefined;

  const recoveryPath = createPreMigrationBackup(db);
  ensureMigrationsTable(db);
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
  } catch (cause) {
    throw new Error(
      `Migration failed: ${cause instanceof Error ? cause.message : String(cause)}; pre-migration recovery point retained at ${recoveryPath}`,
      { cause }
    );
  } finally {
    db.pragma("foreign_keys = ON");
    if (lifecycleContext) {
      dropLifecycleContext(db);
    }
  }
}
