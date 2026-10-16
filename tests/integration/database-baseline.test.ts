import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { getDb } from "../../src/server/db/client";
import { ALL_SCHEMA_TABLES } from "../helpers/schema-tables";
import { useIsolatedDb } from "../helpers/db";

const PROJECT_ROOT = process.cwd();
const BASELINE_FILE = join(PROJECT_ROOT, "drizzle", "0000_baseline.sql");
const DRIZZLE_KIT = join(PROJECT_ROOT, "node_modules", "drizzle-kit", "bin.cjs");
const SCHEMA_FILE = join(PROJECT_ROOT, "src", "server", "db", "schema.ts");
type Catalog = {
  tables: Array<{
    columns: Array<{
      dflt_value: string | null;
      name: string;
      notnull: number;
      pk: number;
      type: string;
    }>;
    definition: string;
    foreignKeys: Array<{
      from: string;
      match: string;
      on_delete: string;
      on_update: string;
      table: string;
      to: string;
    }>;
    indexes: Array<{
      columns: Array<{ coll: string; desc: number; name: string; seqno: number }>;
      name: string;
      origin: string;
      partial: number;
      unique: number;
    }>;
    name: string;
  }>;
};

function quoteIdentifier(identifier: string): string {
  return `\`${identifier.replaceAll("`", "``")}\``;
}

function normalizeSql(sql: string): string {
  return sql
    .replaceAll(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replaceAll(/["`]/g, "")
    .replaceAll(/\b[a-z_][a-z0-9_]*\./g, "")
    .replace(/\s+strict$/, "");
}

function readCatalog(db: Database.Database): Catalog {
  const tables = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all() as { name: string; sql: string }[];

  return {
    tables: tables.map((table) => {
      const tableName = quoteIdentifier(table.name);
      const indexRows = db.prepare(`PRAGMA index_list(${tableName})`).all() as {
        name: string;
        origin: string;
        partial: number;
        unique: number;
      }[];

      return {
        name: table.name,
        definition: normalizeSql(table.sql),
        columns: (
          db.prepare(`PRAGMA table_xinfo(${tableName})`).all() as {
            dflt_value: string | null;
            name: string;
            notnull: number;
            pk: number;
            type: string;
          }[]
        ).map(({ dflt_value, name, notnull, pk, type }) => ({
          dflt_value,
          name,
          notnull,
          pk,
          type,
        })),
        indexes: indexRows
          .map((index) => ({
            ...index,
            columns: (
              db.prepare(`PRAGMA index_xinfo(${quoteIdentifier(index.name)})`).all() as {
                coll: string;
                desc: number;
                key: number;
                name: string | null;
                seqno: number;
              }[]
            )
              .filter((column) => column.key === 1)
              .map(({ coll, desc, name, seqno }) => ({
                coll,
                desc,
                name: name ?? "",
                seqno,
              })),
          }))
          .sort((left, right) => left.name.localeCompare(right.name)),
        foreignKeys: (
          db.prepare(`PRAGMA foreign_key_list(${tableName})`).all() as {
            from: string;
            match: string;
            on_delete: string;
            on_update: string;
            table: string;
            to: string;
          }[]
        )
          .map(({ from, match, on_delete, on_update, table: referencedTable, to }) => ({
            from,
            match,
            on_delete,
            on_update,
            table: referencedTable,
            to,
          }))
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      };
    }),
  };
}

function instantiateCatalog(sqlFile: string, databaseFile: string): Catalog {
  const db = new Database(databaseFile);
  try {
    // The committed baseline reads the runner's lineage handoff; a generated file ignores it.
    db.exec(
      "CREATE TEMP TABLE plugin_lifecycle_migration_context (kind TEXT, pre_run_migration_files TEXT, captured_at TEXT);" +
        "INSERT INTO temp.plugin_lifecycle_migration_context VALUES ('fresh', '[]', '2026-10-16T00:00:00.000Z')"
    );
    db.exec(readFileSync(sqlFile, "utf8").replaceAll("--> statement-breakpoint", ""));
    return readCatalog(db);
  } finally {
    db.close();
  }
}

function generateCurrentSchemaCatalog(tempDir: string): Catalog {
  const outputDir = join(tempDir, "generated");
  const configFile = join(tempDir, "drizzle.config.ts");
  writeFileSync(
    configFile,
    `export default ${JSON.stringify({ dialect: "sqlite", out: outputDir, schema: SCHEMA_FILE })};\n`,
    "utf8"
  );
  execFileSync(
    process.execPath,
    [DRIZZLE_KIT, "generate", "--config", configFile, "--name", "current_schema"],
    { cwd: PROJECT_ROOT, stdio: "pipe" }
  );
  const generatedSql = readdirSync(outputDir).find((file) => file.endsWith(".sql"));
  if (!generatedSql) throw new Error("Drizzle did not generate a current-schema SQL file");
  return instantiateCatalog(join(outputDir, generatedSql), join(tempDir, "generated.sqlite"));
}

describe("database lifecycle fresh current baseline", () => {
  useIsolatedDb({ pluginState: "inactive" });

  it(
    "is semantically equivalent to a clean Drizzle generation from the current TypeScript schema",
    { timeout: 30_000 },
    () => {
      const tempDir = mkdtempSync(join(tmpdir(), "mp-current-baseline-catalog-"));
      try {
        const generated = generateCurrentSchemaCatalog(tempDir);
        const committed = instantiateCatalog(BASELINE_FILE, join(tempDir, "baseline.sqlite"));

        expect(committed).toEqual(generated);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  );

  it("installs the re-derived schema from the single baseline and preserves foreign keys", () => {
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];

    expect(ALL_SCHEMA_TABLES).toEqual(
      expect.arrayContaining(["seed_profile_state", "calendar_external_sources"])
    );
    expect(tables.map((table) => table.name)).toEqual(ALL_SCHEMA_TABLES);
    expect(
      db.prepare("SELECT fileName FROM drizzle_universe_migrations ORDER BY fileName").all()
    ).toEqual([{ fileName: "0000_baseline.sql" }]);

    const foreignKeys = ALL_SCHEMA_TABLES.flatMap((table) =>
      (
        db.prepare(`PRAGMA foreign_key_list(\`${table}\`)`).all() as {
          from: string;
          on_delete: string;
          table: string;
          to: string;
        }[]
      ).map(
        (foreignKey) =>
          `${table}.${foreignKey.from}->${foreignKey.table}.${foreignKey.to} ${foreignKey.on_delete}`
      )
    ).sort();

    expect(foreignKeys).toEqual([
      "calendar_assignments.event_id->calendar_events.id CASCADE",
      "calendar_assignments.member_id->members.id CASCADE",
      "calendar_external_event_meta.event_id->calendar_events.id CASCADE",
      "calendar_external_event_meta.source_id->calendar_external_sources.id RESTRICT",
      "chore_completions.chore_id->chores.id NO ACTION",
      "chore_completions.member_id->members.id NO ACTION",
      "chores.routine_id->routines.id NO ACTION",
      "meal_entries.meal_plan_id->meal_plans.id NO ACTION",
      "meal_entries.recipe_id->recipes.id CASCADE",
      "plugin_lifecycle_operations.plugin_id->plugin_activation_registry.plugin_id RESTRICT",
      "plugin_migration_journal.plugin_id->plugin_activation_registry.plugin_id RESTRICT",
      "print_jobs.record_id->print_records.id CASCADE",
      "reminder_assignment.reminder_id->reminder.id CASCADE",
      "routine_assignments.member_id->members.id NO ACTION",
      "routine_assignments.routine_id->routines.id NO ACTION",
      "routines.day_period_id->day_periods.id NO ACTION",
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("contains only canonical fixed rows and no legacy development data", () => {
    const db = getDb();
    const fixedDayPeriods = db
      .prepare(
        "SELECT id, label_key, start_minutes, sort_order FROM day_periods ORDER BY sort_order"
      )
      .all();

    expect(fixedDayPeriods).toEqual([
      { id: "morning", label_key: "dayPeriod.morning", start_minutes: 300, sort_order: 0 },
      { id: "afternoon", label_key: "dayPeriod.afternoon", start_minutes: 720, sort_order: 1 },
      { id: "evening", label_key: "dayPeriod.evening", start_minutes: 1080, sort_order: 2 },
      { id: "night", label_key: "dayPeriod.night", start_minutes: 1260, sort_order: 3 },
    ]);

    expect(db.prepare("SELECT COUNT(*) AS count FROM installation_lineage").get()).toEqual({
      count: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM plugin_activation_registry").get()).toEqual({
      count: 9,
    });
    expect(
      db.prepare("SELECT DISTINCT state FROM plugin_activation_registry ORDER BY state").all()
    ).toEqual([{ state: "inactive" }]);

    for (const table of ALL_SCHEMA_TABLES) {
      if (
        table === "day_periods" ||
        table === "drizzle_universe_migrations" ||
        table === "installation_lineage" ||
        table === "plugin_activation_registry"
      )
        continue;
      expect(db.prepare(`SELECT COUNT(*) AS count FROM \`${table}\``).get()).toEqual({ count: 0 });
    }
  });

  it("creates the ten-colour member palette and the briefing weekday schedule directly", () => {
    const db = getDb();
    const insertMember = db.prepare(
      "INSERT INTO members (id, display_name, color_key, role, created_at, updated_at) VALUES (?, ?, ?, 'parent', 1, 1)"
    );
    for (const colour of [
      "blue",
      "sky",
      "teal",
      "green",
      "lime",
      "amber",
      "orange",
      "red",
      "pink",
      "violet",
    ]) {
      insertMember.run(`member-${colour}`, colour, colour);
    }
    for (const retired of ["cyan", "yellow", "rose", "fuchsia", "purple", "indigo"]) {
      expect(() => insertMember.run(`member-${retired}`, retired, retired)).toThrow(
        /CHECK constraint failed: members_color_key_check/
      );
    }

    const optinColumns = db.prepare("PRAGMA table_info(daily_briefing_optin)").all() as {
      name: string;
      notnull: number;
      type: string;
    }[];
    expect(optinColumns.find((column) => column.name === "weekdays")).toMatchObject({
      notnull: 0,
      type: "TEXT",
    });
  });
});
