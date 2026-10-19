import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { reconcileBootstrap } from "../../src/server/auth/reconcile";
import { getDb } from "../../src/server/db/client";
import {
  beginSeedProfile,
  completeSeedProfile,
  readSeedProfileMarker,
  SeedOwnershipError,
  type SeedProfileMarkerState,
} from "../../src/server/db/seeds/ownership";
import { bundledPublicSeedModules } from "../../src/server/db/seeds/public-modules";
import { runSeedProfile, SeedRunnerError } from "../../src/server/db/seeds/runner";
import {
  seedOnEmpty,
  seedOnEmptyEnabled,
  type SeedOnEmptyDependencies,
} from "../../src/server/db/seeds/seed-on-empty";
import type { SeedModule, SeedRunReport } from "../../src/server/db/seeds/types";
import { useIsolatedDb } from "../helpers/db";

const AS_OF_DATE = "2026-09-23";
const NOW = 1_790_121_600_000;

function memberModule(id: string, slug: string): SeedModule {
  return {
    id,
    run: ({ db, nowMs }) => {
      db.prepare(
        "INSERT OR IGNORE INTO members (id, display_name, role, created_at, updated_at) VALUES (?, ?, 'parent', ?, ?)"
      ).run(`demo:member:${slug}`, slug, nowMs, nowMs);
    },
  };
}

function failingModule(id: string): SeedModule {
  return {
    id,
    run: () => {
      throw new Error("synthetic seed failure");
    },
  };
}

const REPORT: SeedRunReport = {
  mode: "public",
  asOfDate: AS_OF_DATE,
  moduleIds: ["public:one"],
  markerAction: "created",
  status: "complete",
};

function fakeDependencies(overrides: Partial<SeedOnEmptyDependencies> = {}) {
  const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const runSeed = vi.fn(() => Promise.resolve(REPORT));
  return {
    log,
    runSeed,
    deps: {
      env: { MP_SEED_ON_EMPTY: "true" },
      readMarker: (): SeedProfileMarkerState => ({ state: "absent" }),
      runSeed,
      modules: () => undefined,
      log,
      ...overrides,
    } satisfies SeedOnEmptyDependencies,
  };
}

describe("MP_SEED_ON_EMPTY flag", () => {
  it("is on only for true or 1", () => {
    expect(seedOnEmptyEnabled({ MP_SEED_ON_EMPTY: "true" })).toBe(true);
    expect(seedOnEmptyEnabled({ MP_SEED_ON_EMPTY: " TRUE " })).toBe(true);
    expect(seedOnEmptyEnabled({ MP_SEED_ON_EMPTY: "1" })).toBe(true);
    expect(seedOnEmptyEnabled({})).toBe(false);
    expect(seedOnEmptyEnabled({ MP_SEED_ON_EMPTY: "false" })).toBe(false);
    expect(seedOnEmptyEnabled({ MP_SEED_ON_EMPTY: "private" })).toBe(false);
  });
});

describe("seed on empty policy", () => {
  it("does nothing, not even reading the marker, when the flag is off", async () => {
    const readMarker = vi.fn((): SeedProfileMarkerState => ({ state: "absent" }));
    const { deps, runSeed } = fakeDependencies({ env: {}, readMarker });
    await expect(seedOnEmpty(deps)).resolves.toBe("disabled");
    expect(readMarker).not.toHaveBeenCalled();
    expect(runSeed).not.toHaveBeenCalled();
  });

  it("seeds the public profile in-process when no marker exists", async () => {
    const modules = [memberModule("public:one", "one")];
    const { deps, runSeed } = fakeDependencies({ modules: () => modules });
    await expect(seedOnEmpty(deps)).resolves.toBe("seeded");
    expect(runSeed).toHaveBeenCalledWith({
      mode: "public",
      disposableTarget: true,
      serverBoot: true,
      modules,
    });
  });

  it("reruns to repair a marker left running by a crashed boot", async () => {
    const { deps, runSeed } = fakeDependencies({
      readMarker: () => ({ state: "running", asOfDate: "2026-09-20" }),
    });
    await expect(seedOnEmpty(deps)).resolves.toBe("repaired");
    // The crashed boot's as-of date, not today's: the runner refuses a running marker otherwise.
    expect(runSeed).toHaveBeenCalledWith(expect.objectContaining({ asOfDate: "2026-09-20" }));
  });

  it("skips a completed profile", async () => {
    const { deps, runSeed } = fakeDependencies({
      readMarker: () => ({ state: "complete", asOfDate: AS_OF_DATE }),
    });
    await expect(seedOnEmpty(deps)).resolves.toBe("skipped");
    expect(runSeed).not.toHaveBeenCalled();
  });

  it("leaves a foreign marker alone with a warning", async () => {
    const { deps, runSeed, log } = fakeDependencies({
      readMarker: () => ({ state: "unrecognized" }),
    });
    await expect(seedOnEmpty(deps)).resolves.toBe("refused");
    expect(runSeed).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("downgrades an ownership refusal to a warning", async () => {
    const { deps, log } = fakeDependencies({
      runSeed: () => Promise.reject(new SeedOwnershipError("unrelated row in members")),
    });
    await expect(seedOnEmpty(deps)).resolves.toBe("refused");
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("unrelated row in members"));
    expect(log.error).not.toHaveBeenCalled();
  });

  it("logs any other failure as an error without throwing", async () => {
    const { deps, log } = fakeDependencies({
      runSeed: () => Promise.reject(new SeedRunnerError("Seed module failed: public:one")),
    });
    await expect(seedOnEmpty(deps)).resolves.toBe("failed");
    expect(log.error).toHaveBeenCalledTimes(1);

    const unreadable = fakeDependencies({
      readMarker: () => {
        throw new Error("disk I/O error");
      },
    });
    await expect(seedOnEmpty(unreadable.deps)).resolves.toBe("failed");
    expect(unreadable.runSeed).not.toHaveBeenCalled();
  });
});

describe("seed on empty against a real database", () => {
  useIsolatedDb();

  it("reads the marker through absent, running and complete", () => {
    const db = getDb();
    expect(readSeedProfileMarker(db)).toEqual({ state: "absent" });
    beginSeedProfile(db, { asOfDate: AS_OF_DATE, nowMs: NOW });
    expect(readSeedProfileMarker(db)).toEqual({ state: "running", asOfDate: AS_OF_DATE });
    completeSeedProfile(db, { asOfDate: AS_OF_DATE, nowMs: NOW });
    expect(readSeedProfileMarker(db)).toEqual({ state: "complete", asOfDate: AS_OF_DATE });
    db.prepare("UPDATE seed_profile_state SET profile = 'other-profile'").run();
    expect(readSeedProfileMarker(db)).toEqual({ state: "unrecognized" });
  });

  it("reads a missing marker table as absent and an unknown status as unrecognized", () => {
    const bare = new Database(":memory:");
    try {
      expect(readSeedProfileMarker(bare)).toEqual({ state: "absent" });
      bare.exec(
        "CREATE TABLE seed_profile_state (profile TEXT, version INTEGER, as_of_date TEXT, status TEXT, started_at INTEGER, completed_at INTEGER)"
      );
      bare
        .prepare("INSERT INTO seed_profile_state VALUES ('simpsons-demo', 1, ?, 'paused', ?, NULL)")
        .run(AS_OF_DATE, NOW);
      expect(readSeedProfileMarker(bare)).toEqual({ state: "unrecognized" });
    } finally {
      bare.close();
    }
  });

  it("seeds, then skips on the next boot", async () => {
    const modules = [memberModule("public:one", "one"), memberModule("public:two", "two")];
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const env = { MP_SEED_ON_EMPTY: "true" };

    await expect(seedOnEmpty({ env, modules: () => modules, log })).resolves.toBe("seeded");
    expect(getDb().prepare("SELECT id FROM members ORDER BY id").all()).toEqual([
      { id: "demo:member:one" },
      { id: "demo:member:two" },
    ]);
    await expect(seedOnEmpty({ env, modules: () => modules, log })).resolves.toBe("skipped");
  });

  it("repairs a seed a crashed boot left running, on that boot's as-of date", async () => {
    // A crash leaves the first module committed and the marker running, dated the day it began.
    const yesterday = "2026-09-22";
    await expect(
      runSeedProfile({
        mode: "public",
        asOfDate: yesterday,
        nowMs: NOW,
        disposableTarget: true,
        modules: [memberModule("public:one", "one"), failingModule("public:two")],
      })
    ).rejects.toThrow("Seed module failed: public:two");
    expect(readSeedProfileMarker(getDb())).toEqual({ state: "running", asOfDate: yesterday });

    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const outcome = await seedOnEmpty({
      env: { MP_SEED_ON_EMPTY: "true" },
      modules: () => [memberModule("public:one", "one"), memberModule("public:two", "two")],
      log,
    });

    expect(outcome).toBe("repaired");
    expect(log.warn).not.toHaveBeenCalled();
    expect(getDb().prepare("SELECT id FROM members ORDER BY id").all()).toEqual([
      { id: "demo:member:one" },
      { id: "demo:member:two" },
    ]);
    expect(readSeedProfileMarker(getDb())).toEqual({ state: "complete", asOfDate: yesterday });
  });

  it("discards a failed seed so the boot after the server reconciled its keys seeds again", async () => {
    const env = { MP_SEED_ON_EMPTY: "true" };
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const failed = await seedOnEmpty({
      env,
      modules: () => [memberModule("public:one", "one"), failingModule("public:two")],
      log,
    });
    expect(failed).toBe("failed");
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("demo seed failed"),
      expect.objectContaining({ message: expect.stringContaining("partial profile was discarded") })
    );
    // Nothing half-seeded is left under the running server.
    expect(getDb().prepare("SELECT id FROM members").all()).toEqual([]);
    expect(readSeedProfileMarker(getDb())).toEqual({ state: "absent" });

    // The server carries on: main() reconciles the bootstrap key, and a device is provisioned.
    const previousKey = process.env.MP_BOOTSTRAP_KEY;
    process.env.MP_BOOTSTRAP_KEY = "mpk-local-bootstrap-change-me";
    try {
      reconcileBootstrap();
    } finally {
      if (previousKey === undefined) delete process.env.MP_BOOTSTRAP_KEY;
      else process.env.MP_BOOTSTRAP_KEY = previousKey;
    }
    getDb()
      .prepare("INSERT INTO admin_config (id, pin_hash, updated_at) VALUES (1, 'hash', 1)")
      .run();

    const next = await seedOnEmpty({
      env,
      modules: () => [memberModule("public:one", "one"), memberModule("public:two", "two")],
      log,
    });
    expect(next).toBe("seeded");
    expect(getDb().prepare("SELECT id FROM members ORDER BY id").all()).toEqual([
      { id: "demo:member:one" },
      { id: "demo:member:two" },
    ]);
    // The server's own rows survive both the discard and the seed.
    expect(getDb().prepare("SELECT kind FROM api_keys").all()).toEqual([{ kind: "bootstrap" }]);
    expect(getDb().prepare("SELECT id FROM admin_config").all()).toEqual([{ id: 1 }]);
  });

  it("tolerates only the server's own tables, never household rows, and only for boot seeds", async () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES ('k', 'h', '*', 'bootstrap', 1)"
    ).run();
    const base = {
      mode: "public",
      asOfDate: AS_OF_DATE,
      nowMs: NOW,
      disposableTarget: true,
    } as const;
    // The seed CLI keeps its strict fresh-baseline rule.
    await expect(
      runSeedProfile({ ...base, modules: [memberModule("public:one", "one")] })
    ).rejects.toThrow("unrelated row in api_keys");
    await expect(
      runSeedProfile({
        ...base,
        mode: "private",
        serverBoot: true,
        seedsDirectory: "/nonexistent/seeds",
      })
    ).rejects.toThrow("only supports public mode");
    expect(readSeedProfileMarker(db)).toEqual({ state: "absent" });

    await expect(
      runSeedProfile({ ...base, serverBoot: true, modules: [memberModule("public:one", "one")] })
    ).resolves.toMatchObject({ status: "complete" });
  });

  it("refuses, without changing anything, when the household already has data", async () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO members (id, display_name, role, created_at, updated_at) VALUES ('member-real', 'Real', 'parent', 1, 1)"
    ).run();
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const outcome = await seedOnEmpty({
      env: { MP_SEED_ON_EMPTY: "true" },
      modules: () => [memberModule("public:one", "one")],
      log,
    });

    expect(outcome).toBe("refused");
    expect(db.prepare("SELECT id FROM members").all()).toEqual([{ id: "member-real" }]);
    expect(readSeedProfileMarker(db)).toEqual({ state: "absent" });
  });
});

describe("runner with preloaded modules", () => {
  useIsolatedDb();

  it("runs them in order instead of discovering a directory", async () => {
    const report = await runSeedProfile({
      mode: "public",
      asOfDate: AS_OF_DATE,
      nowMs: NOW,
      disposableTarget: true,
      seedsDirectory: "/nonexistent/seeds",
      modules: [memberModule("public:b", "b"), memberModule("public:a", "a")],
    });
    expect(report.moduleIds).toEqual(["public:b", "public:a"]);
  });

  it("still validates ids, duplicates and the public-only mode", async () => {
    const base = { asOfDate: AS_OF_DATE, nowMs: NOW, disposableTarget: true } as const;
    await expect(
      runSeedProfile({
        ...base,
        mode: "public",
        modules: [memberModule("public:a", "a"), memberModule("public:a", "b")],
      })
    ).rejects.toThrow("Duplicate seed module ID: public:a");
    await expect(
      runSeedProfile({ ...base, mode: "public", modules: [memberModule("Not An Id", "a")] })
    ).rejects.toThrow("Invalid seed module");
    await expect(
      runSeedProfile({ ...base, mode: "private", modules: [memberModule("public:a", "a")] })
    ).rejects.toThrow("only supported in public mode");
    expect(readSeedProfileMarker(getDb())).toEqual({ state: "absent" });
  });

  it("has no bundled modules outside the production build", () => {
    expect(bundledPublicSeedModules()).toBeUndefined();
  });
});
