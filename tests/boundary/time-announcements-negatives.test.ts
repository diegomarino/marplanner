import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";
import { ALL_SCHEMA_TABLES } from "../helpers/schema-tables";

/** — negative proofs (SC-006, FR-001/FR-013):
 * 1. TIME-ANNOUNCEMENTS-AC-08/INV-10 — no settings surface of ANY kind exists for this
 * domain: `app.hasRoute` absence checks (NOT HTTP-through-the-gate — a non-`/api` path
 * returns the gate form regardless of registration, per the repo's route-absence lesson)
 * for every settings/quiet-hours/volume/master-switch shape, plus a positive control
 * proving the ONLY four routes this domain owns ARE registered.
 * 2. Schema sweep — no `settings_objects` row references announcements (with a REAL `locale`
 * row inserted as a positive control, since the row-level check is vacuous over an empty
 * table — 2026-09-04), a STRUCTURAL sweep of `src/server` + `src/shared` for
 * any `objectName`/`object_name` literal shaped like an announcement name, and the LIVE
 * `sqlite_master` table set is exactly `ALL_SCHEMA_TABLES` (single source of truth shared
 * with `tests/integration/scheduler-lifecycle.test.ts`): no announcement-related table
 * beyond `time_announcements` itself — no queue, no claim, no staleness-sweep table.
 * 3. TIME-ANNOUNCEMENTS-INV-10/AC-08 — zero rows at fresh boot (no legacy v1 import; the 7
 * v1 rows cites are evidence only).
 * 4. TIME-ANNOUNCEMENTS-INV-06 (server half) — no server-side firing artifacts: the
 * entrypoint's job list (`src/server/index.ts`, the daily-briefing/telemetry/backups
 * `registerJob` precedent) contains NO announcements job (structural source check, the
 * `scheduler-lifecycle.test.ts` precedent), and unlike those three domains — each of which
 * exposes its own `job.ts` registration file — the time-announcements module has none.
 * (Traces: TIME-ANNOUNCEMENTS-INV-06 — server half, TIME-ANNOUNCEMENTS-INV-10,
 * TIME-ANNOUNCEMENTS-AC-08)
 */
describe("time-announcements negative proofs (T011)", () => {
  useIsolatedDb();

  describe("1. TIME-ANNOUNCEMENTS-AC-08/INV-10: no settings surface of any kind", () => {
    const NEGATIVE_ROUTES = [
      { method: "GET", url: "/api/time-announcements/settings" },
      { method: "POST", url: "/api/time-announcements/settings" },
      { method: "GET", url: "/api/settings/time-announcements" },
      { method: "PUT", url: "/api/settings/time-announcements" },
      { method: "GET", url: "/api/time-announcements/quiet-hours" },
      { method: "POST", url: "/api/time-announcements/quiet-hours" },
      { method: "GET", url: "/api/time-announcements/volume" },
      { method: "PUT", url: "/api/time-announcements/volume" },
      { method: "GET", url: "/api/time-announcements/rate" },
      { method: "GET", url: "/api/time-announcements/pitch" },
      { method: "GET", url: "/api/time-announcements/voice" },
      { method: "GET", url: "/api/time-announcements/master-switch" },
      { method: "PUT", url: "/api/time-announcements/master-switch" },
      { method: "GET", url: "/api/time-announcements/enabled" },
      { method: "PUT", url: "/api/time-announcements/enabled" },
      { method: "GET", url: "/api/time-announcements/devices" },
    ] as const;

    for (const { method, url } of NEGATIVE_ROUTES) {
      it(`${method} ${url} is NOT registered`, async () => {
        const { buildApp } = await import("../../src/server/app.ts");
        const app = await buildApp();
        try {
          expect(app.hasRoute({ method, url })).toBe(false);
        } finally {
          await app.close();
        }
      });
    }

    it("positive control: the domain's route inventory is EXACTLY the four rule-CRUD routes", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const app = await buildApp();
      try {
        expect(app.hasRoute({ method: "GET", url: "/api/time-announcements" })).toBe(true);
        expect(app.hasRoute({ method: "POST", url: "/api/time-announcements" })).toBe(true);
        expect(app.hasRoute({ method: "PATCH", url: "/api/time-announcements/:id" })).toBe(true);
        expect(app.hasRoute({ method: "DELETE", url: "/api/time-announcements/:id" })).toBe(true);
      } finally {
        await app.close();
      }
    });
  });

  describe("2. schema sweep: no settings_objects row, no announcement table beyond time_announcements", () => {
    it("no settings_objects row references announcements (positive control: a REAL locale row is present)", () => {
      const db = getDb();
      // (2026-09-04): a fresh `useIsolatedDb` instance has ZERO settings_objects
      // rows, so `settingsRows.some(...)` over an empty array is vacuously false — it would
      // pass even if the /announce/i predicate itself were broken. Insert a real row first so
      // this assertion is proven against actual row content, not an empty table.
      db.prepare(
        "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('locale', '{}', ?)"
      ).run(Date.now());

      const settingsRows = db.prepare("SELECT object_name FROM settings_objects").all() as Array<{
        object_name: string;
      }>;
      expect(settingsRows.length).toBeGreaterThan(0); // the positive control landed
      expect(settingsRows.some((r) => /announce/i.test(r.object_name))).toBe(false);
    });

    it("STRUCTURAL: no objectName/object_name literal under src/server or src/shared is announcement-shaped", () => {
      // Complements the row-level check above: that check only proves TODAY's live rows are
      // clean, not that the CODE could never write an announcement-shaped settings object
      // name. This sweeps every `.ts`/`.tsx` file under the two source roots that could ever
      // touch `settings_objects` for a string literal immediately following an
      // `objectName`/`object_name` token (covers both the Drizzle column reference form —
      // `eq(settingsObjects.objectName, "locale")` — and the schema's own column definition).
      function collectTsFiles(dir: string, acc: string[] = []): string[] {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          const stat = statSync(full);
          if (stat.isDirectory()) {
            collectTsFiles(full, acc);
          } else if (stat.isFile() && /\.(ts|tsx)$/.test(entry)) {
            acc.push(full);
          }
        }
        return acc;
      }

      const roots = [join(__dirname, "../../src/server"), join(__dirname, "../../src/shared")];
      const files = roots.flatMap((root) => collectTsFiles(root));
      const LITERAL_NEAR_OBJECT_NAME = /object_?[Nn]ame\W{0,10}["'`]([^"'`]+)["'`]/g;

      const offenders: Array<{ file: string; value: string }> = [];
      for (const file of files) {
        const text = readFileSync(file, "utf8");
        for (const match of text.matchAll(LITERAL_NEAR_OBJECT_NAME)) {
          if (/announce/i.test(match[1])) {
            offenders.push({ file, value: match[1] });
          }
        }
      }
      expect(offenders).toEqual([]);
    });

    it("the live sqlite_master table set is EXACTLY ALL_SCHEMA_TABLES — no extra announcement queue/claim table", () => {
      const db = getDb();
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const liveNames = rows.map((r) => r.name).sort();
      expect(liveNames).toEqual([...ALL_SCHEMA_TABLES].sort());
    });

    it("no table other than time_announcements mentions 'announce' anywhere in its name", () => {
      const db = getDb();
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      const offenders = rows
        .map((r) => r.name)
        .filter((name) => name !== "time_announcements" && /announce/i.test(name));
      expect(offenders).toEqual([]);
    });
  });

  describe("3. TIME-ANNOUNCEMENTS-INV-10/AC-08: zero rows at fresh boot (no legacy v1 import)", () => {
    it("zero time_announcements rows exist in a freshly-migrated database", () => {
      const db = getDb();
      const row = db.prepare("SELECT COUNT(*) as n FROM time_announcements").get() as {
        n: number;
      };
      expect(row.n).toBe(0);
    });

    it("no source file under src/ imports a legacy v1 announcement-import path", () => {
      function collectFiles(dir: string, acc: string[] = []): string[] {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          const stat = statSync(full);
          if (stat.isDirectory()) {
            collectFiles(full, acc);
          } else {
            acc.push(full);
          }
        }
        return acc;
      }

      const srcRoot = join(__dirname, "../../src");
      const files = collectFiles(srcRoot).filter((f) => /\.(ts|tsx)$/.test(f));
      const legacyMarkers = [
        /migrateV1(TimeAnnouncement|Announcement)/,
        /importLegacy(TimeAnnouncement|Announcement)/,
        /import.*legacy.*announcement/i,
      ];

      const offenders: string[] = [];
      for (const file of files) {
        const text = readFileSync(file, "utf8");
        if (legacyMarkers.some((marker) => marker.test(text))) {
          offenders.push(file);
        }
      }
      expect(offenders).toEqual([]);
    });
  });

  describe("4. TIME-ANNOUNCEMENTS-INV-06 (server half): no server-side firing artifacts", () => {
    it("the entrypoint source has NO mention of time-announcements at all — no job wired (structural)", () => {
      const source = readFileSync(join(__dirname, "../../src/server/index.ts"), "utf8");
      expect(source).not.toMatch(/time-announcements/i);
      expect(source).not.toMatch(/timeAnnouncements/);
      expect(source).not.toMatch(/announcements/i);
    });

    it("the time-announcements module directory has NO job-registration file (unlike daily-briefing/telemetry/backups) and no module file mentions the scheduler", () => {
      const moduleDir = join(__dirname, "../../src/server/modules/time-announcements");
      // (2026-09-04): filter to plain `.ts` FILES only — an unfiltered
      // `readdirSync` result would include any subdirectory entry too, and the
      // `readFileSync` below throws (EISDIR) the moment one exists, rather than proving
      // anything about its contents.
      const files = readdirSync(moduleDir).filter(
        (entry) => statSync(join(moduleDir, entry)).isFile() && entry.endsWith(".ts")
      );
      expect(files).not.toContain("job.ts");
      expect(files.length).toBeGreaterThan(0); // sanity: the filter didn't eat everything

      for (const file of files) {
        const text = readFileSync(join(moduleDir, file), "utf8");
        expect(text).not.toMatch(/registerJob/);
        expect(text).not.toMatch(/scheduler/i);
      }
    });

    it("no queue/claim/staleness table exists for time-announcements", () => {
      const db = getDb();
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      const names = rows.map((r) => r.name);
      expect(names).not.toContain("time_announcements_queue");
      expect(names).not.toContain("time_announcements_claims");
      expect(names).not.toContain("time_announcements_staleness");
      expect(names).not.toContain("announcement_queue");
      expect(names).not.toContain("announcement_claims");
    });
  });
});
