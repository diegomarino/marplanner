import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach } from "vitest";
import { getDb, resetDb } from "../../src/server/db/client";
import { runMigrations } from "../../src/server/db/migrate";

interface IsolatedDbOptions {
  pluginState?: "active" | "inactive";
}

export function useIsolatedDb({ pluginState = "active" }: IsolatedDbOptions = {}) {
  let dir: string;
  let prev: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mp-test-"));
    prev = process.env.DATA_DIR;
    process.env.DATA_DIR = dir;
    resetDb();
    runMigrations();
    if (pluginState === "active") {
      getDb().prepare("UPDATE plugin_activation_registry SET state = 'active'").run();
    }
  });
  afterEach(() => {
    resetDb();
    if (prev === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prev;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup; ignore */
    }
  });
  return { dir: () => dir };
}
