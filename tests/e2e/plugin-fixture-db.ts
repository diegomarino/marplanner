import { getDb, resetDb } from "../../src/server/db/client";
import { runMigrations } from "../../src/server/db/migrate";
import { PLUGIN_IDS, type PluginId } from "../../src/shared/plugins";

export function prepareActivePlugins(
  dataDir: string,
  pluginIds: readonly PluginId[] = PLUGIN_IDS
): void {
  const previousDataDir = process.env.DATA_DIR;
  const previousDatabasePath = process.env.DATABASE_PATH;
  try {
    process.env.DATA_DIR = dataDir;
    process.env.DATABASE_PATH = "marplanner.db";
    resetDb();
    runMigrations();
    const placeholders = pluginIds.map(() => "?").join(", ");
    getDb()
      .prepare(
        `UPDATE plugin_activation_registry
         SET state = 'active', error_code = NULL, error_message = NULL
         WHERE plugin_id IN (${placeholders})`
      )
      .run(...pluginIds);
  } finally {
    resetDb();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
  }
}
