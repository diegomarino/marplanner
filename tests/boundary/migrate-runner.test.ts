import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
    fs.writeFileSync(path.join(migrationsDir, "0000_baseline.sql"), BASELINE_SQL, "utf-8");
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
    fs.writeFileSync(path.join(migrationsDir, "0000_baseline.sql"), BASELINE_SQL, "utf-8");
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

/** (US3) — SC-006 / BACKGROUND-JOBS-SCHEDULER-INV-03 schema
 * snapshot: the scheduler core owns "no scheduler-owned table[s]" (design/
 * contracts/background-jobs-scheduler.md INV-03) — it ships zero migrations
 * of its own (`src/server/scheduler/index.ts` has no `drizzle/000N_*.sql`
 * counterpart). This proves the REAL, current migration set (`drizzle/*.sql`,
 * run via the default `runMigrations` path — not the synthetic
 * migrationsDir fixtures above) produces EXACTLY this table set: no more, no
 * fewer, no scheduler-specific addition anywhere in the chain.
 * The table list itself lives in `tests/helpers/schema-tables.ts`
 * (`ALL_SCHEMA_TABLES`) — shared with `tests/integration/scheduler-lifecycle.
 * test.ts`the INV-05 pure-reads sweep, which reuses it to snapshot row counts
 * on the WHOLE schema rather than only the two tables the scheduler's own
 * jobs happen to write to. See that file's docblock for the re-derivation
 * recipe.
 */
describe("schema table set (T010 — SC-006 / BACKGROUND-JOBS-SCHEDULER-INV-03)", () => {
  useIsolatedDb();

  it("BACKGROUND-JOBS-SCHEDULER-INV-03: sqlite_master's table set is exactly ALL_SCHEMA_TABLES — slice-012 adds none", () => {
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    expect(tables.map((t) => t.name)).toEqual(ALL_SCHEMA_TABLES);
  });
});
