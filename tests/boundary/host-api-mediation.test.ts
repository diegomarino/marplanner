import tsEslint from "typescript-eslint";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { ESLint } from "eslint";
import {
  isActiveMember,
  getEvents,
  readHouseholdTimezone,
  readWeekStartDay,
  getDb,
} from "../../src/server/host-api";
import { useIsolatedDb } from "../helpers/db";

/** docs/features/plugin-system.md — host-API mediation guard
 * (ADR-039 §2b′/Rule B, docs/features/plugin-system.md * FR-002/FR-004/FR-007/FR-008). Proves the docs/features/plugin-system.md
 * / retrofit two ways:
 * 1. The REAL plugin module roots (reminders, daily-messages, meals) — not
 * fixtures — lint clean under the `import-x/no-restricted-paths` zones:
 * 0 violations, now that docs/features/plugin-system.md
 * retrofitted all three onto the barrel.
 * 2. Behavioral smoke: the barrel re-exports still work end-to-end against
 * a seeded isolated DB, so the retrofit changed no behavior.
 */
const repoRoot = path.resolve(__dirname, "../..");

describe("host-api-mediation — plugin roots lint clean (ESLint Node API)", () => {
  it("reminders/daily-messages/meals module roots have 0 import-x/no-restricted-paths violations", async () => {
    const eslint = new ESLint({
      cwd: repoRoot,
      overrideConfig: tsEslint.configs.disableTypeChecked,
    });
    const results = await eslint.lintFiles([
      "src/server/modules/reminders/**/*.{ts,tsx}",
      "src/server/modules/daily-messages/**/*.{ts,tsx}",
      "src/server/modules/meals/**/*.{ts,tsx}",
    ]);

    // Sanity: the glob actually matched the three plugin roots — a broken
    // pattern would silently pass with 0 files linted.
    expect(results.length).toBeGreaterThanOrEqual(3);

    const boundaryViolations = results.flatMap((r) =>
      r.messages.filter((m) => m.ruleId === "import-x/no-restricted-paths")
    );
    expect(boundaryViolations).toHaveLength(0);
  });
});

describe("host-api-mediation — barrel re-exports behavioral smoke (useIsolatedDb)", () => {
  useIsolatedDb();

  function seedMember(lifecycle: "active" | "archived" = "active"): string {
    const db = getDb();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    db.prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, 'child', ?, ?, ?)"
    ).run(id, `Member ${id.slice(0, 6)}`, lifecycle, now, now);
    return id;
  }

  it("isActiveMember: true for an active member, false for an archived one", () => {
    const activeId = seedMember("active");
    const archivedId = seedMember("archived");
    expect(isActiveMember(activeId)).toBe(true);
    expect(isActiveMember(archivedId)).toBe(false);
  });

  it("getEvents: returns [] for an empty range with no thrown error after the clock advances", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (const now of [
        new Date("2026-08-15T12:00:00.000Z"),
        new Date("2027-08-15T12:00:00.000Z"),
      ]) {
        vi.setSystemTime(now);
        const year = now.getUTCFullYear();
        const items = getEvents({
          source: "all",
          range: { from: `${year}-08-01`, to: `${year}-08-31` },
        });
        expect(items).toEqual([]);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("readHouseholdTimezone + readWeekStartDay: read the persisted 'locale' settings object", () => {
    const db = getDb();
    const now = Date.now();
    db.prepare("INSERT INTO settings_objects (object_name, data, updated_at) VALUES (?, ?, ?)").run(
      "locale",
      JSON.stringify({ timezone: "America/New_York", weekStartDay: 0 }),
      now
    );

    expect(readHouseholdTimezone()).toBe("America/New_York");
    expect(readWeekStartDay()).toBe(0);
  });

  it("readHouseholdTimezone + readWeekStartDay: fall back to defaults when unset", () => {
    expect(readHouseholdTimezone()).toBe("Europe/Madrid");
    expect(readWeekStartDay()).toBe(1);
  });

  it("getDb()-via-barrel round-trip on an own plugin table (reminder)", () => {
    const db = getDb();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    db.prepare(
      `INSERT INTO reminder (id, kind, targeting_mode, text, weekdays, active, created_at, updated_at)
       VALUES (?, 'scheduled', 'apply_to_all', ?, ?, 1, ?, ?)`
    ).run(id, "Brush teeth", JSON.stringify(["mon", "wed", "fri"]), now, now);

    const row = db.prepare("SELECT id, text, weekdays FROM reminder WHERE id = ?").get(id) as
      { id: string; text: string; weekdays: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.text).toBe("Brush teeth");
    expect(JSON.parse(row?.weekdays ?? "[]")).toEqual(["mon", "wed", "fri"]);
  });
});
