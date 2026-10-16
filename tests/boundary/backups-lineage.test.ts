import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import {
  createSnapshot,
  formatBackupFilename,
  resolveBackupsRoot,
} from "../../src/server/backups/storage";
import { __resetRestoreStateForTests, restoreDatabase } from "../../src/server/backups/restore";
import { useIsolatedDb } from "../helpers/db";

const BASELINE_FILE = "0000_baseline.sql";

function writeMetadataBackup(fileName: string, migrationFiles: string[]): void {
  const db = new Database(path.join(resolveBackupsRoot(), fileName));
  try {
    db.exec(
      "CREATE TABLE drizzle_universe_migrations (fileName TEXT PRIMARY KEY NOT NULL, appliedAt INTEGER NOT NULL)"
    );
    for (const migrationFile of migrationFiles) {
      db.prepare("INSERT INTO drizzle_universe_migrations (fileName, appliedAt) VALUES (?, ?)").run(
        migrationFile,
        1
      );
    }
  } finally {
    db.close();
  }
}

function nextSnapshotFilename(): string {
  const root = resolveBackupsRoot();
  return formatBackupFilename("snapshot", Date.now(), fs.readdirSync(root));
}

function seedAdminKey(): string {
  const rawKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  getDb()
    .prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    )
    .run(`lineage-${Date.now()}`, hashKey(rawKey), Date.now());
  return rawKey;
}

describe("backup restore lineage classification", () => {
  useIsolatedDb();
  afterEach(() => __resetRestoreStateForTests());

  it("accepts a sentinel-equal backup without a forward migration", async () => {
    const snapshot = await createSnapshot("snapshot");
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) throw new Error("snapshot fixture failed");

    const result = await restoreDatabase({
      filename: snapshot.filename,
      confirmFilename: snapshot.filename,
    });

    expect(result).toMatchObject({ status: "restored", migrated: false });
  });

  it("rejects a readable pre-baseline migration ledger as unsupported_lineage without exposing internals", async () => {
    const filename = nextSnapshotFilename();
    writeMetadataBackup(filename, ["0019_development_history.sql"]);

    const result = await restoreDatabase({ filename, confirmFilename: filename });

    expect(result).toEqual({
      status: "unsupported_lineage",
      message: "The selected backup is not from the supported baseline lineage",
    });
  });

  it("rejects a backup from before the 2026-10-16 migration squash as unsupported_lineage", async () => {
    const filename = nextSnapshotFilename();
    writeMetadataBackup(filename, [
      "0000_current_baseline.sql",
      "0001_calendar_feed_sync.sql",
      "0002_plugin_lifecycle.sql",
      "0003_calendar_event_details.sql",
      "0004_member_palette.sql",
      "0005_daily_briefing_schedule.sql",
    ]);

    const result = await restoreDatabase({ filename, confirmFilename: filename });

    expect(result).toEqual({
      status: "unsupported_lineage",
      message: "The selected backup is not from the supported baseline lineage",
    });
  });

  it("keeps an unknown future migration as downgrade_rejected", async () => {
    const filename = nextSnapshotFilename();
    writeMetadataBackup(filename, [BASELINE_FILE, "9999_future.sql"]);

    const result = await restoreDatabase({ filename, confirmFilename: filename });

    expect(result).toEqual({
      status: "downgrade_rejected",
      message: "The selected backup is newer than the running code",
    });
  });

  it("keeps unreadable files as incompatible_backup", async () => {
    const filename = nextSnapshotFilename();
    fs.writeFileSync(path.join(resolveBackupsRoot(), filename), "not a SQLite database");

    const result = await restoreDatabase({ filename, confirmFilename: filename });

    expect(result).toEqual({
      status: "incompatible_backup",
      message: "The selected file is not a compatible backup",
    });
  });

  it("returns unsupported_lineage as a typed 422 route result", async () => {
    const filename = nextSnapshotFilename();
    writeMetadataBackup(filename, ["0019_development_history.sql"]);
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/backups/restore",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ filename, confirmFilename: filename }),
        cookies: { mp_device_key: seedAdminKey() },
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body)).toEqual({
        status: "unsupported_lineage",
        message: "The selected backup is not from the supported baseline lineage",
      });
    } finally {
      await app.close();
    }
  });
});
