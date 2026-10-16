import fs from "node:fs";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/server/db/client";
import { formatBackupFilename, resolveBackupsRoot } from "../../src/server/backups/storage";
import { __resetRestoreStateForTests, restoreDatabase } from "../../src/server/backups/restore";
import { BASELINE_FILE, BASELINE_PATH, execBaseline } from "../helpers/baseline";
import { useIsolatedDb } from "../helpers/db";

function writeBaselineBackup(filename: string): void {
  const db = new Database(path.join(resolveBackupsRoot(), filename));
  try {
    execBaseline(db);
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

  it("rolls back active data and retains pre-restore snapshot when pre-migration recovery is blocked", async () => {
    const migrationsDir = makeMigrationsDirectory(
      "CREATE TABLE lineage_probe (id INTEGER PRIMARY KEY NOT NULL);"
    );
    const root = resolveBackupsRoot();
    const lane = path.join(root, "pre-migration");
    const retainedLane = path.join(root, "pre-migration-retained");
    fs.renameSync(lane, retainedLane);
    fs.writeFileSync(lane, "blocked recovery lane");
    try {
      insertActiveMember("Protected recovery failure data");
      const filename = nextSnapshotFilename();
      writeBaselineBackup(filename);

      const result = await restoreDatabase(
        { filename, confirmFilename: filename },
        { migrationsDir }
      );

      expect(result).toMatchObject({ status: "migration_failed_rolled_back" });
      expect(activeMemberNames()).toEqual(["Protected recovery failure data"]);
      expect(
        getDb().prepare("SELECT name FROM sqlite_schema WHERE name = 'lineage_probe'").get()
      ).toBeUndefined();
      const preRestore = fs.readdirSync(root).filter((name) => name.startsWith("pre-restore-"));
      expect(preRestore).toHaveLength(1);
      const snapshot = new Database(path.join(root, preRestore[0]), {
        readonly: true,
        fileMustExist: true,
      });
      try {
        expect(snapshot.prepare("SELECT display_name FROM members").all()).toEqual([
          { display_name: "Protected recovery failure data" },
        ]);
        expect(snapshot.pragma("integrity_check", { simple: true })).toBe("ok");
      } finally {
        snapshot.close();
      }
    } finally {
      fs.unlinkSync(lane);
      fs.renameSync(retainedLane, lane);
      rmSync(migrationsDir, { recursive: true, force: true });
    }
  });
});
