import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/server/db/client";
import { runSeedProfile } from "../../src/server/db/seeds/runner";
import { useIsolatedDb } from "../helpers/db";

const AS_OF_DATE = "2026-09-23";
const NOW = 1_790_121_600_000;
const directories: string[] = [];

describe("seed runner boundary", () => {
  useIsolatedDb();

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("discovers public modules lexically and injects one validated date and clock", async () => {
    const seedsDirectory = makeSeedsDirectory({
      "seed-020-zeta.mjs": moduleSource("public:zeta", "zeta"),
      "seed-010-alpha.mjs": moduleSource("public:alpha", "alpha"),
    });

    const report = await runSeedProfile({
      mode: "public",
      asOfDate: AS_OF_DATE,
      nowMs: NOW,
      disposableTarget: true,
      seedsDirectory,
    });

    expect(report).toMatchObject({
      mode: "public",
      asOfDate: AS_OF_DATE,
      moduleIds: ["public:alpha", "public:zeta"],
      status: "complete",
    });
    expect(getDb().prepare("SELECT id, display_name FROM members ORDER BY id").all()).toEqual([
      { id: "demo:member:alpha", display_name: `${AS_OF_DATE}:${NOW}` },
      { id: "demo:member:zeta", display_name: `${AS_OF_DATE}:${NOW}` },
    ]);
  });

  it("refuses an undisposable target before changing an ordinary row", async () => {
    getDb()
      .prepare(
        "INSERT INTO members (id, display_name, role, created_at, updated_at) VALUES ('ordinary:member', 'Ordinary', 'parent', ?, ?)"
      )
      .run(NOW, NOW);

    await expect(
      runSeedProfile({
        mode: "public",
        asOfDate: AS_OF_DATE,
        nowMs: NOW,
        disposableTarget: false,
        seedsDirectory: makeSeedsDirectory({
          "seed-010-alpha.mjs": moduleSource("public:alpha", "alpha"),
        }),
      })
    ).rejects.toThrow(/disposable/i);
    expect(getDb().prepare("SELECT id FROM members").all()).toEqual([{ id: "ordinary:member" }]);
  });

  it("rejects invalid and duplicate module identities before creating a profile marker", async () => {
    const seedsDirectory = makeSeedsDirectory({
      "seed-010-alpha.mjs": moduleSource("public:duplicate", "alpha"),
      "seed-020-beta.mjs": moduleSource("public:duplicate", "beta"),
    });

    await expect(
      runSeedProfile({
        mode: "public",
        asOfDate: AS_OF_DATE,
        nowMs: NOW,
        disposableTarget: true,
        seedsDirectory,
      })
    ).rejects.toThrow(/duplicate/i);
    expect(getDb().prepare("SELECT * FROM seed_profile_state").all()).toEqual([]);
  });

  it("rejects a module without a stable ID before creating a profile marker", async () => {
    await expect(
      runSeedProfile({
        mode: "public",
        asOfDate: AS_OF_DATE,
        nowMs: NOW,
        disposableTarget: true,
        seedsDirectory: makeSeedsDirectory({
          "seed-010-alpha.mjs": moduleSource("unstable", "alpha"),
        }),
      })
    ).rejects.toThrow(/invalid seed module/i);
    expect(getDb().prepare("SELECT * FROM seed_profile_state").all()).toEqual([]);
  });

  it("redacts malformed private filenames from diagnostics", async () => {
    const privateValue = "synthetic-private-filename";
    const message = await errorMessage(() =>
      runSeedProfile({
        mode: "private",
        asOfDate: AS_OF_DATE,
        nowMs: NOW,
        disposableTarget: true,
        seedsDirectory: makeSeedsDirectory({
          [`seed-${privateValue}-PRIVATE.txt`]: "export default {};",
        }),
      })
    );

    expect(message).toMatch(/invalid private seed module filename/i);
    expect(message).not.toContain(privateValue);
  });

  it("runs migrations before creating the profile marker or invoking a module", async () => {
    const migrationsDirectory = makeMigrationsDirectory({
      "9999-seed-runner-probe.sql":
        "CREATE TABLE seed_runner_migration_probe (id INTEGER PRIMARY KEY);",
    });
    const report = await runSeedProfile({
      mode: "public",
      asOfDate: AS_OF_DATE,
      nowMs: NOW,
      disposableTarget: true,
      migrationsDirectory,
      seedsDirectory: makeSeedsDirectory({
        "seed-010-alpha.mjs": migrationAwareModule(),
      }),
    });

    expect(report.status).toBe("complete");
    expect(getDb().prepare("SELECT status FROM seed_profile_state").get()).toEqual({
      status: "complete",
    });
  });
});

function makeSeedsDirectory(files: Record<string, string>): string {
  const directory = makeDirectory();
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(directory, name), source);
  }
  return directory;
}

function makeMigrationsDirectory(files: Record<string, string>): string {
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

function moduleSource(id: string, rowId: string): string {
  return `export default {
  id: ${JSON.stringify(id)},
  run(context) {
    context.db.prepare("INSERT INTO members (id, display_name, role, created_at, updated_at) VALUES (?, ?, 'parent', ?, ?)").run(${JSON.stringify(`demo:member:${rowId}`)}, context.asOfDate + ':' + context.nowMs, context.nowMs, context.nowMs);
  }
};`;
}

function migrationAwareModule(): string {
  return `export default {
  id: "public:migration-aware",
  run(context) {
    const migration = context.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'seed_runner_migration_probe'").get();
    if (!migration) throw new Error("missing migration");
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
