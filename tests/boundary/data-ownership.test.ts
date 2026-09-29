import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

/** docs/features/plugin-system.md — consolidated data-ownership
 * guard (ADR-039 Rule B, PLUGIN-SYSTEM-INV-02/INV-07, §3/FR-010).
 * Folds three already-closed guarantees into one standing regression gate,
 * proven directly against the real source tree (no fixtures):
 * 1. Plugin-table member FKs are 0, core-table member FKs stay 3 — read at
 * the schema.ts source level (drizzle `.references(=> members.id)`),
 * complementing fk-drop-integrity.test.ts's live-DB PRAGMA check.
 * 2. No raw SQL under a plugin module root (see PLUGIN_MODULES below)
 * reads or writes any NON-OWN table — forbidden(P) = every sqliteTable
 * name in schema.ts MINUS P's own tables, so each plugin is rejected from
 * core tables AND every OTHER plugin's tables (INV-02/INV-07). The
 * matcher accepts bare, `"quoted"`, `` `backtick` ``, `[bracketed]`, and
 * schema-qualified (`main.T`) SQLite identifier forms — a bare-only
 * matcher would let a quoted forbidden reference slip past the gate
 * green .
 * 3. No plugin file's relative import escapes its own subtree except via
 * the host-API barrel or src/shared — the barrel is the sole seam
 * (complements the ESLint-driven import-boundary.test.ts / zones).
 */

const repoRoot = path.resolve(__dirname, "../..");
const modulesRoot = path.join(repoRoot, "src/server/modules");
const hostApiPath = path.join(repoRoot, "src/server/host-api");
const sharedPath = path.join(repoRoot, "src/shared");
const schemaPath = path.join(repoRoot, "src/server/db/schema.ts");
const schemaSource = fs.readFileSync(schemaPath, "utf8");

// `time-announcements` (fifth eslint zone), `network-devices` (
// /, seventh eslint zone), `daily-briefing` (its own eslint zone), and `printing`
// (eighth eslint zone — deferred from since this roster's own
// listSourceFiles(moduleDir) throws ENOENT before the module has real files; see the
// commit body) are all added below, per their own PLUGIN_MODULES entries. `weather`,
// PLUGIN-SYSTEM's sixth zone, has no owned table and is intentionally absent from this roster.
const PLUGIN_MODULES = [
  "reminders",
  "daily-messages",
  "meals",
  "time-announcements",
  "network-devices",
  "daily-briefing",
  "printing",
] as const;
type PluginModule = (typeof PLUGIN_MODULES)[number];

const OWN_TABLES: Record<PluginModule, string[]> = {
  reminders: ["reminder", "reminder_assignment"],
  "daily-messages": ["daily_messages"],
  meals: ["meal_plans", "meal_entries", "recipes"],
  "time-announcements": ["time_announcements"],
  "network-devices": ["network_devices"],
  // added 4 own tables: daily_briefing_block_cache,
  // daily_briefing_member_block_settings, daily_briefing_block_order, daily_briefing_settings.
  "daily-briefing": [
    "daily_briefing",
    "daily_briefing_optin",
    "daily_briefing_block_cache",
    "daily_briefing_member_block_settings",
    "daily_briefing_block_order",
    "daily_briefing_settings",
  ],
  // added `printer_capabilities` (FR-021/the capability marker) —
  // still printing's own table, just a third one.
  printing: ["print_jobs", "print_records", "printer_capabilities"],
};

const ALL_TABLE_NAMES = Array.from(schemaSource.matchAll(/sqliteTable\(\s*["']([a-z_]+)["']/g)).map(
  (m) => m[1]
);

function forbiddenTablesFor(plugin: PluginModule): string[] {
  return ALL_TABLE_NAMES.filter((table) => !OWN_TABLES[plugin].includes(table));
}

function tableBlock(varName: string): string {
  const start = schemaSource.indexOf(`export const ${varName} = sqliteTable(`);
  if (start === -1) throw new Error(`table var "${varName}" not found in schema.ts`);
  const nextExport = schemaSource.indexOf("\nexport const", start + 1);
  return schemaSource.slice(start, nextExport === -1 ? undefined : nextExport);
}

function memberFkCount(varName: string): number {
  const matches = tableBlock(varName).match(/\.references\(\(\)\s*=>\s*members\.id/g);
  return matches ? matches.length : 0;
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A SQLite table reference, accepting every quoting form the tokenizer
 * treats as equivalent to the bare name: `"T"`, `` `T` ``, `[T]`, or a bare/
 * schema-qualified `(db.)T` — each delimiter form is self-bounding (the
 * quote/bracket/backtick itself prevents a `member`-in-`members` partial
 * match), and the bare/qualified form keeps the trailing `\b`.
 */
function tableReferencePattern(table: string): string {
  const t = escapeRegExp(table);
  return `(?:"${t}"|\`${t}\`|\\[${t}\\]|(?:\\w+\\.)?${t}\\b)`;
}

function rawSqlViolations(fileSource: string, forbidden: string[]): string[] {
  return forbidden.filter((table) => {
    const ref = tableReferencePattern(table);
    const patterns = [
      new RegExp(`\\b(?:FROM|JOIN)\\s+${ref}`, "i"),
      new RegExp(`\\bUPDATE\\s+${ref}`, "i"),
      new RegExp(`\\bINSERT\\s+INTO\\s+${ref}`, "i"),
      new RegExp(`\\bDELETE\\s+FROM\\s+${ref}`, "i"),
    ];
    return patterns.some((re) => re.test(fileSource));
  });
}

const IMPORT_SPECIFIER_RE = /(?:from\s+|import\()\s*["']([^"']+)["']/g;

function importSpecifiers(fileSource: string): string[] {
  return Array.from(fileSource.matchAll(IMPORT_SPECIFIER_RE)).map((m) => m[1]);
}

describe("data-ownership — table inventory (guards the forbidden-set derivation itself)", () => {
  it("schema.ts declares exactly 37 sqliteTable definitions", () => {
    // added `client_log` (core Tier-0, not plugin-namespaced) — 19 -> 20.
    // added `time_announcements` (PLUGIN-owned — the fifth eslint import-boundary
    // zone, src/server/modules/time-announcements — NOT core Tier-0 like client_log) — 20 -> 21.
    // added `network_devices` (PLUGIN-owned — the seventh eslint import-boundary
    // zone, src/server/modules/network-devices) — 21 -> 22.
    // added `print_jobs` + `print_records` (PLUGIN-owned — the eighth eslint
    // import-boundary zone, src/server/modules/printing; PLUGIN_MODULES roster entry landed in
    //, the commit that first gives the module real files — see the commit body for
    // why it couldn't land in) — 22 -> 24.
    // added `printer_capabilities` (FR-021/the capability marker,
    // same printing plugin) — 24 -> 25.
    // added 4 daily-briefing-owned tables:
    // daily_briefing_block_cache, daily_briefing_member_block_settings,
    // daily_briefing_block_order, daily_briefing_settings — 25 -> 29; adds
    // calendar_external_sources — 29 -> 30; adds the core seed_profile_state marker
    // table — 30 -> 31; adds calendar_external_event_meta and
    // calendar_highlight_rules — 31 -> 33; adds four core-owned lifecycle
    // tables — 33 -> 37.
    expect(ALL_TABLE_NAMES).toHaveLength(37);
  });

  it("per-plugin forbidden-table counts (all tables minus the plugin's own)", () => {
    expect(forbiddenTablesFor("printing")).toHaveLength(34);
    expect(forbiddenTablesFor("reminders")).toHaveLength(35);
    expect(forbiddenTablesFor("daily-messages")).toHaveLength(36);
    expect(forbiddenTablesFor("meals")).toHaveLength(34);
    expect(forbiddenTablesFor("time-announcements")).toHaveLength(36);
    expect(forbiddenTablesFor("network-devices")).toHaveLength(36);
    expect(forbiddenTablesFor("daily-briefing")).toHaveLength(31);
  });
});

describe("data-ownership — schema.ts member-FK counts (source-level, INV-02)", () => {
  it("plugin tables (reminder_assignment, daily_messages) have 0 member FKs", () => {
    expect(memberFkCount("reminderAssignments")).toBe(0);
    expect(memberFkCount("dailyMessages")).toBe(0);
  });

  it("the 3 core tables keep their member FK (calendar_assignments, routine_assignments, chore_completions)", () => {
    expect(memberFkCount("calendarAssignments")).toBe(1);
    expect(memberFkCount("routineAssignments")).toBe(1);
    expect(memberFkCount("choreCompletions")).toBe(1);
  });

  it("exactly 3 `references(() => members.id)` occurrences exist in schema.ts", () => {
    const total = schemaSource.match(/\.references\(\(\)\s*=>\s*members\.id/g) ?? [];
    expect(total).toHaveLength(3);
  });
});

describe("data-ownership — 0 raw SQL touching a NON-OWN table per plugin module root (§3)", () => {
  for (const plugin of PLUGIN_MODULES) {
    it(`${plugin}: no raw SQL read or write reaches a core or peer-plugin table`, () => {
      const moduleDir = path.join(modulesRoot, plugin);
      const files = listSourceFiles(moduleDir);
      expect(files.length).toBeGreaterThan(0);

      const forbidden = forbiddenTablesFor(plugin);
      const violations = files.flatMap((file) => {
        const source = fs.readFileSync(file, "utf8");
        return rawSqlViolations(source, forbidden).map(
          (table) => `${path.relative(repoRoot, file)}: raw SQL touches "${table}"`
        );
      });
      expect(violations).toEqual([]);
    });
  }
});

describe("data-ownership — SQL matcher catches quoted/qualified identifiers (Codex P2 regression, PR #524)", () => {
  const FORBIDDEN_FORMS: Array<{ label: string; sql: string }> = [
    { label: "double-quoted", sql: 'SELECT * FROM "members" WHERE id = ?' },
    { label: "backtick-quoted", sql: "SELECT * FROM `members` WHERE id = ?" },
    { label: "bracketed", sql: "DELETE FROM [members] WHERE id = ?" },
    { label: "schema-qualified", sql: "UPDATE main.members SET display_name = ? WHERE id = ?" },
  ];

  for (const { label, sql } of FORBIDDEN_FORMS) {
    it(`a ${label} reference to a forbidden table is caught`, () => {
      expect(rawSqlViolations(sql, ["members"])).toContain("members");
    });
  }

  it("a quoted reference to an OWN (non-forbidden) table is not a false positive", () => {
    expect(rawSqlViolations('SELECT * FROM "reminder" WHERE id = ?', ["members"])).toEqual([]);
  });

  it("a quoted table name that only shares a prefix with the forbidden name is not a false positive", () => {
    // "member_notes" must not be caught while scanning for the forbidden table "member"
    expect(rawSqlViolations('SELECT * FROM "member_notes" WHERE id = ?', ["member"])).toEqual([]);
  });
});

describe("data-ownership — 0 forbidden imports per plugin module root (INV-07/FR-002)", () => {
  for (const plugin of PLUGIN_MODULES) {
    it(`${plugin}: every relative import resolves into its own subtree, the host-API barrel, or src/shared`, () => {
      const moduleDir = path.join(modulesRoot, plugin);
      const files = listSourceFiles(moduleDir);
      expect(files.length).toBeGreaterThan(0);

      const violations: string[] = [];
      for (const file of files) {
        for (const specifier of importSpecifiers(fs.readFileSync(file, "utf8"))) {
          if (!specifier.startsWith(".")) continue; // package/node-builtin, not cross-domain
          const resolved = path.resolve(path.dirname(file), specifier);
          const allowed =
            resolved === moduleDir ||
            resolved.startsWith(moduleDir + path.sep) ||
            resolved === hostApiPath ||
            resolved.startsWith(hostApiPath + path.sep) ||
            resolved === sharedPath ||
            resolved.startsWith(sharedPath + path.sep);
          if (!allowed) {
            violations.push(`${path.relative(repoRoot, file)} -> "${specifier}"`);
          }
        }
      }
      expect(violations).toEqual([]);
    });
  }
});
