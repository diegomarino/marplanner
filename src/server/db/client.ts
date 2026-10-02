import path from "node:path";
import Database, { type Database as DBType } from "better-sqlite3";
import { assertLocalStorage } from "./runtime-storage";

export function openClient(dbPath: string) {
  const db = new Database(assertLocalStorage(dbPath));
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
