import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { hashKey } from "../../src/server/auth/credentials.js";
import { BACKUPS_JOB_ID, registerBackupsJob } from "../../src/server/backups/job.js";
import { restoreDatabase } from "../../src/server/backups/restore.js";
import {
  __resetBackupsStateForTests,
  createSnapshot,
  listBackups,
  resolveBackupsRoot,
} from "../../src/server/backups/storage.js";
import { getDb } from "../../src/server/db/client.js";
import { createServerPluginRuntime } from "../../src/server/plugins/runtime.js";
import { SqlitePluginLifecycleStore } from "../../src/server/plugins/store.js";
import {
  configurePluginJobLifecycleGate,
  getScheduler,
  initScheduler,
} from "../../src/server/scheduler/index.js";
import { useIsolatedDb } from "../helpers/db.js";
import { FakeClock, noopLog } from "../helpers/fake-clock.js";

const NOW = "2026-09-28T10:15:30.000Z";

function createInactiveRuntime() {
  return createServerPluginRuntime({
    store: new SqlitePluginLifecycleStore(getDb()),
    now: () => NOW,
    operationId: (pluginId) => `backups-boundary-${pluginId}`,
    drainDeadline: () => ({ expiresAt: "2026-09-28T10:20:30.000Z" }),
  });
}

function seedAdminKey(): string {
  const rawKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  getDb()
    .prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    )
    .run(`key-${Date.now()}`, hashKey(rawKey), Date.now());
  return rawKey;
}

function seedMember(id: string, displayName: string): void {
  const now = Date.now();
  getDb()
    .prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, 'child', 'active', ?, ?)"
    )
    .run(id, displayName, now, now);
}

describe("Backups plugin boundary (Slice 026 T013, FR-019)", () => {
  useIsolatedDb({ pluginState: "inactive" });

  afterEach(async () => {
    vi.useRealTimers();
    configurePluginJobLifecycleGate(undefined);
    __resetBackupsStateForTests();
    try {
      await getScheduler().stop();
    } catch {
      // A test that never initialized the singleton has nothing to stop.
    }
  });

  it("blocks scheduled and manual product job claims while Backups is inactive", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startMs = Date.UTC(2026, 8, 28, 10, 0, 0);
    vi.setSystemTime(startMs);
    const clock = new FakeClock(startMs, (ms) => vi.setSystemTime(ms));
    initScheduler({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      log: noopLog(),
    });
    registerBackupsJob();
    const runtime = createInactiveRuntime();

    expect(runtime.isContributionActive("backups")).toBe(false);
    await getScheduler().start();
    await clock.flush();
    expect(getScheduler().getJobState(BACKUPS_JOB_ID)?.lastRunAt).toBeNull();
    expect(listBackups()).toEqual([]);

    await expect(getScheduler().runJobNow(BACKUPS_JOB_ID, { source: "snapshot" })).resolves.toEqual(
      { status: "already_running" }
    );
    expect(listBackups()).toEqual([]);
  });

  it("makes every ordinary Backups management route unavailable while inactive", async () => {
    const runtime = createInactiveRuntime();
    const deviceKey = seedAdminKey();
    const { buildApp } = await import("../../src/server/app.js");
    const app = await buildApp({ pluginLifecycle: runtime.lifecycle });
    const filename = "snapshot-20260928-120000-000.db";
    const requests = [
      { method: "GET", url: "/api/backups" },
      { method: "POST", url: "/api/backups/snapshot" },
      {
        method: "POST",
        url: "/api/backups/restore",
        payload: { filename, confirmFilename: filename },
      },
      { method: "DELETE", url: `/api/backups/${filename}` },
      { method: "GET", url: `/api/backups/${filename}/download` },
      { method: "GET", url: `/api/backups/${filename}/download-sql` },
      {
        method: "POST",
        url: "/api/backups/upload",
        headers: { "content-type": "application/octet-stream" },
        payload: Buffer.from("not reached"),
      },
    ] as const;

    try {
      for (const request of requests) {
        const response = await app.inject({
          ...request,
          cookies: { mp_device_key: deviceKey },
        });
        expect(response.statusCode, `${request.method} ${request.url}`).toBe(503);
        expect(JSON.parse(response.body)).toEqual({
          code: "plugin_unavailable",
          message: "This plugin is unavailable.",
        });
      }
    } finally {
      await app.close();
    }
  });

  it("keeps pre-snapshot, restore validation, integrity/read smoke, and restore execution below lifecycle", async () => {
    const runtime = createInactiveRuntime();
    expect(runtime.isContributionActive("backups")).toBe(false);

    seedMember("member-1", "Before snapshot");
    const candidate = await createSnapshot("snapshot");
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) throw new Error("unreachable");

    getDb()
      .prepare("UPDATE members SET display_name = 'After snapshot' WHERE id = 'member-1'")
      .run();

    const validation = await restoreDatabase({
      filename: candidate.filename,
      confirmFilename: "wrong-filename.db",
    });
    expect(validation.status).toBe("confirmation_mismatch");

    const restored = await restoreDatabase({
      filename: candidate.filename,
      confirmFilename: candidate.filename,
    });
    expect(restored.status).toBe("restored");
    expect(
      getDb()
        .prepare("SELECT display_name AS displayName FROM members WHERE id = ?")
        .get("member-1")
    ).toEqual({ displayName: "Before snapshot" });
    expect(listBackups().some(({ type }) => type === "pre-restore")).toBe(true);
    expect(fs.existsSync(path.join(resolveBackupsRoot(), candidate.filename))).toBe(true);
  });

  it("catalogs only optional Backups contributions and never presents host safety controls as disabled services", async () => {
    const runtime = createInactiveRuntime();
    const backups = (await runtime.lifecycle.listCatalog()).find(({ id }) => id === "backups");

    expect(backups).toMatchObject({
      state: "inactive",
      contributions: {
        routes: ["backups-api"],
        admin: ["backups"],
        settings: [],
        widgets: [],
        services: [],
        jobs: ["backups-nightly"],
      },
    });
    expect(JSON.stringify(backups?.contributions)).not.toMatch(
      /pre-restore|integrity|read-boundary|rollback|quiesce|migration/i
    );
  });
});
