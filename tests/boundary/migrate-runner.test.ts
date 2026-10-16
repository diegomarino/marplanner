import fs from "node:fs";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getDb, resetDb } from "../../src/server/db/client";
import { runMigrations } from "../../src/server/db/migrate";
import { useIsolatedDb } from "../helpers/db";
import { ALL_SCHEMA_TABLES } from "../helpers/schema-tables";

// SQLite table-rebuild pattern (the 12-step ALTER TABLE workaround): create the new shape,
// copy rows across, drop the old table, rename the new one in. `DROP TABLE parent` while
// `foreign_keys=ON` cascade-deletes any child row referencing it — this migration does
// NOT temp-back-up `child` itself, so it only survives if the *runner* disables FK enforcement
// before the migration transaction opens.
const REBUILD_PARENT_SQL = `CREATE TABLE parent_new (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  extra TEXT
);
--> statement-breakpoint
INSERT INTO parent_new (id, name) SELECT id, name FROM parent;
--> statement-breakpoint
DROP TABLE parent;
--> statement-breakpoint
ALTER TABLE parent_new RENAME TO parent;`;

const BASELINE_SQL = `CREATE TABLE parent (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE child (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE,
  label TEXT NOT NULL
);`;

describe("migrate runner: FK-safe table rebuild (#438)", () => {
  let dataDir: string;
  let migrationsDir: string;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-runner-data-"));
    migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-runner-sql-"));
    prevDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
    resetDb();
  });

  afterEach(() => {
    resetDb();
    process.env.DATA_DIR = prevDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(migrationsDir, { recursive: true, force: true });
  });

  it("preserves child rows across a parent-table rebuild (DROP TABLE with ON DELETE CASCADE children)", () => {
    fs.writeFileSync(path.join(migrationsDir, "0000_fixture_baseline.sql"), BASELINE_SQL, "utf-8");
    runMigrations(migrationsDir);

    const db = getDb();
    db.prepare("INSERT INTO parent (id, name) VALUES (1, 'p1')").run();
    db.prepare("INSERT INTO child (id, parent_id, label) VALUES (1, 1, 'c1')").run();
    db.prepare("INSERT INTO child (id, parent_id, label) VALUES (2, 1, 'c2')").run();

    fs.writeFileSync(
      path.join(migrationsDir, "0001_rebuild_parent.sql"),
      REBUILD_PARENT_SQL,
      "utf-8"
    );
    runMigrations(migrationsDir);

    const children = db.prepare("SELECT id, parent_id, label FROM child ORDER BY id").all();
    expect(children).toEqual([
      { id: 1, parent_id: 1, label: "c1" },
      { id: 2, parent_id: 1, label: "c2" },
    ]);

    const parentRows = db.prepare("SELECT id, name, extra FROM parent").all();
    expect(parentRows).toEqual([{ id: 1, name: "p1", extra: null }]);

    // FK enforcement is restored after the batch, and integrity is clean post-rebuild.
    expect((db.pragma("foreign_keys") as { foreign_keys: number }[])[0].foreign_keys).toBe(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("rolls back the whole batch (data + bookkeeping) when a migration leaves a dangling foreign key reference", () => {
    fs.writeFileSync(path.join(migrationsDir, "0000_fixture_baseline.sql"), BASELINE_SQL, "utf-8");
    runMigrations(migrationsDir);

    // With FK enforcement off for the batch, this insert against a non-existent parent
    // succeeds during the migration — foreign_key_check (run INSIDE the txn) must catch it
    // and throw there, so the INSERT and the migration-table bookkeeping both roll back.
    fs.writeFileSync(
      path.join(migrationsDir, "0001_orphan_insert.sql"),
      "INSERT INTO child (id, parent_id, label) VALUES (99, 999, 'orphan');",
      "utf-8"
    );

    expect(() => runMigrations(migrationsDir)).toThrow(/foreign key violation/);

    const db = getDb();

    // The orphan insert must NOT have survived — rolled back with the rest of the batch.
    const orphan = db.prepare("SELECT id FROM child WHERE id = 99").all();
    expect(orphan).toEqual([]);
    expect(db.pragma("foreign_key_check")).toEqual([]);

    // The migration must NOT be recorded as applied — a re-run must see it as pending again,
    // never as permanently-applied-but-broken.
    const applied = db
      .prepare("SELECT fileName FROM `drizzle_universe_migrations` WHERE fileName = ?")
      .all("0001_orphan_insert.sql");
    expect(applied).toEqual([]);

    // FK enforcement is still restored even though the batch was rolled back.
    expect((db.pragma("foreign_keys") as { foreign_keys: number }[])[0].foreign_keys).toBe(1);
  });
});

/** The scheduler owns no schema tables. Verify the real installed migration chain against
 * the shared maintained table inventory (BACKGROUND-JOBS-SCHEDULER-INV-03). */
describe("schema table set (BACKGROUND-JOBS-SCHEDULER-INV-03)", () => {
  useIsolatedDb();

  it("BACKGROUND-JOBS-SCHEDULER-INV-03: installed table set matches ALL_SCHEMA_TABLES", () => {
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    expect(tables.map((t) => t.name)).toEqual(ALL_SCHEMA_TABLES);
  });
});

describe("pre-migration recovery points", () => {
  let dataDir: string;
  let migrationsDir: string;
  let previousDataDir: string | undefined;
  let previousBackupsRoot: string | undefined;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mp-migration-backup-"));
    migrationsDir = path.join(dataDir, "sql");
    fs.mkdirSync(migrationsDir);
    previousDataDir = process.env.DATA_DIR;
    previousBackupsRoot = process.env.BACKUPS_ROOT;
    process.env.DATA_DIR = dataDir;
    delete process.env.BACKUPS_ROOT;
    resetDb();
  });
  afterEach(() => {
    resetDb();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousBackupsRoot === undefined) delete process.env.BACKUPS_ROOT;
    else process.env.BACKUPS_ROOT = previousBackupsRoot;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const points = () => {
    const lane = path.join(dataDir, "backups/pre-migration");
    return fs.existsSync(lane)
      ? fs.readdirSync(lane).map((name) => path.join(lane, name, "database.db"))
      : [];
  };
  const migration = (sql: string) =>
    fs.writeFileSync(path.join(migrationsDir, "0000_test.sql"), sql);

  it("preserves committed WAL data and explicit IDs before applying SQL", () => {
    const db = getDb();
    db.pragma("wal_autocheckpoint = 0");
    db.exec(
      "CREATE TABLE sentinel (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sentinel VALUES (42, 'before'); CREATE INDEX sentinel_value ON sentinel(value);"
    );
    migration("UPDATE sentinel SET value = 'after';");
    runMigrations(migrationsDir);
    expect(points()).toHaveLength(1);
    const backup = new Database(points()[0], { readonly: true });
    try {
      expect(backup.prepare("SELECT * FROM sentinel").all()).toEqual([{ id: 42, value: "before" }]);
      expect(
        backup.prepare("SELECT name FROM sqlite_schema WHERE name = 'sentinel_value'").get()
      ).toEqual({ name: "sentinel_value" });
      expect(backup.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(
        backup
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'drizzle_universe_migrations'")
          .get()
      ).toBeUndefined();
    } finally {
      backup.close();
    }
    expect(db.prepare("SELECT value FROM sentinel").get()).toEqual({ value: "after" });
    expect(fs.statSync(points()[0]).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(points()[0])).mode & 0o777).toBe(0o700);
  });

  it("protects fresh schema and skips recovery work when no SQL is pending", () => {
    runMigrations(migrationsDir);
    expect(points()).toEqual([]);
    expect(
      getDb()
        .prepare("SELECT name FROM sqlite_schema WHERE name = 'drizzle_universe_migrations'")
        .get()
    ).toBeUndefined();
    migration("CREATE TABLE first_table (id INTEGER PRIMARY KEY);");
    runMigrations(migrationsDir);
    expect(points()).toHaveLength(1);
    const backup = new Database(points()[0], { readonly: true });
    try {
      expect(backup.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).toEqual(
        []
      );
    } finally {
      backup.close();
    }
    runMigrations(migrationsDir);
    expect(points()).toHaveLength(1);
  });

  it("aborts backup path and active transaction failures before schema writes", () => {
    migration("CREATE TABLE forbidden (id INTEGER PRIMARY KEY);");
    const blocker = path.join(dataDir, "blocker");
    fs.writeFileSync(blocker, "keep");
    process.env.BACKUPS_ROOT = path.join(blocker, "backups");
    expect(() => runMigrations(migrationsDir)).toThrow(/pre-migration backup/i);
    expect(getDb().prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).toEqual(
      []
    );
    delete process.env.BACKUPS_ROOT;
    const db = getDb();
    db.exec("BEGIN");
    try {
      expect(() => runMigrations(migrationsDir)).toThrow(/active transaction/i);
    } finally {
      db.exec("ROLLBACK");
    }
    expect(points()).toEqual([]);
  });

  it.each([
    "new root",
    "root parent",
    "lane",
    "lane parent",
    "attempt parent",
    "snapshot file",
    "snapshot directory",
  ])("aborts before schema writes when durability step %s fails", (step) => {
    migration("CREATE TABLE forbidden (id INTEGER PRIMARY KEY);");
    const canonicalDataDir = fs.realpathSync(dataDir);
    const root = path.join(canonicalDataDir, "backups");
    const lane = path.join(root, "pre-migration");
    const originalOpen = fs.openSync;
    const originalSync = fs.fsyncSync;
    const opened = new Map<number, string>();
    const open = vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      const fd = originalOpen(file, flags, mode);
      opened.set(fd, fs.realpathSync(String(file)));
      return fd;
    });
    const spy = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      const file = opened.get(fd) ?? "";
      const selected = {
        "new root": file === root,
        "root parent": file === canonicalDataDir && fs.existsSync(root),
        lane: file === lane,
        "lane parent": file === root && fs.existsSync(lane),
        "attempt parent":
          file === lane && fs.readdirSync(lane).some((name) => name.startsWith("snapshot-")),
        "snapshot file": path.basename(file) === ".pending.db",
        "snapshot directory": path.dirname(file) === lane,
      }[step];
      if (selected) throw new Error("injected disk sync failure");
      originalSync(fd);
    });
    try {
      expect(() => runMigrations(migrationsDir)).toThrow(/pre-migration backup/i);
      expect(getDb().prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).toEqual(
        []
      );
    } finally {
      spy.mockRestore();
      open.mockRestore();
    }
  });

  it("rejects a redirected recovery lane and preserves operator root aliases", () => {
    migration("CREATE TABLE first_table (id INTEGER PRIMARY KEY);");
    const outside = path.join(dataDir, "outside");
    const root = path.join(dataDir, "backups");
    fs.mkdirSync(outside);
    fs.mkdirSync(root);
    fs.symlinkSync(outside, path.join(root, "pre-migration"));
    expect(() => runMigrations(migrationsDir)).toThrow(/pre-migration backup/i);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(getDb().prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).toEqual(
      []
    );
    fs.unlinkSync(path.join(root, "pre-migration"));
    const alias = path.join(dataDir, "backup-alias");
    fs.symlinkSync(root, alias);
    process.env.BACKUPS_ROOT = alias;
    runMigrations(migrationsDir);
    expect(points()).toHaveLength(1);
  });

  it("aborts before schema writes on native backup or publication failure", () => {
    migration("CREATE TABLE forbidden (id INTEGER PRIMARY KEY);");
    const native = getDb().prepare.bind(getDb());
    const backup = vi.spyOn(getDb(), "prepare").mockImplementation((sql) => {
      if (sql === "VACUUM INTO ?") throw new Error("injected native backup failure");
      return native(sql);
    });
    try {
      expect(() => runMigrations(migrationsDir)).toThrow(/pre-migration backup/i);
    } finally {
      backup.mockRestore();
    }
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw "injected publication failure";
    });
    try {
      expect(() => runMigrations(migrationsDir)).toThrow(/pre-migration backup/i);
      expect(getDb().prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).toEqual(
        []
      );
    } finally {
      rename.mockRestore();
    }
  });

  it("rejects missing migration input before creating recovery or schema", () => {
    expect(() => runMigrations(path.join(dataDir, "missing-sql"))).toThrow(
      /Migration directory does not exist/
    );
    expect(points()).toEqual([]);
    expect(getDb().prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).toEqual(
      []
    );
  });

  it("re-syncs existing backup ancestry after an interrupted directory publication", () => {
    migration("CREATE TABLE first_table (id INTEGER PRIMARY KEY);");
    const root = path.join(dataDir, "backups");
    const originalOpen = fs.openSync;
    const originalSync = fs.fsyncSync;
    const opened = new Map<number, string>();
    const open = vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      const fd = originalOpen(file, flags, mode);
      opened.set(fd, String(file));
      return fd;
    });
    let interrupted = false;
    let recoveredParentSync = false;
    const sync = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (opened.get(fd) === dataDir && fs.existsSync(root)) {
        if (!interrupted) {
          interrupted = true;
          throw new Error("interrupted root publication");
        }
        recoveredParentSync = true;
      }
      originalSync(fd);
    });
    try {
      expect(() => runMigrations(migrationsDir)).toThrow(/pre-migration backup/i);
      expect(fs.existsSync(root)).toBe(true);
      expect(getDb().prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).toEqual(
        []
      );
      runMigrations(migrationsDir);
      expect(recoveredParentSync).toBe(true);
      expect(points()).toHaveLength(1);
    } finally {
      sync.mockRestore();
      open.mockRestore();
    }
  });

  it("retains distinct recovery points when later SQL fails", () => {
    const db = getDb();
    db.exec("CREATE TABLE sentinel (id INTEGER PRIMARY KEY); INSERT INTO sentinel VALUES (42);");
    migration("INSERT INTO sentinel VALUES (99); INVALID SQL;");
    expect(() => runMigrations(migrationsDir)).toThrow();
    expect(() => runMigrations(migrationsDir)).toThrow();
    expect(points()).toHaveLength(2);
    expect(db.prepare("SELECT * FROM sentinel").all()).toEqual([{ id: 42 }]);
    expect(db.prepare("SELECT * FROM drizzle_universe_migrations").all()).toEqual([]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    for (const point of points()) {
      const backup = new Database(point, { readonly: true });
      try {
        expect(backup.prepare("SELECT * FROM sentinel").all()).toEqual([{ id: 42 }]);
      } finally {
        backup.close();
      }
    }
  });
});
