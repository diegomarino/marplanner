import fs from "node:fs";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/server/db/client";
import { formatBackupFilename, resolveBackupsRoot } from "../../src/server/backups/storage";
import { __resetRestoreStateForTests, restoreDatabase } from "../../src/server/backups/restore";
import { useIsolatedDb } from "../helpers/db";

const BASELINE_FILE = "0000_current_baseline.sql";
const BASELINE_PATH = path.join(process.cwd(), "drizzle", BASELINE_FILE);

function writeBaselineBackup(filename: string): void {
  const db = new Database(path.join(resolveBackupsRoot(), filename));
  try {
    db.exec(fs.readFileSync(BASELINE_PATH, "utf-8"));
    db.exec(
      "CREATE TABLE drizzle_universe_migrations (fileName TEXT PRIMARY KEY NOT NULL, appliedAt INTEGER NOT NULL)"
    );
    db.prepare("INSERT INTO drizzle_universe_migrations (fileName, appliedAt) VALUES (?, ?)").run(
      BASELINE_FILE,
      1
    );
  } finally {
    db.close();
  }
}

function nextSnapshotFilename(): string {
  const root = resolveBackupsRoot();
  return formatBackupFilename("snapshot", Date.now(), fs.readdirSync(root));
}

function insertActiveMember(displayName: string): void {
  const now = Date.now();
  getDb()
    .prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, 'child', 'active', ?, ?)"
    )
    .run(`active-${now}`, displayName, now, now);
}

function activeMemberNames(): string[] {
  return (
    getDb().prepare("SELECT display_name FROM members ORDER BY display_name").all() as {
      display_name: string;
    }[]
  ).map((row) => row.display_name);
}

function makeMigrationsDirectory(sql: string): string {
  const migrationsDir = mkdtempSync(path.join(tmpdir(), "backups-lineage-"));
  fs.copyFileSync(BASELINE_PATH, path.join(migrationsDir, BASELINE_FILE));
  fs.writeFileSync(path.join(migrationsDir, "0001_lineage_probe.sql"), sql);
  return migrationsDir;
}

describe("backup restore lineage integration", () => {
  useIsolatedDb();
  afterEach(() => __resetRestoreStateForTests());

  it("restores a baseline backup and applies a temporary later migration", async () => {
    const migrationsDir = makeMigrationsDirectory(
      "CREATE TABLE lineage_probe (id INTEGER PRIMARY KEY NOT NULL, value TEXT NOT NULL);"
    );
    try {
      const filename = nextSnapshotFilename();
      writeBaselineBackup(filename);

      const result = await restoreDatabase(
        { filename, confirmFilename: filename },
        { migrationsDir }
      );

      expect(result).toMatchObject({ status: "restored", migrated: true });
      expect(
        getDb()
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lineage_probe'")
          .get()
      ).toEqual({ name: "lineage_probe" });
      expect(
        getDb().prepare("SELECT fileName FROM drizzle_universe_migrations ORDER BY fileName").all()
      ).toEqual([{ fileName: BASELINE_FILE }, { fileName: "0001_lineage_probe.sql" }]);
      expect(
        getDb()
          .prepare(
            "SELECT name FROM sqlite_master WHERE name IN ('backup_manifest', 'backup_audit')"
          )
          .all()
      ).toEqual([]);
    } finally {
      rmSync(migrationsDir, { recursive: true, force: true });
    }
  });

  it("rolls back to active data when a temporary later migration fails", async () => {
    const migrationsDir = makeMigrationsDirectory("not valid SQL;");
    try {
      insertActiveMember("Protected active data");
      const filename = nextSnapshotFilename();
      writeBaselineBackup(filename);

      const result = await restoreDatabase(
        { filename, confirmFilename: filename },
        { migrationsDir }
      );

      expect(result).toMatchObject({ status: "migration_failed_rolled_back" });
      expect(activeMemberNames()).toEqual(["Protected active data"]);
    } finally {
      rmSync(migrationsDir, { recursive: true, force: true });
    }
  });
});
