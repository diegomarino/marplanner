import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

function createTempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "boot-"));
}

function cleanupTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("boot: factory + boot sequence (T013)", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = createTempDataDir();
  });

  afterEach(() => {
    try {
      cleanupTempDir(dataDir);
    } catch {
      // best-effort cleanup
    }
  });

  it("assertDataDirWritable passes on a valid temp dir and throws on a non-writable path", async () => {
    const { assertDataDirWritable } = await import("../../src/server/index.ts");

    // Should not throw on a fresh temp dir
    expect(() => assertDataDirWritable(dataDir)).not.toThrow();

    // Should throw on a non-writable path — use /dev/null on macOS (a file, not a directory)
    // or a path that doesn't exist and can't be created. We test with a path that
    // fs.mkdirSync can create but fs.accessSync W_OK will reject.
    // On macOS, root-owned directories are unwritable by normal users.
    // Use a file path (not directory) — mkdirSync will succeed but accessSync W_OK
    // will fail because a regular file isn't W_OK in some contexts.
    // Better: use a path inside a read-only directory.
    const readOnlyDir = path.join(dataDir, "readonly");
    fs.mkdirSync(readOnlyDir);
    fs.chmodSync(readOnlyDir, 0o444);

    expect(() => assertDataDirWritable(readOnlyDir)).toThrow();

    // Restore permissions so cleanup works
    fs.chmodSync(readOnlyDir, 0o755);
  });

  it("buildApp returns a Fastify instance, health returns 200, and /api/settings is fail-closed (401)", async () => {
    const savedDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;

    const { runMigrations } = await import("../../src/server/db/migrate.ts");
    const { buildApp } = await import("../../src/server/app.ts");

    // Run migrations on the fresh store
    runMigrations();

    // Build the app — authBoundary registers the onRequest hook
    const app = await buildApp();

    // Health is exempt from auth (FR-002)
    const healthRes = await app.inject({ method: "GET", url: "/health" });
    expect(healthRes.statusCode).toBe(200);
    expect(JSON.parse(healthRes.body)).toEqual({ status: "ok" });

    // /api/settings requires auth — no cookie → 401 (fail-closed, rejected at onRequest)
    const settingsRes = await app.inject({ method: "GET", url: "/api/settings" });
    expect(settingsRes.statusCode).toBe(401);
    const settingsBody = JSON.parse(settingsRes.body);
    expect(settingsBody).toHaveProperty("error", "unauthorized");

    await app.close();

    process.env.DATA_DIR = savedDataDir;
  });
});
