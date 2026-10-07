import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetDb } from "../../src/server/db/client";
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";

function createTempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "boot-"));
}

function cleanupTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("boot: factory + boot sequence", () => {
  const originalDataDir = process.env.DATA_DIR;
  afterAll(() => expect(process.env.DATA_DIR).toBe(originalDataDir));
  let dataDir: string;
  let savedDataDir: string | undefined;

  beforeEach(() => {
    savedDataDir = process.env.DATA_DIR;
    resetDb();
    dataDir = createTempDataDir();
    process.env.DATA_DIR = dataDir;
  });

  afterEach(() => {
    try {
      resetDb();
    } finally {
      if (savedDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = savedDataDir;
      cleanupTempDir(dataDir);
    }
  });

  it("assertDataDirWritable passes on a valid temp dir and throws on a non-writable path", async () => {
    const { assertDataDirWritable } = await import("../../src/server/index.ts");

    expect(() => assertDataDirWritable(dataDir)).not.toThrow();

    const readOnlyDir = path.join(dataDir, "readonly");
    fs.mkdirSync(readOnlyDir);
    fs.chmodSync(readOnlyDir, 0o444);

    try {
      expect(() => assertDataDirWritable(readOnlyDir)).toThrow();
    } finally {
      fs.chmodSync(readOnlyDir, 0o755);
    }
  });

  it("buildApp returns a Fastify instance, health returns 200, and /api/settings is fail-closed (401)", async () => {
    const { runMigrations } = await import("../../src/server/db/migrate.ts");
    const { buildApp } = await import("../../src/server/app.ts");

    runMigrations();

    const app = await buildApp();

    try {
      const healthRes = await app.inject({ method: "GET", url: "/health" });
      expect(healthRes.statusCode).toBe(200);
      expect(JSON.parse(healthRes.body)).toEqual({ status: "ok" });

      const settingsRes = await app.inject({ method: "GET", url: "/api/settings" });
      expect(settingsRes.statusCode).toBe(401);
      expect(JSON.parse(settingsRes.body)).toHaveProperty("error", "unauthorized");
    } finally {
      await app.close();
    }
  });
});
