import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterAll, beforeAll } from "vitest";
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
