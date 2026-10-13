import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALL_SCHEMA_TABLES } from "../helpers/schema-tables";

const DRIZZLE_DIR = "drizzle";
const BASELINE_FILE = "0000_current_baseline.sql";
const CALENDAR_FEED_SYNC_MIGRATION = "0001_calendar_feed_sync.sql";
const PLUGIN_LIFECYCLE_MIGRATION = "0002_plugin_lifecycle.sql";
const CALENDAR_EVENT_DETAILS_MIGRATION = "0003_calendar_event_details.sql";

describe("database lifecycle current baseline", () => {
  it("keeps the current baseline plus the reviewed forward migrations", () => {
    const migrationFiles = readdirSync(DRIZZLE_DIR)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    expect(migrationFiles).toEqual([
      BASELINE_FILE,
      CALENDAR_FEED_SYNC_MIGRATION,
      PLUGIN_LIFECYCLE_MIGRATION,
      CALENDAR_EVENT_DETAILS_MIGRATION,
    ]);
    expect(migrationFiles.filter((file) => file.startsWith("0001"))).toEqual([
      CALENDAR_FEED_SYNC_MIGRATION,
    ]);
  });

  it("keeps the reviewed sentinel, both tables, and canonical day-period rows in SQL", () => {
    const sql = readFileSync(`${DRIZZLE_DIR}/${BASELINE_FILE}`, "utf8");

    expect(sql).toContain("CREATE TABLE `seed_profile_state`");
    expect(sql).toContain("CREATE TABLE `calendar_external_sources`");
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
