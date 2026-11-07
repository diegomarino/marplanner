import fs from "node:fs";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { getDb, resetDb } from "../../src/server/db/client";
import { runMigrations } from "../../src/server/db/migrate";
import { BASELINE_FILE, BASELINE_PATH } from "../helpers/baseline";
import { useIsolatedDb } from "../helpers/db";

/** `0001_reminder_content.sql` (#96) upgrades a household that already ran the baseline: the real
 * runner rebuilds `reminder` with the content columns and CHECK, keeps every rule as a `text`
 * rule and keeps every `reminder_assignment` row (the rebuild drops the parent table, which must
 * not cascade). */
describe("0001_reminder_content migration on an existing household", () => {
  useIsolatedDb();

  it("adds text/images content to existing rules without losing rules or assignments", () => {
    const dataDirectory = mkdtempSync(path.join(tmpdir(), "mp-reminder-content-"));
    const baselineOnly = mkdtempSync(path.join(tmpdir(), "mp-baseline-only-"));
    const previousDataDirectory = process.env.DATA_DIR;
    try {
      process.env.DATA_DIR = dataDirectory;
      resetDb();
      fs.copyFileSync(BASELINE_PATH, path.join(baselineOnly, BASELINE_FILE));
      runMigrations(baselineOnly);

      const db = getDb();
      db.prepare(
        `INSERT INTO reminder (id, kind, targeting_mode, text, weekdays, active, created_at, updated_at)
         VALUES ('r-specific', 'scheduled', 'specific', 'Pack the bag', NULL, 1, 1, 1),
                ('r-all', 'scheduled', 'apply_to_all', 'Trash day', '["tue"]', 0, 2, 2)`
      ).run();
      db.prepare(
        `INSERT INTO reminder_assignment (id, reminder_id, member_id, weekdays, active, created_at, updated_at)
         VALUES ('a-1', 'r-specific', 'm-1', '["mon","wed"]', 1, 1, 1)`
      ).run();

      runMigrations();

      expect(
        db.prepare("SELECT fileName FROM drizzle_universe_migrations ORDER BY fileName").all()
      ).toEqual([{ fileName: BASELINE_FILE }, { fileName: "0001_reminder_content.sql" }]);
      expect(
        db
          .prepare(
            "SELECT id, text, content_type, emojis, weekdays, active FROM reminder ORDER BY id"
          )
          .all()
      ).toEqual([
        {
          id: "r-all",
          text: "Trash day",
          content_type: "text",
          emojis: null,
          weekdays: '["tue"]',
          active: 0,
        },
        {
          id: "r-specific",
          text: "Pack the bag",
          content_type: "text",
          emojis: null,
          weekdays: null,
          active: 1,
        },
      ]);
      expect(db.prepare("SELECT id, reminder_id FROM reminder_assignment").all()).toEqual([
        { id: "a-1", reminder_id: "r-specific" },
      ]);
      expect(db.pragma("foreign_key_check")).toEqual([]);

      // The rebuilt table enforces the new CHECK and still cascades deletes to assignments.
      expect(() =>
        db
          .prepare(
            "INSERT INTO reminder (id, kind, targeting_mode, content_type, text, emojis, weekdays, active, created_at, updated_at) VALUES ('bad', 'scheduled', 'apply_to_all', 'images', '', NULL, '[\"mon\"]', 1, 3, 3)"
          )
          .run()
      ).toThrow(/CHECK constraint failed/);
      db.prepare("DELETE FROM reminder WHERE id = 'r-specific'").run();
      expect(db.prepare("SELECT COUNT(*) AS n FROM reminder_assignment").get()).toEqual({ n: 0 });
    } finally {
      resetDb();
      process.env.DATA_DIR = previousDataDirectory;
      rmSync(dataDirectory, { recursive: true, force: true });
      rmSync(baselineOnly, { recursive: true, force: true });
    }
  });
});
