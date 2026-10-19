/** MP_SEED_ON_EMPTY end to end: the real entrypoint (via tsx, so the runner discovers the real
 * `seeds/`) boots against a temp DATA_DIR, and the real server build graph bundles the public
 * seeds without any private overlay. This is what the one-click deploy templates rely on.
 */
import { spawn } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { build, type Metafile, type Plugin } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { getDb, resetDb } from "../../src/server/db/client";
import { runMigrations } from "../../src/server/db/migrate";
import { runSeedProfile } from "../../src/server/db/seeds/runner";

const repoRoot = resolve(import.meta.dirname, "../..");
const SERVER_ENTRY = join(repoRoot, "src/server/index.ts");
const BOOT_TIMEOUT_MS = 30_000;
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "localhost", () => {
      const address = server.address();
      server.close(() =>
        address && typeof address === "object"
          ? resolvePort(address.port)
          : reject(new Error("no free port"))
      );
    });
  });
}

/** Boots the entrypoint until /health answers, stops it with SIGTERM and returns its output. */
async function bootOnce(dataDir: string, env: Record<string, string>): Promise<string> {
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", SERVER_ENTRY], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "localhost",
      DATA_DIR: dataDir,
      DATABASE_PATH: "marplanner.db",
      SCHEDULER_DISABLED: "1",
      MP_BOOTSTRAP_KEY: "mpk-local-bootstrap-change-me",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += String(chunk)));
  child.stderr.on("data", (chunk: Buffer) => (output += String(chunk)));
  const exited = new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));

  try {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`entrypoint exited early:\n${output}`);
      if (Date.now() > deadline) throw new Error(`entrypoint never became healthy:\n${output}`);
      const healthy = await fetch(`http://localhost:${port}/health`).then(
        (response) => response.ok,
        () => false
      );
      if (healthy) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  } finally {
    child.kill("SIGTERM");
  }
  expect(await exited).toBe(0);
  return output;
}

function query<T>(dataDir: string, sql: string): T[] {
  const db = new Database(join(dataDir, "marplanner.db"), { readonly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

describe("MP_SEED_ON_EMPTY boot", () => {
  it("seeds the Simpsons into an empty DATA_DIR, then skips on the next boot", async () => {
    const dataDir = tempDir("mp-seed-boot-");

    const first = await bootOnce(dataDir, { MP_SEED_ON_EMPTY: "true" });
    expect(first).toMatch(/Seed on empty: demo profile seeded as of \d{4}-\d{2}-\d{2}/);
    const members = query<{ id: string }>(dataDir, "SELECT id FROM members ORDER BY id");
    expect(members.map(({ id }) => id)).toEqual(
      expect.arrayContaining(["demo:member:homer", "demo:member:marge", "demo:member:bart"])
    );
    expect(query(dataDir, "SELECT status FROM seed_profile_state")).toEqual([
      { status: "complete" },
    ]);
    // The bootstrap key was reconciled after the seed, so the next boot sees an owned database.
    expect(query(dataDir, "SELECT kind FROM api_keys")).toEqual([{ kind: "bootstrap" }]);

    const second = await bootOnce(dataDir, { MP_SEED_ON_EMPTY: "true" });
    expect(second).toContain("Seed on empty: demo profile already seeded, skipping");
    expect(query(dataDir, "SELECT id FROM members ORDER BY id")).toEqual(members);
  }, 90_000);

  it("repairs, with the real seeds, a profile a boot crashed in the day before", async () => {
    const dataDir = tempDir("mp-seed-crashed-");
    const yesterday = "2026-10-18";
    const previousDataDir = process.env.DATA_DIR;
    try {
      process.env.DATA_DIR = dataDir;
      resetDb();
      // The first real modules commit, then the run stops: the state a crash mid-seed leaves.
      const [settings, members] = await Promise.all([
        import("../../seeds/seed-010-settings"),
        import("../../seeds/seed-020-members"),
      ]);
      const crash = {
        id: "public:crash",
        run: () => {
          throw new Error("synthetic crash");
        },
      };
      await expect(
        runSeedProfile({
          mode: "public",
          asOfDate: yesterday,
          disposableTarget: true,
          modules: [settings.default, members.default, crash],
        })
      ).rejects.toThrow("public:crash");
    } finally {
      resetDb();
      if (previousDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = previousDataDir;
    }
    expect(query(dataDir, "SELECT as_of_date, status FROM seed_profile_state")).toEqual([
      { as_of_date: yesterday, status: "running" },
    ]);
    expect(query(dataDir, "SELECT id FROM meal_plans")).toEqual([]);

    const output = await bootOnce(dataDir, { MP_SEED_ON_EMPTY: "true" });
    expect(output).toContain(`Seed on empty: demo profile repaired as of ${yesterday}`);
    expect(query(dataDir, "SELECT as_of_date, status FROM seed_profile_state")).toEqual([
      { as_of_date: yesterday, status: "complete" },
    ]);
    expect(
      query<{ n: number }>(dataDir, "SELECT COUNT(*) AS n FROM meal_plans")[0]?.n
    ).toBeGreaterThan(0);

    const next = await bootOnce(dataDir, { MP_SEED_ON_EMPTY: "true" });
    expect(next).toContain("already seeded, skipping");
  }, 90_000);

  it("leaves a database with household data untouched and still boots", async () => {
    const dataDir = tempDir("mp-seed-owned-");
    const previousDataDir = process.env.DATA_DIR;
    try {
      process.env.DATA_DIR = dataDir;
      resetDb();
      runMigrations();
      getDb()
        .prepare(
          "INSERT INTO members (id, display_name, role, created_at, updated_at) VALUES ('member-real', 'Real', 'parent', 1, 1)"
        )
        .run();
    } finally {
      resetDb();
      if (previousDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = previousDataDir;
    }

    const output = await bootOnce(dataDir, { MP_SEED_ON_EMPTY: "true" });
    expect(output).toContain("leaving it untouched");
    expect(query(dataDir, "SELECT id FROM members")).toEqual([{ id: "member-real" }]);
    expect(query(dataDir, "SELECT * FROM seed_profile_state")).toEqual([]);
  }, 60_000);

  it("does not seed without the flag", async () => {
    const dataDir = tempDir("mp-seed-off-");
    const output = await bootOnce(dataDir, {});
    expect(output).not.toContain("Seed on empty");
    expect(query(dataDir, "SELECT id FROM members")).toEqual([]);
  }, 60_000);
});

describe("production server bundle", () => {
  it("compiles every public seed in and never a private overlay", async () => {
    const { seedBundlePlugin, assertNoPrivateInputs, publicSeedFiles } = (await import(
      join(repoRoot, "scripts/seed-bundle-plugin.mjs")
    )) as {
      seedBundlePlugin: (options: { seedsDirectory: string }) => Plugin;
      assertNoPrivateInputs: (metafile: Metafile) => void;
      publicSeedFiles: (seedsDirectory: string) => string[];
    };

    // A copy of the real public seeds next to a private overlay; `src` is linked so the seeds'
    // own `../src/...` imports resolve exactly as they do from the repository.
    const workspace = tempDir("mp-seed-graph-");
    const seeds = join(workspace, "seeds");
    mkdirSync(seeds);
    symlinkSync(join(repoRoot, "src"), join(workspace, "src"), "dir");
    const publicFiles = publicSeedFiles(join(repoRoot, "seeds"));
    for (const name of publicFiles) copyFileSync(join(repoRoot, "seeds", name), join(seeds, name));
    writeFileSync(
      join(seeds, "seed-910-calendar-PRIVATE.ts"),
      'export default { id: "private:calendar", run() { return "SENTINEL_PRIVATE_SEED"; } };\n'
    );
    expect(readdirSync(seeds)).toHaveLength(publicFiles.length + 1);

    const result = await build({
      entryPoints: [SERVER_ENTRY],
      absWorkingDir: repoRoot,
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      target: "node24",
      external: ["argon2", "better-sqlite3", "@resvg/resvg-js", "@resvg/resvg-wasm"],
      define: { __MP_BUILD__: JSON.stringify({ sha: null, subject: null, builtAt: null }) },
      metafile: true,
      logLevel: "silent",
      plugins: [seedBundlePlugin({ seedsDirectory: seeds })],
    });

    const text = result.outputFiles[0]?.text ?? "";
    expect(text).not.toContain("SENTINEL_PRIVATE_SEED");
    expect(() => assertNoPrivateInputs(result.metafile)).not.toThrow();
    const bundledSeeds = Object.keys(result.metafile.inputs)
      .filter((input) => input.startsWith("../") && input.includes("/seeds/"))
      .map((input) => input.split("/").at(-1) ?? "");
    expect(bundledSeeds.sort()).toEqual(publicFiles);
  }, 60_000);
});
