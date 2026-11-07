import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALL_SCHEMA_TABLES } from "../helpers/schema-tables";

const DRIZZLE_DIR = "drizzle";
const BASELINE_FILE = "0000_baseline.sql";

describe("database lifecycle current baseline", () => {
  it("starts from the squashed baseline; later changes ship as numbered forward migrations", () => {
    const migrationFiles = readdirSync(DRIZZLE_DIR)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    expect(migrationFiles[0]).toBe(BASELINE_FILE);
    expect(migrationFiles).toContain("0001_reminder_content.sql");
    expect(migrationFiles).toContain("0002_member_celebration.sql");
    for (const file of migrationFiles.slice(1)) expect(file).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
  });

  it("keeps the reviewed sentinel, both tables, and canonical day-period rows in SQL", () => {
    const sql = readFileSync(`${DRIZZLE_DIR}/${BASELINE_FILE}`, "utf8");

    expect(sql).toContain("CREATE TABLE `seed_profile_state`");
    expect(sql).toContain("CREATE TABLE `calendar_external_sources`");
    expect(sql).toContain("FROM temp.`plugin_lifecycle_migration_context`");
    expect(sql).toContain(
      "INSERT INTO `day_periods` (`id`, `label_key`, `start_minutes`, `sort_order`) VALUES ('morning', 'dayPeriod.morning', 300, 0)"
    );
    expect(sql).toContain(
      "INSERT INTO `day_periods` (`id`, `label_key`, `start_minutes`, `sort_order`) VALUES ('afternoon', 'dayPeriod.afternoon', 720, 1)"
    );
    expect(sql).toContain(
      "INSERT INTO `day_periods` (`id`, `label_key`, `start_minutes`, `sort_order`) VALUES ('evening', 'dayPeriod.evening', 1080, 2)"
    );
    expect(sql).toContain(
      "INSERT INTO `day_periods` (`id`, `label_key`, `start_minutes`, `sort_order`) VALUES ('night', 'dayPeriod.night', 1260, 3)"
    );
  });

  it("uses a table oracle re-derived from the current TypeScript schema", () => {
    expect(ALL_SCHEMA_TABLES).toEqual(
      expect.arrayContaining([
        "seed_profile_state",
        "calendar_external_sources",
        "calendar_external_event_meta",
        "calendar_highlight_rules",
        "drizzle_universe_migrations",
      ])
    );
  });
});
