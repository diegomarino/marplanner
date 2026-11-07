import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import * as storageModule from "../../src/server/backups/storage";
import {
  createSnapshot,
  formatBackupFilename,
  resolveBackupsRoot,
  __resetBackupsStateForTests,
} from "../../src/server/backups/storage";
import {
  restoreDatabase,
  isQuiesced,
  isRestoreInProgress,
  __resetRestoreStateForTests,
} from "../../src/server/backups/restore";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";
import { BASELINE_FILE, execBaseline } from "../helpers/baseline";

/** ADR-030: a restore replaces household data, never who has access. The live `api_keys`
 * rows survive the swap: keys revoked since the backup stay revoked, keys created since the
 * backup keep working, and a key known only to the backup never becomes valid. */

interface KeyRow {
  id: string;
  key_hash: string;
  scope: string;
  kind: string;
  label: string | null;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
}

function insertKey(id: string, rawKey: string, label: string | null = null): void {
  getDb()
    .prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, label, created_at) VALUES (?, ?, '*', 'device', ?, ?)"
    )
    .run(id, hashKey(rawKey), label, Date.now());
}

function revokeKey(id: string): void {
  getDb().prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").run(Date.now(), id);
}

function allKeys(): KeyRow[] {
  return getDb().prepare("SELECT * FROM api_keys ORDER BY id").all() as KeyRow[];
}

function seedMember(id: string, displayName: string): void {
  const now = Date.now();
  getDb()
    .prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, 'child', 'active', ?, ?)"
    )
    .run(id, displayName, now, now);
}

function memberNames(): string[] {
  return (
    getDb().prepare("SELECT display_name FROM members ORDER BY display_name").all() as {
      display_name: string;
    }[]
  ).map((row) => row.display_name);
}

async function snapshotFilename(): Promise<string> {
  const outcome = await createSnapshot("snapshot");
  if (!outcome.ok) throw new Error(`Snapshot fixture failed: ${outcome.error}`);
  return outcome.filename;
}

function activateBackupsPlugin(): void {
  getDb()
    .prepare(
      "UPDATE plugin_activation_registry SET state = 'active', updated_at = ? WHERE plugin_id = 'backups'"
    )
    .run(new Date().toISOString());
}

describe("restore preserves live credentials (ADR-030)", () => {
  useIsolatedDb({ pluginState: "inactive" });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetBackupsStateForTests();
    __resetRestoreStateForTests();
  });

  it("keeps keys revoked since the backup revoked and keys created since the backup active", async () => {
    insertKey("key-a", "mpk-key-a", "Kitchen");
    seedMember("backup-member", "Backup member");
    const filename = await snapshotFilename();

    revokeKey("key-a");
    insertKey("key-b", "mpk-key-b", "Hallway");
    getDb().prepare("DELETE FROM members").run();
    seedMember("live-member", "Live member");
    const keysBefore = allKeys();

    const result = await restoreDatabase({ filename, confirmFilename: filename });

    expect(result.status).toBe("restored");
    // Household data comes from the backup …
    expect(memberNames()).toEqual(["Backup member"]);
    // … credentials stay exactly as they were before the restore.
    expect(allKeys()).toEqual(keysBefore);
    const keyA = allKeys().find((row) => row.id === "key-a");
    expect(keyA?.revoked_at).not.toBeNull();
    const keyB = allKeys().find((row) => row.id === "key-b");
    expect(keyB?.revoked_at).toBeNull();
  });

  it("never makes a key that existed only in the backup valid", async () => {
    insertKey("key-live", "mpk-key-live");
    insertKey("key-old", "mpk-key-old");
    const filename = await snapshotFilename();
    getDb().prepare("DELETE FROM api_keys WHERE id = 'key-old'").run();

    const result = await restoreDatabase({ filename, confirmFilename: filename });

    expect(result.status).toBe("restored");
    expect(allKeys().map((row) => row.id)).toEqual(["key-live"]);
    expect(
      getDb().prepare("SELECT id FROM api_keys WHERE key_hash = ?").get(hashKey("mpk-key-old"))
    ).toBeUndefined();
  });

  it("re-applies live credentials after migrating a backup that predates later migrations", async () => {
    insertKey("key-live", "mpk-key-live");
    const keysBefore = allKeys();
    const filename = formatBackupFilename("upload", Date.now());
    const backup = new Database(path.join(resolveBackupsRoot(), filename));
    try {
      backup.exec(
        "CREATE TABLE `drizzle_universe_migrations` (`fileName` TEXT PRIMARY KEY NOT NULL, `appliedAt` INTEGER NOT NULL)"
      );
      execBaseline(backup);
      backup
        .prepare(
          "INSERT INTO `drizzle_universe_migrations` (`fileName`, `appliedAt`) VALUES (?, ?)"
        )
        .run(BASELINE_FILE, Date.now());
      backup
        .prepare(
          "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES ('key-old', ?, '*', 'device', 0)"
        )
        .run(hashKey("mpk-key-old"));
    } finally {
      backup.close();
    }

    const result = await restoreDatabase({ filename, confirmFilename: filename });

    expect(result).toMatchObject({ status: "restored", migrated: true });
    expect(allKeys()).toEqual(keysBefore);
  });

  it("leaves credentials untouched when the restore fails after the swap", async () => {
    insertKey("key-a", "mpk-key-a");
    const filename = await snapshotFilename();
    revokeKey("key-a");
    insertKey("key-b", "mpk-key-b");
    seedMember("live-member", "Live member");
    const keysBefore = allKeys();

    const result = await restoreDatabase({ filename, confirmFilename: filename }, undefined, {
      reconcileAll: async () => {
        // The first call is the forward activation; fail it so restore rolls back.
        if (memberNames().length === 0) throw new Error("injected activation failure");
        return { results: [] };
      },
    });

    expect(result.status).toBe("migration_failed_rolled_back");
    expect(allKeys()).toEqual(keysBefore);
    expect(memberNames()).toEqual(["Live member"]);
    expect(isQuiesced()).toBe(false);
    expect(isRestoreInProgress()).toBe(false);
  });

  it("aborts before touching the database when the live credentials cannot be read", async () => {
    insertKey("key-a", "mpk-key-a");
    const filename = await snapshotFilename();
    insertKey("key-b", "mpk-key-b");
    seedMember("live-member", "Live member");
    const keysBefore = allKeys();
    const realCreateSnapshot = storageModule.createSnapshot;
    vi.spyOn(storageModule, "createSnapshot").mockImplementation(async (type) => {
      const outcome = await realCreateSnapshot(type);
      getDb().exec("ALTER TABLE api_keys RENAME TO api_keys_unreadable");
      return outcome;
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await restoreDatabase({ filename, confirmFilename: filename });

    expect(result.status).toBe("pre_restore_failed");
    getDb().exec("ALTER TABLE api_keys_unreadable RENAME TO api_keys");
    expect(allKeys()).toEqual(keysBefore);
    expect(memberNames()).toEqual(["Live member"]);
    expect(isQuiesced()).toBe(false);
  });

  it("rolls back to the pre-restore credentials when re-applying them fails", async () => {
    insertKey("key-a", "mpk-key-a");
    const filename = await snapshotFilename();
    revokeKey("key-a");
    insertKey("key-b", "mpk-key-b");
    seedMember("live-member", "Live member");
    const keysBefore = allKeys();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Break the re-apply insert; the rollback path never prepares it.
    const originalPrepare = Database.prototype.prepare;
    vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
      this: InstanceType<typeof Database>,
      source: string
    ) {
      if (source.startsWith("INSERT INTO `api_keys`")) {
        throw new Error("injected credential write failure");
      }
      return originalPrepare.call(this, source);
    });

    const result = await restoreDatabase({ filename, confirmFilename: filename });

    expect(result.status).toBe("incompatible_backup");
    expect(allKeys()).toEqual(keysBefore);
    expect(memberNames()).toEqual(["Live member"]);
    expect(isQuiesced()).toBe(false);
  });
});

describe("restore over HTTP keeps the requesting device connected (ADR-030)", () => {
  useIsolatedDb();
  afterEach(() => {
    __resetBackupsStateForTests();
    __resetRestoreStateForTests();
  });

  it("the device that requested the restore still works and a backup-only key is refused", async () => {
    activateBackupsPlugin();
    insertKey("key-old", "mpk-key-old");
    const filename = await snapshotFilename();
    getDb().prepare("DELETE FROM api_keys WHERE id = 'key-old'").run();
    insertKey("key-device", "mpk-key-device");

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const restore = await app.inject({
        method: "POST",
        url: "/api/backups/restore",
        cookies: { mp_device_key: "mpk-key-device" },
        payload: { filename, confirmFilename: filename },
      });
      expect(restore.statusCode).toBe(200);
      expect(restore.json()).toMatchObject({ status: "restored" });

      const device = await app.inject({
        method: "GET",
        url: "/api/backups",
        cookies: { mp_device_key: "mpk-key-device" },
      });
      expect(device.statusCode).toBe(200);

      const backupOnly = await app.inject({
        method: "GET",
        url: "/api/backups",
        cookies: { mp_device_key: "mpk-key-old" },
      });
      expect(backupOnly.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
