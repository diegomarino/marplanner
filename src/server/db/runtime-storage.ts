import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const NETWORK_FILESYSTEMS = new Set([0x6969n, 0x517bn, 0xff534d42n, 0xfe534d42n]);
let warnedPlatform = false;
const activeOwnership = new Set<Database.Database>();

function regularFileOrMissing(file: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`Storage path must not be a symbolic link: ${file}`);
  if (!stat.isFile()) throw new Error(`Storage path must be a regular file: ${file}`);
  if (stat.nlink > 1) throw new Error(`Storage path must not have hard links: ${file}`);
  return true;
}

/** Check the actual file or its immediate existing parent before any SQLite open. */
export function assertLocalStorage(file: string): string {
  const absolute = path.resolve(file);
  const exists = regularFileOrMissing(absolute);
  const parent = fs.realpathSync(path.dirname(absolute));
  const canonical = path.join(parent, path.basename(absolute));
  const type = fs.statfsSync(exists ? canonical : parent, { bigint: true }).type;
  if (process.platform === "linux") {
    if (NETWORK_FILESYSTEMS.has(type)) {
      throw new Error(
        `SQLite storage requires a local filesystem; network filesystem rejected: ${canonical}`
      );
    }
  } else if (!warnedPlatform) {
    warnedPlatform = true;
    console.warn(
      "Storage filesystem classification is unavailable on this platform; use a local filesystem for SQLite."
    );
  }
  return canonical;
}

/** Ownership outlives product connection resets and restore inode replacement. */
export function acquireStorageOwnership(dbPath: string): () => void {
  const databasePath = assertLocalStorage(dbPath);
  const sentinelPath = `${databasePath}.instance-lock.sqlite`;
  assertLocalStorage(sentinelPath);
  const ownership = new Database(sentinelPath, { timeout: 0 });
  try {
    ownership.pragma("journal_mode = DELETE");
    ownership.pragma("locking_mode = EXCLUSIVE");
    ownership.exec(
      "BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS ownership (id INTEGER PRIMARY KEY); INSERT OR REPLACE INTO ownership (id) VALUES (1); COMMIT"
    );
  } catch (error) {
    ownership.close();
    if ((error as { code?: string }).code === "SQLITE_BUSY") {
      throw new Error(
        `Database is already owned by another application instance: ${databasePath}`,
        { cause: error }
      );
    }
    throw new Error(`Cannot acquire database storage ownership: ${databasePath}`, { cause: error });
  }
  activeOwnership.add(ownership);
  let released = false;
  const release = () => {
    if (released) return;
    ownership.close();
    released = true;
    activeOwnership.delete(ownership);
  };
  return release;
}
