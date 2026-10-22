import fs from "node:fs";
import path from "node:path";
import Database, { type Database as DBType } from "better-sqlite3";
import { assertLocalStorage } from "./runtime-storage";

export function openClient(dbPath: string) {
  const file = assertLocalStorage(dbPath);
  const created = !fs.existsSync(file);
  const db = new Database(file);
  // A database this process creates holds household state: make it owner-only before WAL
  // mode creates -wal/-shm, which SQLite gives the database file's own mode. An existing,
  // operator-managed file keeps whatever mode it has.
  if (created) fs.chmodSync(file, 0o600);
  db.pragma("journal_mode=WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

let _db: DBType | undefined;

export function resolveDbPath(): string {
  const dir = process.env.DATA_DIR ?? process.cwd();
  const file = process.env.DATABASE_PATH ?? "marplanner.db";
  return path.resolve(dir, file);
}

export function getDb(): DBType {
  if (!_db) _db = openClient(resolveDbPath());
  return _db;
}

export function resetDb(): void {
  if (_db) {
    _db.close();
    _db = undefined;
  }
}

export type DatabaseConnection = DBType;
