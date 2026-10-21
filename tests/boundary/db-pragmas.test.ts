import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import fs from "node:fs";
import { acquireStorageOwnership, assertLocalStorage } from "../../src/server/db/runtime-storage";
import { openClient } from "../../src/server/db/client";

let db: ReturnType<typeof openClient>;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "db-pragmas-"));
  const dbFile = join(tmpDir, "test.db");
  db = openClient(dbFile);
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("db-pragmas", () => {
  it("journal_mode is WAL", () => {
    const result = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(result.journal_mode).toBe("wal");
  });

  it("foreign_keys is ON", () => {
    const result = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(result.foreign_keys).toBe(1);
  });

  it("STRICT tables reject BLOB values for typed columns", () => {
    // STRICT tables enforce column type only on NOT NULL columns with an explicit type.
    // See https://www.sqlite.org/stricttables.html
    db.exec(
      "CREATE TABLE t1 (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER NOT NULL) STRICT"
    );
    db.prepare("INSERT INTO t1 (name, age) VALUES (?, ?)").run("alice", 30);
    // Inserting a BLOB into a TEXT NOT NULL column MUST throw on a STRICT table
    expect(() =>
      db.prepare("INSERT INTO t1 (name, age) VALUES (?, ?)").run(Buffer.from([1, 2, 3]), 30)
    ).toThrow();
  });

  it("STRICT tables reject NULL on NOT NULL typed columns", () => {
    db.exec("CREATE TABLE t2 (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT");
    // NULL on a NOT NULL column must throw
    expect(() => db.prepare("INSERT INTO t2 (name) VALUES (?)").run(null)).toThrow();
  });
});

describe("runtime storage safeguards", () => {
  it("rejects recognized Linux network storage before any SQLite files are created", () => {
    vi.stubGlobal(
      "process",
      Object.defineProperty(Object.create(process), "platform", { value: "linux" })
    );
    const file = join(tmpDir, "network.db");
    try {
      for (const type of [0x6969n, 0x517bn, 0xff534d42n, 0xfe534d42n]) {
        vi.spyOn(fs, "statfsSync").mockReturnValue({ type } as fs.BigIntStatsFs);
        expect(() => acquireStorageOwnership(file)).toThrow(/network filesystem rejected/);
        expect(() => openClient(file)).toThrow(/network filesystem rejected/);
        expect(fs.existsSync(file)).toBe(false);
        expect(fs.existsSync(`${file}.instance-lock.sqlite`)).toBe(false);
        vi.restoreAllMocks();
      }
      vi.spyOn(fs, "statfsSync").mockReturnValue({ type: 0xef53n } as fs.BigIntStatsFs);
      expect(assertLocalStorage(file)).toBe(join(fs.realpathSync(tmpDir), "network.db"));
      vi.stubGlobal(
        "process",
        Object.defineProperty(Object.create(process), "platform", { value: "darwin" })
      );
      vi.spyOn(fs, "statfsSync").mockReturnValue({ type: 0x6969n } as fs.BigIntStatsFs);
      expect(() => assertLocalStorage(file)).not.toThrow();
      expect(() => assertLocalStorage(file)).not.toThrow();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it("checks the existing database mount and propagates filesystem errors", () => {
    const file = join(tmpDir, "test.db");
    const statfs = vi
      .spyOn(fs, "statfsSync")
      .mockReturnValue({ type: 0xef53n } as fs.BigIntStatsFs);
    try {
      expect(assertLocalStorage(file)).toBe(join(fs.realpathSync(tmpDir), "test.db"));
      expect(statfs).toHaveBeenCalledWith(join(fs.realpathSync(tmpDir), "test.db"), {
        bigint: true,
      });
      statfs.mockImplementation(() => {
        throw new Error("statfs I/O failure");
      });
      const missing = join(tmpDir, "io-error.db");
      expect(() => acquireStorageOwnership(missing)).toThrow(/statfs I\/O failure/);
      expect(fs.existsSync(`${missing}.instance-lock.sqlite`)).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
    expect(() => assertLocalStorage(join(tmpDir, "missing", "test.db"))).toThrow(/ENOENT/);
    expect(() => assertLocalStorage(tmpDir)).toThrow(/regular file/);
    const lstat = vi.spyOn(fs, "lstatSync").mockImplementation(() => {
      throw new Error("lstat I/O failure");
    });
    try {
      expect(() => assertLocalStorage(file)).toThrow(/lstat I\/O failure/);
    } finally {
      lstat.mockRestore();
    }
  });

  it("rejects file aliases and preserves malformed sentinels", () => {
    const file = join(tmpDir, "aliases.db");
    fs.symlinkSync(join(tmpDir, "missing.db"), file);
    expect(() => acquireStorageOwnership(file)).toThrow(/symbolic link/);
    fs.unlinkSync(file);
    fs.linkSync(join(tmpDir, "test.db"), file);
    expect(() => acquireStorageOwnership(file)).toThrow(/hard links/);
    fs.unlinkSync(file);
    const sentinel = `${file}.instance-lock.sqlite`;
    fs.symlinkSync(join(tmpDir, "test.db"), sentinel);
    expect(() => acquireStorageOwnership(file)).toThrow(/symbolic link/);
    fs.unlinkSync(sentinel);
    fs.writeFileSync(sentinel, "malformed sentinel");
    expect(() => acquireStorageOwnership(file)).toThrow(
      /Cannot acquire database storage ownership/
    );
    expect(fs.readFileSync(sentinel, "utf8")).toBe("malformed sentinel");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("holds ownership independently of product connections and releases idempotently", () => {
    const file = join(tmpDir, "ownership.db");
    const release = acquireStorageOwnership(file);
    try {
      expect(() => acquireStorageOwnership(file)).toThrow(/already owned/);
      const product = openClient(file);
      product.close();
      expect(() => acquireStorageOwnership(file)).toThrow(/already owned/);
    } finally {
      release();
      release();
    }
    const nextRelease = acquireStorageOwnership(file);
    nextRelease();
  });
});

/** Household state must not be readable by other local users even under a permissive umask:
 * stores the server creates are owner-only, and existing operator-managed paths keep their mode. */
describe("private storage creation", () => {
  let parent: string;
  let previousUmask: number;

  beforeAll(() => {
    previousUmask = process.umask(0o022);
    parent = mkdtempSync(join(tmpdir(), "private-storage-"));
  });

  afterAll(() => {
    process.umask(previousUmask);
    rmSync(parent, { recursive: true, force: true });
  });

  const mode = (target: string) => fs.statSync(target).mode & 0o777;

  it("creates a new database, its WAL and SHM owner-only", () => {
    const file = join(parent, "fresh.db");
    const fresh = openClient(file);
    try {
      fresh.exec("CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1);");
      expect(mode(file)).toBe(0o600);
      expect(mode(`${file}-wal`)).toBe(0o600);
      expect(mode(`${file}-shm`)).toBe(0o600);
    } finally {
      fresh.close();
    }
  });

  it("leaves the mode of an existing operator-managed database alone", () => {
    const file = join(parent, "managed.db");
    fs.writeFileSync(file, "");
    fs.chmodSync(file, 0o640);
    openClient(file).close();
    expect(mode(file)).toBe(0o640);
  });

  it("creates new data and backups directories owner-only but keeps existing ones", async () => {
    const { assertDataDirWritable } = await import("../../src/server/index.ts");
    const { resolveBackupsRoot } = await import("../../src/server/backups/storage.ts");
    const dataDir = join(parent, "data", "nested");
    assertDataDirWritable(dataDir);
    expect(mode(dataDir)).toBe(0o700);

    const previous = { DATA_DIR: process.env.DATA_DIR, BACKUPS_ROOT: process.env.BACKUPS_ROOT };
    try {
      delete process.env.BACKUPS_ROOT;
      process.env.DATA_DIR = dataDir;
      expect(mode(resolveBackupsRoot())).toBe(0o700);

      const managed = join(parent, "managed-backups");
      fs.mkdirSync(managed, { mode: 0o750 });
      fs.chmodSync(managed, 0o750);
      process.env.BACKUPS_ROOT = managed;
      resolveBackupsRoot();
      expect(mode(managed)).toBe(0o750);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
