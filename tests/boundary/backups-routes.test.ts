import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, it, expect, afterEach, vi } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import * as storageModule from "../../src/server/backups/storage";
import {
  createSnapshot,
  formatBackupFilename,
  resolveBackupsRoot,
  listBackups,
  UPLOAD_MAX_BYTES,
} from "../../src/server/backups/storage";
import {
  __resetRestoreStateForTests,
  __setRestoreInProgressForTests,
} from "../../src/server/backups/restore";
import { useIsolatedDb } from "../helpers/db";
import type { PluginLifecycle } from "../../src/server/plugins/lifecycle";

/** Review — `POST /api/backups/snapshot` when the scheduler singleton was never initialized
 * (the DEFAULT posture for `buildApp`-only boundary tests, and for the real e2e/dev process
 * under `SCHEDULER_DISABLED=1` — src/server/index.ts's `startScheduler` doc comment; Vitest
 * isolates each test FILE's module registry by default, so this file's own `scheduler/index.ts`
 * singleton is guaranteed `null` here, never leaked from another suite). Before the fix,
 * `getScheduler`'s thrown "Scheduler: not initialized…" fell through to Fastify's raw default
 * error envelope (a 500 with an internal message) — violating the contract's closed
 * `BackupsError` shape. Now caught and mapped to a stable, English, internals-free 503.
 */
describe("backups routes — scheduler-unavailable fail-safe (review F6)", () => {
  useIsolatedDb();

  function seedAdminKey(): string {
    activateBackupsPlugin();
    const rawKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
      )
      .run(id, hashKey(rawKey), Date.now());
    return rawKey;
  }

  it("POST /api/backups/snapshot with no scheduler initialized returns 503 scheduler_unavailable (contract envelope, no leaked internals)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedAdminKey();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/backups/snapshot",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      // Contract-shaped BackupsError: exactly {error, message}, both strings.
      expect(Object.keys(body).sort()).toEqual(["error", "message"]);
      expect(body.error).toBe("scheduler_unavailable");
      expect(typeof body.message).toBe("string");
      // Never leak the scheduler's own internal thrown text.
      expect(body.message).not.toMatch(/not initialized/i);
      expect(body.message).not.toMatch(/getScheduler/i);
    } finally {
      await app.close();
    }
  });
});

/** — the envelope (delete/download/download-sql/upload). Trace tags exercised across this
 * block: BACKUPS-INV-06, BACKUPS-INV-07, BACKUPS-INV-08, BACKUPS-AC-03, BACKUPS-AC-05.
 */
function seedAdminKey(): string {
  activateBackupsPlugin();
  const rawKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  getDb()
    .prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    )
    .run(id, hashKey(rawKey), Date.now());
  return rawKey;
}

function seedScopedKey(scope: string): string {
  activateBackupsPlugin();
  const rawKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  getDb()
    .prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, ?, 'device', ?)"
    )
    .run(id, hashKey(rawKey), scope, Date.now());
  return rawKey;
}

function activateBackupsPlugin(): void {
  getDb()
    .prepare(
      "UPDATE plugin_activation_registry SET state = 'active', updated_at = ? WHERE plugin_id = 'backups'"
    )
    .run(new Date().toISOString());
}

/** A genuine, minimal SQLite file (opens cleanly, has a real table) — used everywhere a route
 * needs "some bytes that pass isValidSqliteFile", without depending on the real household schema
 * or drizzle_universe_migrations (that gate is exercised separately, at the restore layer, not
 * here). */
function writeGenuineSqliteFile(filePath: string): void {
  const db = new Database(filePath);
  try {
    db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO probe (value) VALUES (?)").run("hello");
  } finally {
    db.close();
  }
}

describe("POST /api/backups/restore — live lifecycle handoff", () => {
  useIsolatedDb();
  afterEach(() => __resetRestoreStateForTests());

  it("rejects invalid, missing and concurrent restore requests without changing household data or the shelf", async () => {
    const deviceKey = seedAdminKey();
    const snapshot = await createSnapshot("snapshot");
    if (!snapshot.ok) throw new Error(`Snapshot fixture failed: ${snapshot.error}`);
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    const membersBefore = getDb().prepare("SELECT * FROM members ORDER BY id").all();
    const shelfBefore = listBackups()
      .map((backup) => backup.filename)
      .sort();
    try {
      const absent = "snapshot-20260615-120000-000.db";
      for (const [payload, statusCode, status] of [
        [{}, 400, "validation_error"],
        [{ filename: snapshot.filename, confirmFilename: "wrong" }, 400, "confirmation_mismatch"],
        [{ filename: absent, confirmFilename: absent }, 404, "not_found"],
        [
          { filename: snapshot.filename, confirmFilename: snapshot.filename },
          409,
          "restore_in_progress",
        ],
      ] as const) {
        __setRestoreInProgressForTests(statusCode === 409);
        const response = await app.inject({
          method: "POST",
          url: "/api/backups/restore",
          cookies: { mp_device_key: deviceKey },
          payload,
        });
        expect(response.statusCode).toBe(statusCode);
        expect(response.json()).toEqual({ status, message: expect.any(String) });
        expect(getDb().prepare("SELECT * FROM members ORDER BY id").all()).toEqual(membersBefore);
        expect(
          listBackups()
            .map((backup) => backup.filename)
            .sort()
        ).toEqual(shelfBefore);
      }
    } finally {
      __resetRestoreStateForTests();
      await app.close();
    }
  });

  it("passes the app lifecycle into restore reconciliation before returning success", async () => {
    const deviceKey = seedAdminKey();
    const snapshot = await createSnapshot("snapshot");
    if (!snapshot.ok) throw new Error(`Snapshot fixture failed: ${snapshot.error}`);
    let reconcileCalls = 0;
    const lifecycle: PluginLifecycle = {
      listCatalog: async () => [],
      activate: async () => {
        throw new Error("not used");
      },
      deactivate: async () => {
        throw new Error("not used");
      },
      reportFault: async () => undefined,
      reconcileAll: async () => {
        reconcileCalls += 1;
        return { results: [] };
      },
      isActive: () => true,
      canClaimWork: () => true,
    };
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp({ pluginLifecycle: lifecycle });
    try {
      expect(reconcileCalls).toBe(1);
      const response = await app.inject({
        method: "POST",
        url: "/api/backups/restore",
        cookies: { mp_device_key: deviceKey },
        payload: { filename: snapshot.filename, confirmFilename: snapshot.filename },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "restored" });
      expect(reconcileCalls).toBe(2);
    } finally {
      await app.close();
    }
  });
});

const ENVELOPE_ROUTE_PROBES: {
  name: string;
  method: "DELETE" | "GET" | "POST";
  makeUrl: () => string;
}[] = [
  {
    name: "DELETE /api/backups/:filename",
    method: "DELETE",
    makeUrl: () => "/api/backups/scheduled-20260615-120000-000.db",
  },
  {
    name: "GET /api/backups/:filename/download",
    method: "GET",
    makeUrl: () => "/api/backups/scheduled-20260615-120000-000.db/download",
  },
  {
    name: "GET /api/backups/:filename/download-sql",
    method: "GET",
    makeUrl: () => "/api/backups/scheduled-20260615-120000-000.db/download-sql",
  },
  {
    name: "POST /api/backups/upload",
    method: "POST",
    makeUrl: () => "/api/backups/upload",
  },
];

describe("backups envelope routes — capability fail-closed on EVERY route (BACKUPS-INV-08)", () => {
  useIsolatedDb();
  afterEach(() => __resetRestoreStateForTests());

  for (const probe of ENVELOPE_ROUTE_PROBES) {
    it(`BACKUPS-INV-08: ${probe.name} rejects a request with NO device key cookie (401)`, async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const app = await buildApp();
      try {
        const res = await app.inject({ method: probe.method, url: probe.makeUrl() });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it(`BACKUPS-INV-08: ${probe.name} rejects a VALID key whose scope does not include backups:admin (403)`, async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const scopedKey = seedScopedKey("some:other-scope");
      const app = await buildApp();
      try {
        const res = await app.inject({
          method: probe.method,
          url: probe.makeUrl(),
          cookies: { mp_device_key: scopedKey },
        });
        expect(res.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    });
  }
});

describe("DELETE /api/backups/:filename (BACKUPS-INV-05, BACKUPS-INV-07, BACKUPS-AC-05)", () => {
  useIsolatedDb();
  afterEach(() => __resetRestoreStateForTests());

  it("BACKUPS-INV-07/BACKUPS-AC-05: an invalid/traversal filename is rejected (400), never reaching the filesystem", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedAdminKey();
    const app = await buildApp();
    try {
      for (const bad of ["..%2Fetc%2Fpasswd", "snapshot-20260615-120000-000.sql", "not-a-backup"]) {
        const res = await app.inject({
          method: "DELETE",
          url: `/api/backups/${encodeURIComponent(bad)}`,
          cookies: { mp_device_key: deviceKey },
        });
        expect(res.statusCode).toBe(400);
      }
    } finally {
      await app.close();
    }
  });

  it("BACKUPS-AC-05: a well-formed but never-written filename is not_found (404)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedAdminKey();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/backups/snapshot-20260615-120000-000.db",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error).toBe("not_found");
    } finally {
      await app.close();
    }
  });

  it("F9 (through the HTTP route, not just the pure resolver): a SYMLINK planted under an allowlisted name is rejected as not_found (404), not deleted", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedAdminKey();
    const root = resolveBackupsRoot();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "mp-outside-"));
    const secretPath = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(secretPath, "must never be reachable via a backup filename");
    const symlinkName = "snapshot-20260615-120000-000.db";
    fs.symlinkSync(secretPath, path.join(root, symlinkName));

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/backups/${symlinkName}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(404);
      expect(fs.existsSync(secretPath)).toBe(true); // the symlink TARGET was never touched
    } finally {
      await app.close();
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("F9/P3-1 (through the HTTP route): a HARDLINKED file under an allowlisted name is rejected as not_found (404)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedAdminKey();
    const root = resolveBackupsRoot();
    const originalName = "snapshot-20260615-120000-001.db";
    fs.writeFileSync(path.join(root, originalName), "genuine backup bytes");
    const hardlinkName = "snapshot-20260615-120000-000.db";
    fs.linkSync(path.join(root, originalName), path.join(root, hardlinkName));

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/backups/${hardlinkName}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("BACKUPS-INV-05: refuses a delete that would drop the regular shelf below its retention floor (409 retention_floor)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedAdminKey();
    const outcome = await createSnapshot("scheduled"); // the ONLY regular backup on the shelf
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/backups/${outcome.filename}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toBe("retention_floor");
      expect(listBackups().some((b) => b.filename === outcome.filename)).toBe(true); // untouched
    } finally {
      await app.close();
    }
  });

  it("BACKUPS-INV-05/FR-009: refuses deleting a pre-restore-type backup while a restore is in progress (409 protected_pre_restore)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedAdminKey();
    const root = resolveBackupsRoot();
    const preRestoreFilename = formatBackupFilename("pre-restore", Date.now());
    fs.writeFileSync(path.join(root, preRestoreFilename), "pre-restore bytes");

    __setRestoreInProgressForTests(true);
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/backups/${preRestoreFilename}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toBe("protected_pre_restore");
      expect(fs.existsSync(path.join(root, preRestoreFilename))).toBe(true); // untouched
    } finally {
      await app.close();
      __setRestoreInProgressForTests(false);
    }
  });

  it("a non-pre-restore delete is NOT blocked by an in-progress restore (204) — see routes/backups.ts's doc comment for why", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedAdminKey();
    // Two regular backups so the floor never blocks this delete either.
    await createSnapshot("scheduled");
    const second = await createSnapshot("snapshot");
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");

    __setRestoreInProgressForTests(true);
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/backups/${second.filename}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(204);
    } finally {
      await app.close();
      __setRestoreInProgressForTests(false);
    }
  });

  it("204 on a genuine successful delete; the file is actually removed and stops listing", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedAdminKey();
    await createSnapshot("scheduled");
    const target = await createSnapshot("snapshot");
    expect(target.ok).toBe(true);
    if (!target.ok) throw new Error("unreachable");

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/backups/${target.filename}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe("");
      expect(listBackups().some((b) => b.filename === target.filename)).toBe(false);
      expect(fs.existsSync(path.join(resolveBackupsRoot(), target.filename))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("F2 (review #637/#640): a successful delete also sweeps the target's -wal/-shm sidecars", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedAdminKey();
    await createSnapshot("scheduled");
    const target = await createSnapshot("snapshot");
    expect(target.ok).toBe(true);
    if (!target.ok) throw new Error("unreachable");
    const targetPath = path.join(resolveBackupsRoot(), target.filename);
    // Simulate sidecars left behind by an earlier readonly open (isValidSqliteFile/download-sql)
    // — nothing sweeps these on its own; the DELETE route must.
    fs.writeFileSync(`${targetPath}-wal`, "leftover wal bytes");
    fs.writeFileSync(`${targetPath}-shm`, "leftover shm bytes");

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/backups/${target.filename}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(204);
      expect(fs.existsSync(`${targetPath}-wal`)).toBe(false);
      expect(fs.existsSync(`${targetPath}-shm`)).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe("GET /api/backups/:filename/download (BACKUPS-INV-07, BACKUPS-AC-05)", () => {
  useIsolatedDb();

  it("400 for an invalid filename; 404 for a well-formed one that was never written", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedAdminKey();
    const app = await buildApp();
    try {
      const invalid = await app.inject({
        method: "GET",
        url: "/api/backups/not-a-backup/download",
        cookies: { mp_device_key: deviceKey },
      });
      expect(invalid.statusCode).toBe(400);

      const missing = await app.inject({
        method: "GET",
        url: "/api/backups/snapshot-20260615-120000-000.db/download",
        cookies: { mp_device_key: deviceKey },
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("streams the exact backup bytes with an octet-stream content-type and a matching content-disposition", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedAdminKey();
    const outcome = await createSnapshot("scheduled");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    const expectedBytes = fs.readFileSync(path.join(resolveBackupsRoot(), outcome.filename));

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/backups/${outcome.filename}/download`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("application/octet-stream");
      expect(res.headers["content-disposition"]).toContain(outcome.filename);
      expect(Buffer.compare(res.rawPayload, expectedBytes)).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("F1/F9 (through the download route): a SYMLINK planted under an allowlisted name is rejected as not_found (404), never streamed", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedAdminKey();
    const root = resolveBackupsRoot();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "mp-outside-dl-"));
    const secretPath = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(secretPath, "must never be reachable via a backup filename");
    const symlinkName = "snapshot-20260615-120000-000.db";
    fs.symlinkSync(secretPath, path.join(root, symlinkName));

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/backups/${symlinkName}/download`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(404);
      expect(res.rawPayload.includes(Buffer.from("must never be reachable"))).toBe(false);
    } finally {
      await app.close();
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("P2-2 (review fold): the route genuinely depends on openExistingBackupFd's verdict — forcing it to reject an OTHERWISE-VALID, resolver-passing file still 404s, never falling back to a path-based read", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedAdminKey();
    const outcome = await createSnapshot("scheduled");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    // A genuine backup that passes resolveExistingBackupPath (lstat/realpath) with room to spare —
    // the ONLY thing standing between this request and a 200 with real bytes is whatever the
    // route does with openExistingBackupFd's return value.
    const fdSpy = vi.spyOn(storageModule, "openExistingBackupFd").mockReturnValue(null);
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/backups/${outcome.filename}/download`,
        cookies: { mp_device_key: deviceKey },
      });
      // A mutant that reverts to a plain `fs.createReadStream(resolved)` (path-based, ignoring
      // this mock's null) would still find the genuine file on disk and return 200 — this
      // assertion is what pins the fd-based wiring itself, not just the earlier resolver.
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error).toBe("not_found");
    } finally {
      fdSpy.mockRestore();
      await app.close();
    }
  });
});

describe("GET /api/backups/:filename/download-sql (BACKUPS-INV-06, BACKUPS-AC-03)", () => {
  useIsolatedDb();

  it("400 for an invalid filename; 404 for a well-formed one that was never written", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedAdminKey();
    const app = await buildApp();
    try {
      const invalid = await app.inject({
        method: "GET",
        url: "/api/backups/not-a-backup/download-sql",
        cookies: { mp_device_key: deviceKey },
      });
      expect(invalid.statusCode).toBe(400);

      const missing = await app.inject({
        method: "GET",
        url: "/api/backups/snapshot-20260615-120000-000.db/download-sql",
        cookies: { mp_device_key: deviceKey },
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("F1/F9 (through the download-sql route): a SYMLINK planted under an allowlisted name is rejected as not_found (404), never dumped", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedAdminKey();
    const root = resolveBackupsRoot();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "mp-outside-dlsql-"));
    const secretPath = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(secretPath, "must never be reachable via a backup filename");
    const symlinkName = "snapshot-20260615-120000-000.db";
    fs.symlinkSync(secretPath, path.join(root, symlinkName));

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/backups/${symlinkName}/download-sql`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("BACKUPS-INV-06/BACKUPS-AC-03: a non-SQLite file on the shelf is rejected (400 invalid_backup_file)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedAdminKey();
    const root = resolveBackupsRoot();
    const filename = formatBackupFilename("upload", Date.now());
    fs.writeFileSync(path.join(root, filename), "-- this is a .sql text script, not a database\n");

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/backups/${filename}/download-sql`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe("invalid_backup_file");
    } finally {
      await app.close();
    }
  });

  it("BACKUPS-AC-03: produces a textual, human-inspectable dump that documents itself as NOT re-importable", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedAdminKey();
    const outcome = await createSnapshot("scheduled");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/backups/${outcome.filename}/download-sql`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/plain");
      expect(res.body).toContain("NOT re-importable");
      expect(res.body).toContain("CREATE TABLE");
      expect(res.body).toMatch(/INSERT INTO/);
    } finally {
      await app.close();
    }
  });

  it("P2-2 (review fold): the SQL-dump generator genuinely depends on its own openExistingBackupFd re-validation — forcing it to reject an OTHERWISE-VALID file never leaks the real dump content", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedAdminKey();
    const outcome = await createSnapshot("scheduled");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    // This mock affects BOTH the earlier resolver-adjacent checks and the generator's own
    // immediately-before-open revalidation — a genuine backup that would otherwise dump cleanly
    // (as the test above proves) must never leak real content once this fails.
    const fdSpy = vi.spyOn(storageModule, "openExistingBackupFd").mockReturnValue(null);
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/backups/${outcome.filename}/download-sql`,
        cookies: { mp_device_key: deviceKey },
      });
      // A mutant that deletes the generator's own re-validation call (dumpBackupSqlChunks
      // opening `dbPath` unconditionally) would still find the genuine file on disk and stream
      // the real dump — this is what pins that the fd-layer check is actually consulted, not the
      // earlier resolver alone.
      expect(res.statusCode).not.toBe(200);
      expect(res.body).not.toContain("CREATE TABLE");
      expect(res.body).not.toMatch(/INSERT INTO/);
    } finally {
      fdSpy.mockRestore();
      await app.close();
    }
  });

  it("P2 (Codex on #681, review fold): a successful download-sql export does NOT sweep the source file's -wal/-shm sidecars — they may belong to another concurrent reader of the SAME shelf file", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedAdminKey();
    const outcome = await createSnapshot("scheduled");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    const backupPath = path.join(resolveBackupsRoot(), outcome.filename);
    // Simulate sidecars belonging to ANOTHER, still-open connection on this exact shelf file
    // (e.g. an overlapping second download-sql request, or a restore's version gate) — this
    // export's own finally block must leave them alone; unlinking them here would race that
    // other connection's shared SQLite lock/state (Fastify serves overlapping requests even
    // single-instance).
    fs.writeFileSync(`${backupPath}-wal`, "another connection's live wal bytes");
    fs.writeFileSync(`${backupPath}-shm`, "another connection's live shm bytes");

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/backups/${outcome.filename}/download-sql`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      expect(fs.existsSync(`${backupPath}-wal`)).toBe(true);
      expect(fs.existsSync(`${backupPath}-shm`)).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/backups/upload (BACKUPS-INV-06, BACKUPS-AC-03, research D10)", () => {
  useIsolatedDb();

  it("BACKUPS-INV-06: rejects a non-SQLite payload (the actual .sql-rejection mechanism — 400 invalid_backup_file)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedAdminKey();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/backups/upload",
        headers: { "content-type": "application/octet-stream" },
        payload: Buffer.from("-- plain SQL text, not a SQLite file\nSELECT 1;\n"),
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe("invalid_backup_file");
      expect(listBackups()).toHaveLength(0); // nothing landed on the shelf
    } finally {
      await app.close();
    }
  });

  it("research D10: an oversized upload is rejected (413) and writes ZERO bytes to the shelf", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedAdminKey();
    const app = await buildApp();
    const root = resolveBackupsRoot();
    const shelfTree = () =>
      fs
        .readdirSync(root, { recursive: true, encoding: "utf8" })
        .sort()
        .map((name) => {
          const file = path.join(root, name);
          return [name, fs.statSync(file).isFile() ? fs.readFileSync(file) : null];
        });
    const before = shelfTree();
    const writeSpy = vi.spyOn(fs, "writeFileSync");
    try {
      // Fastify's own raw-body parser checks the DECLARED Content-Length against the cap BEFORE
      // reading any data — a spoofed header with a tiny actual payload proves the "before any
      // disk write" guarantee without allocating a real 64MB+ buffer in this test.
      const res = await app.inject({
        method: "POST",
        url: "/api/backups/upload",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(UPLOAD_MAX_BYTES + 1024),
        },
        payload: Buffer.from("tiny"),
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(413);
      expect(JSON.parse(res.body).error).toBe("upload_too_large");
      expect(listBackups()).toHaveLength(0);
      expect(writeSpy).not.toHaveBeenCalled();
      expect(shelfTree()).toEqual(before); // no new paths/bytes; existing recovery data preserved
    } finally {
      writeSpy.mockRestore();
      await app.close();
    }
  });

  it("F4 (review #639/#640): an unsupported Content-Type is rejected 415 with a stable, internals-free message", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedAdminKey();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/backups/upload",
        // Neither Fastify's built-ins (json/text/urlencoded) nor this route's own
        // application/octet-stream parser recognizes this Content-Type — the genuine
        // FST_ERR_CTP_INVALID_MEDIA_TYPE path, distinct from text/plain (which Fastify parses by
        // default) or a malformed application/octet-stream body (parsed fine, rejected later by
        // the handler's own isValidSqliteFile check).
        headers: { "content-type": "application/x-not-a-registered-type" },
        payload: "not octet-stream",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(415);
      const body = JSON.parse(res.body);
      expect(Object.keys(body).sort()).toEqual(["error", "message"]);
      expect(body.error).toBe("unsupported_media_type");
      expect(body.message).toBe("Upload must be sent as application/octet-stream");
      expect(listBackups()).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("P2-3 (review fold): an unexpected internal failure never echoes the raw exception message — a stable, fixed upload_failed envelope", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedAdminKey();
    const DISTINCTIVE = "SUPER-SECRET-INTERNAL-DIAGNOSTIC-9f3c2a";
    // `fs.readdirSync(root)` is the first filesystem call inside the upload handler, running
    // BEFORE its own try/catch (which only wraps the writeFileSync/rename steps) — an exception
    // here reaches the scope's setErrorHandler generic fallback branch, exactly the path this
    // pins.
    const readdirSpy = vi.spyOn(fs, "readdirSync").mockImplementationOnce(() => {
      throw new Error(DISTINCTIVE);
    });
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/backups/upload",
        headers: { "content-type": "application/octet-stream" },
        payload: Buffer.from("irrelevant — never reached past the injected readdirSync throw"),
        cookies: { mp_device_key: deviceKey },
      });
      const body = JSON.parse(res.body);
      // A mutant that reverts the error handler's fallback branch to echo `error.message` would
      // leak DISTINCTIVE here — this is what pins the no-echo fix, not merely "some 500 happened".
      expect(body).toEqual({ error: "upload_failed", message: "Upload failed" });
      expect(res.body).not.toContain(DISTINCTIVE);
    } finally {
      readdirSpy.mockRestore();
      await app.close();
    }
  });

  it("stores a valid SQLite upload with an upload- prefix, collision-safe naming, and it appears on the shelf", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedAdminKey();
    const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mp-upload-src-")), "mine.db");
    writeGenuineSqliteFile(tmpFile);
    const bytes = fs.readFileSync(tmpFile);

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/backups/upload",
        headers: { "content-type": "application/octet-stream" },
        payload: bytes,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { filename: string };
      expect(body.filename).toMatch(/^upload-\d{8}-\d{6}-\d{3}(-\d+)?\.db$/);
      const listed = listBackups().find((b) => b.filename === body.filename);
      expect(listed?.type).toBe("upload");
      expect(fs.readFileSync(path.join(resolveBackupsRoot(), body.filename))).toEqual(bytes);
    } finally {
      await app.close();
    }
  });

  it("BACKUPS-AC-05: upload -> restore round-trip through the version gate (an uploaded, migration-compatible backup restores cleanly)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedAdminKey();

    // A genuine snapshot of THIS test's own (fully migrated) DB is, by construction, exactly as
    // compatible with the running code's migration set as any backup ever legitimately is — the
    // simplest honest way to produce an upload payload that clears the version gate without
    // hand-building a fixture DB (tests/integration/backups-restore.test.ts already owns that
    // fixture-construction machinery for the gate's OWN matrix; this test only proves the upload
    // route's OUTPUT is a normal, restorable shelf entry).
    const seedOutcome = await createSnapshot("snapshot");
    expect(seedOutcome.ok).toBe(true);
    if (!seedOutcome.ok) throw new Error("unreachable");
    const bytes = fs.readFileSync(path.join(resolveBackupsRoot(), seedOutcome.filename));

    const app = await buildApp();
    try {
      const uploadRes = await app.inject({
        method: "POST",
        url: "/api/backups/upload",
        headers: { "content-type": "application/octet-stream" },
        payload: bytes,
        cookies: { mp_device_key: deviceKey },
      });
      expect(uploadRes.statusCode).toBe(200);
      const uploadedFilename = (JSON.parse(uploadRes.body) as { filename: string }).filename;

      const restoreRes = await app.inject({
        method: "POST",
        url: "/api/backups/restore",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ filename: uploadedFilename, confirmFilename: uploadedFilename }),
        cookies: { mp_device_key: deviceKey },
      });
      expect(restoreRes.statusCode).toBe(200);
      expect(JSON.parse(restoreRes.body).status).toBe("restored");
    } finally {
      await app.close();
      __resetRestoreStateForTests();
    }
  });
});
