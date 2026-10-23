import fs from "node:fs";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { createSnapshot } from "../../src/server/backups/storage";
import { __resetRestoreStateForTests, restoreDatabase } from "../../src/server/backups/restore";
import { getDb, resetDb } from "../../src/server/db/client";
import { runMigrations } from "../../src/server/db/migrate";
import { runSeedProfile } from "../../src/server/db/seeds/runner";
import { useIsolatedDb } from "../helpers/db";

const AS_OF_DATE = "2026-09-23";
const NOW_MS = Date.parse("2026-09-23T12:00:00.000Z");
const BASELINE_FILE = "0000_baseline.sql";
const BASELINE_PATH = path.resolve(process.cwd(), "drizzle", BASELINE_FILE);
const CURRENT_MIGRATION_FILES = [BASELINE_FILE];

type Member = { id: string; displayName: string; lifecycle: string };
type BackupSnapshot = { ok: true; filename: string } | { ok: false; error: string };

describe("database lifecycle aggregate recovery journey", () => {
  useIsolatedDb();
  afterEach(() => __resetRestoreStateForTests());

  it("recovers the ordered public profile through a later migration while preserving ordinary and failed-restore targets", async () => {
    expect(appliedMigrationFiles()).toEqual(CURRENT_MIGRATION_FILES);

    const seed = await runSeedProfile({
      mode: "public",
      asOfDate: AS_OF_DATE,
      nowMs: NOW_MS,
      disposableTarget: true,
    });
    expect(seed).toMatchObject({
      asOfDate: AS_OF_DATE,
      markerAction: "created",
      status: "complete",
      moduleIds: [
        "public:settings",
        "members:demo",
        "calendar:demo",
        "routines:demo",
        "reminders:demo",
        "meals:demo",
        "daily:content:demo",
        "time:announcements:demo",
        "plugins:demo",
      ],
    });

    const deviceKey = seedDeviceKey();
    const app = await buildApp();
    try {
      // Constitution XII evidence: a real public-read boundary is healthy before the snapshot.
      const beforeSnapshot = await readMembers(app, deviceKey);
      expect(beforeSnapshot).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "demo:member:homer",
            displayName: "Homer",
            lifecycle: "active",
          }),
          expect.objectContaining({
            id: "demo:member:lisa",
            displayName: "Lisa",
            lifecycle: "active",
          }),
        ])
      );
      await expectPublicCalendarRead(app, deviceKey);

      const snapshot = (await createSnapshot("snapshot")) as BackupSnapshot;
      expect(snapshot.ok).toBe(true);
      if (!snapshot.ok) throw new Error(snapshot.error);

      await patchMember(app, deviceKey, "demo:member:homer", "Homer MUTATED");
      expect(
        (await readMembers(app, deviceKey)).find((member) => member.id === "demo:member:homer")
      ).toMatchObject({ displayName: "Homer MUTATED" });

      const migrationDirectory = makeMigrationsDirectory(
        "CREATE TABLE recovery_journey_probe (id INTEGER PRIMARY KEY NOT NULL, value TEXT NOT NULL);"
      );
      try {
        const restored = await restoreDatabase(
          { filename: snapshot.filename, confirmFilename: snapshot.filename },
          { migrationsDir: migrationDirectory }
        );
        expect(restored).toMatchObject({ status: "restored", migrated: true });
      } finally {
        rmSync(migrationDirectory, { recursive: true, force: true });
      }

      // The existing app instance must read the restored database, not a stale pre-swap handle.
      expect(
        (await readMembers(app, deviceKey)).find((member) => member.id === "demo:member:homer")
      ).toMatchObject({ displayName: "Homer" });
      expect(
        getDb()
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recovery_journey_probe'"
          )
          .get()
      ).toEqual({ name: "recovery_journey_probe" });

      await patchMember(app, deviceKey, "demo:member:homer", "Protected failed restore");
      const invalidMigrationDirectory = makeMigrationsDirectory("not valid SQL;");
      try {
        const failedRestore = await restoreDatabase(
          { filename: snapshot.filename, confirmFilename: snapshot.filename },
          { migrationsDir: invalidMigrationDirectory }
        );
        expect(failedRestore).toMatchObject({ status: "migration_failed_rolled_back" });
      } finally {
        rmSync(invalidMigrationDirectory, { recursive: true, force: true });
      }
      expect(
        (await readMembers(app, deviceKey)).find((member) => member.id === "demo:member:homer")
      ).toMatchObject({ displayName: "Protected failed restore" });

      await expect(
        runSeedProfile({
          mode: "public",
          asOfDate: AS_OF_DATE,
          nowMs: NOW_MS + 1,
          disposableTarget: false,
        })
      ).rejects.toThrow("explicitly designated disposable");
      expect(
        (await readMembers(app, deviceKey)).find((member) => member.id === "demo:member:homer")
      ).toMatchObject({ displayName: "Protected failed restore" });
    } finally {
      await app.close();
    }

    await expectOrdinaryHouseholdRefusal();
  });
});

function appliedMigrationFiles(): string[] {
  return (
    getDb().prepare("SELECT fileName FROM drizzle_universe_migrations ORDER BY fileName").all() as {
      fileName: string;
    }[]
  ).map((row) => row.fileName);
}

function makeMigrationsDirectory(laterMigrationSql: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), "mp-recovery-journey-"));
  fs.copyFileSync(BASELINE_PATH, path.join(directory, BASELINE_FILE));
  fs.writeFileSync(path.join(directory, "0001_recovery_journey_probe.sql"), laterMigrationSql);
  return directory;
}

function seedDeviceKey(): string {
  const rawKey = "mpk-recovery-journey-device";
  getDb()
    .prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    )
    .run("recovery-journey-device", hashKey(rawKey), NOW_MS);
  return rawKey;
}

async function buildApp(): Promise<FastifyInstance> {
  const { buildApp: createApp } = await import("../../src/server/app.ts");
  return createApp();
}

async function readMembers(app: FastifyInstance, deviceKey: string): Promise<Member[]> {
  const response = await app.inject({
    method: "GET",
    url: "/api/members",
    cookies: { mp_device_key: deviceKey },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as Member[];
}

async function expectPublicCalendarRead(app: FastifyInstance, deviceKey: string): Promise<void> {
  // Keep the fixed Calendar fixtures inside the production rolling window. Pin Date only for this
  // read: restoreDatabase's drain deadline needs a real clock.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_MS);
  let response;
  try {
    response = await app.inject({
      method: "GET",
      url: "/api/calendar/events?source=all&from=2026-09-23&to=2026-09-26",
      cookies: { mp_device_key: deviceKey },
    });
  } finally {
    vi.useRealTimers();
  }
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "demo:calendar:event:lisa-homework-club", source: "local" }),
    ])
  );
}

async function patchMember(
  app: FastifyInstance,
  deviceKey: string,
  id: string,
  displayName: string
): Promise<void> {
  const response = await app.inject({
    method: "PATCH",
    url: `/api/members/${id}`,
    payload: { displayName },
    cookies: { mp_device_key: deviceKey },
  });
  expect(response.statusCode).toBe(200);
}

async function expectOrdinaryHouseholdRefusal(): Promise<void> {
  const ordinaryDataDirectory = mkdtempSync(path.join(tmpdir(), "mp-ordinary-household-"));
  const previousDataDirectory = process.env.DATA_DIR;
  try {
    process.env.DATA_DIR = ordinaryDataDirectory;
    resetDb();
    runMigrations();
    expect(appliedMigrationFiles()).toEqual(CURRENT_MIGRATION_FILES);

    getDb()
      .prepare(
        "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, 'parent', 'active', ?, ?)"
      )
      .run("ordinary:member:parent", "Ordinary household parent", NOW_MS, NOW_MS);
    const beforeRefusal = ordinaryHouseholdState();

    await expect(
      runSeedProfile({
        mode: "public",
        asOfDate: AS_OF_DATE,
        nowMs: NOW_MS,
        disposableTarget: true,
      })
    ).rejects.toThrow("Seed target has an unrelated row in members during fresh baseline");

    expect(ordinaryHouseholdState()).toEqual(beforeRefusal);
  } finally {
    resetDb();
    process.env.DATA_DIR = previousDataDirectory;
    rmSync(ordinaryDataDirectory, { recursive: true, force: true });
  }
}

function ordinaryHouseholdState(): unknown {
  return {
    members: getDb()
      .prepare(
        "SELECT id, display_name, role, lifecycle, created_at, updated_at FROM members ORDER BY id"
      )
      .all(),
    seedMarkers: getDb()
      .prepare("SELECT profile, status FROM seed_profile_state ORDER BY profile")
      .all(),
    migrations: appliedMigrationFiles(),
  };
}
