import tsEslint from "typescript-eslint";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as host from "../../src/server/host-api";
import * as schema from "../../src/server/db/schema";
import {
  derivedEndMinutes,
  hhmmToMinutes,
  minutesToHhmm,
  PeriodOrderError,
  PeriodUniquenessError,
  resolveActivePeriod,
  validateStartOrdering,
} from "../../src/shared/dayPeriods";
import { MEMBER_COLOR_KEYS, chooseMemberColorKey } from "../../src/shared/member-color";
import { conditionKeyForCode, clampRainPct } from "../../src/shared/weather";
import { isDateOnly } from "../../src/shared/householdTime";
import { useIsolatedDb } from "../helpers/db";

const fixture = JSON.parse(
  readFileSync(resolve("tests/fixtures/assembly-cohort.json"), "utf8")
) as {
  batch: string;
  hostApiExportNames: string[];
};
const EXPECTED_SCHEMA_TABLES = [
  "api_keys",
  "members",
  "settings_objects",
  "admin_config",
  "day_periods",
  "seed_profile_state",
  "calendar_events",
  "calendar_external_sources",
  "calendar_external_event_meta",
  "calendar_highlight_rules",
  "calendar_assignments",
  "routines",
  "chores",
  "routine_assignments",
  "chore_completions",
  "reminder",
  "reminder_assignment",
  "recipes",
  "meal_plans",
  "meal_entries",
  "daily_messages",
  "daily_briefing",
  "daily_briefing_optin",
  "daily_briefing_block_cache",
  "daily_briefing_member_block_settings",
  "daily_briefing_block_order",
  "daily_briefing_settings",
  "client_log",
  "time_announcements",
  "network_devices",
  "print_records",
  "print_jobs",
  "printer_capabilities",
  "installation_lineage",
  "plugin_activation_registry",
  "plugin_lifecycle_operations",
  "plugin_migration_journal",
].sort();

describe("foundation host API", () => {
  useIsolatedDb({ pluginState: "inactive" });

  it("matches the reviewed full export inventory and exposes real core capabilities", async () => {
    expect(fixture.batch).toBe("BFULL");
    expect(Object.keys(host).sort()).toEqual([...fixture.hostApiExportNames].sort());
    expect(host.getDb().prepare("SELECT 1 AS value").get()).toEqual({ value: 1 });
    expect(host.readHouseholdTimezone()).toBe("Europe/Madrid");
    expect(host.getOperatorConfig("unknown.key")).toBeUndefined();
    const received: unknown[] = [];
    host.subscribe("routines.completion_changed", (payload) => received.push(payload));
    const payload = {
      memberId: "member-1",
      choreId: "chore-1",
      routineId: "routine-1",
      date: "2026-09-28",
      completed: true,
      timestamp: 1,
    };
    host.emit("routines.completion_changed", payload);
    await Promise.resolve();
    await Promise.resolve();
    expect(received).toEqual([payload]);
    expect(Object.isFrozen(received[0])).toBe(true);
  });

  it("keeps every Drizzle table and constraint reachable in the migrated database", () => {
    const definitions = Object.values(schema).map((table) => getTableConfig(table));
    expect(definitions.map((table) => table.name).sort()).toEqual(EXPECTED_SCHEMA_TABLES);
    const migrated = new Set(
      (
        host.getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name)
    );
    for (const table of definitions) {
      expect(migrated.has(table.name)).toBe(true);
      expect(table.columns.length).toBeGreaterThan(0);
      const names = table.checks.map((check) => check.name);
      expect(new Set(names).size).toBe(names.length);
      for (const foreignKey of table.foreignKeys) {
        const reference = foreignKey.reference();
        expect(reference.columns).toHaveLength(reference.foreignColumns.length);
        expect(reference.columns.length).toBeGreaterThan(0);
        expect(EXPECTED_SCHEMA_TABLES).toContain(getTableConfig(reference.foreignTable).name);
      }
    }
  });

  it("preserves the shared four-period clock, midnight wrap, and invalid-boundary errors", () => {
    const periods = [
      { id: "morning" as const, labelKey: "morning", start: "05:00", sortOrder: 0 },
      { id: "afternoon" as const, labelKey: "afternoon", start: "12:00", sortOrder: 1 },
      { id: "evening" as const, labelKey: "evening", start: "18:00", sortOrder: 2 },
      { id: "night" as const, labelKey: "night", start: "21:00", sortOrder: 3 },
    ];
    expect(hhmmToMinutes("23:59")).toBe(1439);
    expect(minutesToHhmm(0)).toBe("00:00");
    expect(minutesToHhmm(1439)).toBe("23:59");
    for (const invalid of ["24:00", "12:60", "1:00", "secret"]) {
      expect(() => hhmmToMinutes(invalid)).toThrow();
    }
    for (const invalid of [-1, 1440]) expect(() => minutesToHhmm(invalid)).toThrow();
    expect(() => validateStartOrdering(periods)).not.toThrow();
    expect(() =>
      validateStartOrdering([periods[0], { ...periods[1], start: "05:00" }, periods[2], periods[3]])
    ).toThrow(PeriodUniquenessError);
    expect(() =>
      validateStartOrdering([periods[0], { ...periods[1], start: "04:00" }, periods[2], periods[3]])
    ).toThrow(PeriodOrderError);
    expect(derivedEndMinutes(periods, "night")).toBe(300);
    expect(derivedEndMinutes(periods, "morning")).toBe(720);
    expect(() => derivedEndMinutes([], "morning")).toThrow("Unknown period ID");
    expect(() => derivedEndMinutes(periods.slice(0, 3), "evening")).toThrow("Missing period");
    expect(resolveActivePeriod(periods, 0)).toBe("night");
    expect(resolveActivePeriod(periods, 300)).toBe("morning");
    expect(resolveActivePeriod(periods, 720)).toBe("afternoon");
    expect(resolveActivePeriod(periods, 1080)).toBe("evening");
    expect(resolveActivePeriod(periods, 1260)).toBe("night");
    expect(() => resolveActivePeriod([], 0)).toThrow("no periods");
  });

  it("keeps shared member identity and forecast normalization bounded", () => {
    expect(isDateOnly("2026-09-29")).toBe(true);
    expect(isDateOnly("2026-9-29")).toBe(false);
    expect(chooseMemberColorKey([])).toBe("blue");
    expect(chooseMemberColorKey(["blue", "sky"])).toBe("teal");
    expect(chooseMemberColorKey(MEMBER_COLOR_KEYS)).toBe("blue");
    expect(conditionKeyForCode(0)).toBe("clear");
    expect(conditionKeyForCode(99)).toBe("thunderstormHail");
    expect(conditionKeyForCode(999)).toBe("unknown");
    expect(clampRainPct(45.7)).toBe(46);
    expect(clampRainPct(-1)).toBe(0);
    expect(clampRainPct(101)).toBe(100);
    expect(clampRainPct(Number.NaN)).toBe(0);
  });

  it("allows the barrel while rejecting raw core imports through normalized plugin paths", async () => {
    const eslint = new ESLint({
      cwd: process.cwd(),
      overrideConfig: tsEslint.configs.disableTypeChecked,
    });
    const filePath = resolve("src/server/modules/weather/__foundation_fixture__.ts");
    const good = await eslint.lintText(
      'import { emit } from "../../host-api";\nexport const use = emit;\n',
      { filePath }
    );
    expect(
      good[0]?.messages.filter((message) => message.ruleId === "import-x/no-restricted-paths")
    ).toEqual([]);
    for (const target of ["../../lib/event-bus", "../../db/client", "../../lib/../db/client"]) {
      const bad = await eslint.lintText(
        `import { getDb } from "${target}";\nexport const use = getDb;\n`,
        { filePath }
      );
      expect(bad[0]?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ruleId: "import-x/no-restricted-paths" }),
        ])
      );
    }
  });
});
