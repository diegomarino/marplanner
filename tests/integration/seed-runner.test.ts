import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/server/db/client";
import { runSeedProfile } from "../../src/server/db/seeds/runner";
import { useIsolatedDb } from "../helpers/db";

const AS_OF_DATE = "2026-09-23";
const NOW = 1_790_121_600_000;
const directories: string[] = [];

describe("seed runner integration", () => {
  useIsolatedDb();

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("runs public modules before private modules and redacts private failure values", async () => {
    const seedsDirectory = makeSeedsDirectory({
      "seed-020-public.mjs": orderedModule("public:second", "public-second"),
      "seed-010-public.mjs": orderedModule("public:first", "public-first"),
      "seed-000-PRIVATE.mjs": orderedModule("private:one", "private-one"),
    });

    const report = await runSeedProfile({
      mode: "private",
      asOfDate: AS_OF_DATE,
      nowMs: NOW,
      disposableTarget: true,
      seedsDirectory,
    });

    expect(report.moduleIds).toEqual(["public:first", "public:second", "private:01"]);
    expect(getDb().prepare("SELECT id FROM members ORDER BY rowid").all()).toEqual([
      { id: "demo:member:public-first" },
      { id: "demo:member:public-second" },
      { id: "demo:member:private-one" },
    ]);
    expect(getDb().prepare("SELECT status FROM seed_profile_state").get()).toEqual({
      status: "complete",
    });
  });

  it("rolls back the failed module, stops later modules, and leaves a repairable running marker", async () => {
    const privatePayload = "synthetic-private-payload";
    const seedsDirectory = makeSeedsDirectory({
      "seed-010-public.mjs": orderedModule("public:first", "public-first"),
      "seed-020-public.mjs": failingModule("public:failure", privatePayload),
      "seed-030-public.mjs": orderedModule("public:later", "public-later"),
    });

    let failure: unknown;
    try {
      await runSeedProfile({
        mode: "public",
        asOfDate: AS_OF_DATE,
        nowMs: NOW,
        disposableTarget: true,
        seedsDirectory,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : "";
    expect(message).toMatch(/public:failure/);
    expect(message).not.toContain(privatePayload);

    expect(getDb().prepare("SELECT id FROM members ORDER BY id").all()).toEqual([
      { id: "demo:member:public-first" },
    ]);
    expect(getDb().prepare("SELECT status FROM seed_profile_state").get()).toEqual({
      status: "running",
    });
  });

  it("repairs and completes a same-date rerun after a prior running marker", async () => {
    const seedsDirectory = makeSeedsDirectory({
      "seed-010-public.mjs": idempotentModule("public:first", "public-first"),
    });

    await runSeedProfile({
      mode: "public",
      asOfDate: AS_OF_DATE,
      nowMs: NOW,
      disposableTarget: true,
      seedsDirectory,
    });
    const report = await runSeedProfile({
      mode: "public",
      asOfDate: AS_OF_DATE,
      nowMs: NOW + 1,
      disposableTarget: true,
      seedsDirectory,
    });

    expect(report.markerAction).toBe("rerun");
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM members").get()).toEqual({ count: 1 });
    expect(getDb().prepare("SELECT status FROM seed_profile_state").get()).toEqual({
      status: "complete",
    });
  });

  it("awaits an asynchronous module so its post-await write rolls back before return", async () => {
    const seedsDirectory = makeSeedsDirectory({
      "seed-010-public.mjs": asynchronousFailingModule("public:async", "async"),
    });

    await expect(
      runSeedProfile({
        mode: "public",
        asOfDate: AS_OF_DATE,
        nowMs: NOW,
        disposableTarget: true,
        seedsDirectory,
      })
    ).rejects.toThrow("Seed module failed: public:async");

    await Promise.resolve();
    expect(getDb().prepare("SELECT id FROM members").all()).toEqual([]);
    expect(getDb().prepare("SELECT status FROM seed_profile_state").get()).toEqual({
      status: "running",
    });
  });

  it("redacts private module filenames, IDs, and payloads on failure", async () => {
    const privateId = "private:synthetic-private-id";
    const privatePayload = "synthetic-private-payload";
    const privateFileValue = "synthetic-private-filename";
    const seedsDirectory = makeSeedsDirectory({
      "seed-010-public.mjs": idempotentModule("public:first", "public-first"),
      [`seed-${privateFileValue}-PRIVATE.mjs`]: failingModule(privateId, privatePayload),
    });

    let failure: unknown;
    try {
      await runSeedProfile({
        mode: "private",
        asOfDate: AS_OF_DATE,
        nowMs: NOW,
        disposableTarget: true,
        seedsDirectory,
      });
    } catch (error) {
      failure = error;
    }

    const message = failure instanceof Error ? failure.message : "";
    expect(message).toBe("Seed module failed: private module");
    expect(message).not.toContain(privateId);
    expect(message).not.toContain(privatePayload);
    expect(message).not.toContain(privateFileValue);
  });

  it("redacts a private duplicate ID even when its filename sorts before the public module", async () => {
    const privateId = "private:synthetic-private-id";
    const privateFileValue = "synthetic-private-filename";
    const seedsDirectory = makeSeedsDirectory({
      "seed-010-public.mjs": idempotentModule(privateId, "public-first"),
      [`seed-000-${privateFileValue}-PRIVATE.mjs`]: idempotentModule(privateId, "private-first"),
    });

    const message = await errorMessage(() =>
      runSeedProfile({
        mode: "private",
        asOfDate: AS_OF_DATE,
        nowMs: NOW,
        disposableTarget: true,
        seedsDirectory,
      })
    );

    expect(message).toBe("Duplicate seed module ID: private module");
    expect(message).not.toContain(privateId);
    expect(message).not.toContain(privateFileValue);
    expect(message).not.toContain(seedsDirectory);
  });

  it("runs both npm CLI entrypoints against synthetic temporary modules", () => {
    const seedsDirectory = makeSeedsDirectory({
      "seed-010-public.mjs": idempotentModule("public:first", "public-first"),
      "seed-900-PRIVATE.mjs": idempotentModule("private:one", "private-one"),
    });
    const dataDirectory = makeDirectory();
    const environment = { ...process.env, DATA_DIR: dataDirectory, SEED_DIRECTORY: seedsDirectory };

    const publicResult = spawnSync("npm", ["run", "seed", "--", "--as-of", AS_OF_DATE], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: environment,
    });
    const privateResult = spawnSync("npm", ["run", "seed:private", "--", "--as-of", AS_OF_DATE], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: environment,
    });

    expect(publicResult.status).toBe(0);
    expect(publicResult.stdout).toContain("modules=[public:first]");
    expect(privateResult.status).toBe(0);
    expect(privateResult.stdout).toContain("modules=[public:first,private:01]");
    expect(`${privateResult.stdout}${privateResult.stderr}`).not.toContain("private-one");
  });

  it("returns a non-zero CLI status with a redacted failed-module diagnostic", () => {
    const privatePayload = "synthetic-private-payload";
    const seedsDirectory = makeSeedsDirectory({
      "seed-010-public.mjs": failingModule("public:failure", privatePayload),
    });
    const dataDirectory = makeDirectory();
    const result = spawnSync("npm", ["run", "seed", "--", "--as-of", AS_OF_DATE], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATA_DIR: dataDirectory, SEED_DIRECTORY: seedsDirectory },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Seed module failed: public:failure");
    expect(result.stderr).not.toContain(privatePayload);
  });

  it("rejects an appended mode override without executing a private module", () => {
    const privatePayload = "synthetic-private-payload";
    const seedsDirectory = makeSeedsDirectory({
      "seed-010-public.mjs": idempotentModule("public:first", "public-first"),
      "seed-000-PRIVATE.mjs": failingModule("private:one", privatePayload),
    });
    const dataDirectory = makeDirectory();
    const result = spawnSync("npm", ["run", "seed", "--", "--mode", "private"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATA_DIR: dataDirectory, SEED_DIRECTORY: seedsDirectory },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--mode may only be provided once");
    expect(`${result.stdout}${result.stderr}`).not.toContain(privatePayload);
  });
});

function makeSeedsDirectory(files: Record<string, string>): string {
  const directory = makeDirectory();
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(directory, name), source);
  }
  return directory;
}

function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "mp-seed-runner-"));
  directories.push(directory);
  return directory;
}

function orderedModule(id: string, suffix: string): string {
  return `export default {
  id: ${JSON.stringify(id)},
  run(context) {
    context.db.prepare("INSERT INTO members (id, display_name, role, created_at, updated_at) VALUES (?, 'Demo', 'parent', ?, ?)").run(${JSON.stringify(`demo:member:${suffix}`)}, context.nowMs, context.nowMs);
  }
};`;
}

function idempotentModule(id: string, suffix: string): string {
  return `export default {
  id: ${JSON.stringify(id)},
  run(context) {
    context.db.prepare("INSERT OR IGNORE INTO members (id, display_name, role, created_at, updated_at) VALUES (?, 'Demo', 'parent', ?, ?)").run(${JSON.stringify(`demo:member:${suffix}`)}, context.nowMs, context.nowMs);
  }
};`;
}

function failingModule(id: string, privatePayload: string): string {
  return `export default {
  id: ${JSON.stringify(id)},
  run(context) {
    context.db.prepare("INSERT INTO members (id, display_name, role, created_at, updated_at) VALUES ('demo:member:failed', 'Demo', 'parent', ?, ?)").run(context.nowMs, context.nowMs);
    throw new Error(${JSON.stringify(privatePayload)});
  }
};`;
}

function asynchronousFailingModule(id: string, suffix: string): string {
  return `export default {
  id: ${JSON.stringify(id)},
  async run(context) {
    await Promise.resolve();
    context.db.prepare("INSERT INTO members (id, display_name, role, created_at, updated_at) VALUES (?, 'Demo', 'parent', ?, ?)").run(${JSON.stringify(`demo:member:${suffix}`)}, context.nowMs, context.nowMs);
    throw new Error("synthetic async failure");
  }
};`;
}

async function errorMessage(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return error instanceof Error ? error.message : "";
  }
  throw new Error("Expected seed runner to fail");
}
