import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, resetDb } from "../../src/server/db/client";
import { runMigrations } from "../../src/server/db/migrate";
import { ALL_SCHEMA_TABLES } from "../helpers/schema-tables";

const BASELINE_MIGRATION = path.resolve(process.cwd(), "drizzle/0000_current_baseline.sql");
const CALENDAR_MIGRATION = path.resolve(process.cwd(), "drizzle/0001_calendar_feed_sync.sql");

describe("calendar feed synchronization migration", () => {
  let dataDir: string;
  let migrationsDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "calendar-feed-sync-data-"));
    migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), "calendar-feed-sync-sql-"));
    previousDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
    resetDb();

    fs.copyFileSync(BASELINE_MIGRATION, path.join(migrationsDir, "0000_current_baseline.sql"));
    runMigrations(migrationsDir);
  });

  afterEach(() => {
    resetDb();
    process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(migrationsDir, { recursive: true, force: true });
  });

  function migrateCalendarFeedSync(): void {
    expect(fs.existsSync(CALENDAR_MIGRATION), "T002 migration must exist").toBe(true);
    fs.copyFileSync(CALENDAR_MIGRATION, path.join(migrationsDir, "0001_calendar_feed_sync.sql"));
    runMigrations(migrationsDir);
  }

  it("migrates a current-baseline source forward and preserves its configured interval", () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO calendar_external_sources
         (id, name, provider, feed_url, enabled, poll_interval_min, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "source-legacy",
      "Legacy source",
      "ics_generic",
      "https://example.test/feed",
      1,
      30,
      1,
      2
    );

    migrateCalendarFeedSync();

    expect(
      db.prepare("SELECT * FROM calendar_external_sources WHERE id = ?").get("source-legacy")
    ).toEqual({
      id: "source-legacy",
      name: "Legacy source",
      provider: "ics_generic",
      feed_url: "https://example.test/feed",
      enabled: 1,
      poll_interval_min: 30,
      etag: null,
      last_modified: null,
      content_hash: null,
      last_attempt_at: null,
      last_success_at: null,
      last_error_code: null,
      consecutive_failures: 0,
      last_imported_count: 0,
      last_skipped_count: 0,
      created_at: 1,
      updated_at: 2,
    });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("creates the complete STRICT table set with a bounded configurable interval", () => {
    migrateCalendarFeedSync();
    const db = getDb();

    const tableList = db.pragma("table_list") as { name: string; strict: number }[];
    const strictByName = new Map(tableList.map((row) => [row.name, row.strict]));
    expect(strictByName.get("calendar_external_sources")).toBe(1);
    expect(strictByName.get("calendar_external_event_meta")).toBe(1);
    expect(strictByName.get("calendar_highlight_rules")).toBe(1);
    expect(ALL_SCHEMA_TABLES).toContain("calendar_external_event_meta");
    expect(ALL_SCHEMA_TABLES).toContain("calendar_highlight_rules");

    db.prepare(
      `INSERT INTO calendar_external_sources
         (id, name, provider, feed_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("source-default", "Default interval", "google", "https://example.test/default", 1, 1);
    expect(
      db
        .prepare("SELECT poll_interval_min FROM calendar_external_sources WHERE id = ?")
        .get("source-default")
    ).toEqual({ poll_interval_min: 15 });

    db.prepare(
      `INSERT INTO calendar_external_sources
         (id, name, provider, feed_url, poll_interval_min, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("source-custom", "Custom interval", "google", "https://example.test/custom", 30, 1, 1);
    expect(
      db
        .prepare("SELECT poll_interval_min FROM calendar_external_sources WHERE id = ?")
        .get("source-custom")
    ).toEqual({ poll_interval_min: 30 });
    for (const interval of [0, 1441]) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO calendar_external_sources
               (id, name, provider, feed_url, poll_interval_min, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            `source-invalid-${interval}`,
            "Invalid interval",
            "google",
            `https://example.test/invalid-${interval}`,
            interval,
            1,
            1
          )
      ).toThrow(/calendar_external_sources_poll_interval_check/);
    }
    expect(() =>
      db
        .prepare(
          `UPDATE calendar_external_sources
           SET last_error_code = 'private_url'
           WHERE id = 'source-default'`
        )
        .run()
    ).toThrow(/calendar_external_sources_last_error_code_check/);
    expect(() =>
      db
        .prepare(
          `UPDATE calendar_external_sources
           SET consecutive_failures = -1
           WHERE id = 'source-default'`
        )
        .run()
    ).toThrow(/calendar_external_sources_consecutive_failures_check/);
  });

  it("enforces external identity, status, foreign keys, and delete behavior", () => {
    migrateCalendarFeedSync();
    const db = getDb();

    db.prepare(
      `INSERT INTO calendar_external_sources
         (id, name, provider, feed_url, created_at, updated_at)
       VALUES ('source-1', 'Source', 'apple', 'https://example.test/source', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO calendar_events
         (id, source, title, all_day, start_date, end_date, exdates, created_at, updated_at)
       VALUES ('event-1', 'external', 'Imported', 1, '2026-10-01', '2026-10-02', '[]', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO calendar_external_event_meta
         (event_id, source_id, external_uid, recurrence_id, status, raw_hash, created_at, updated_at)
       VALUES ('event-1', 'source-1', 'uid-1', '', 'active', ?, 1, 1)`
    ).run("a".repeat(64));

    expect(() =>
      db
        .prepare(
          `INSERT INTO calendar_external_event_meta
             (event_id, source_id, external_uid, recurrence_id, status, raw_hash, created_at, updated_at)
           VALUES ('missing-event', 'source-1', 'uid-2', '', 'active', ?, 1, 1)`
        )
        .run("b".repeat(64))
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO calendar_external_event_meta
             (event_id, source_id, external_uid, recurrence_id, status, raw_hash, created_at, updated_at)
           VALUES ('event-1', 'source-1', 'uid-1', '', 'active', ?, 1, 1)`
        )
        .run("c".repeat(64))
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      db.prepare("UPDATE calendar_external_event_meta SET status = 'tentative'").run()
    ).toThrow(/calendar_external_event_meta_status_check/);
    expect(() =>
      db.prepare("DELETE FROM calendar_external_sources WHERE id = 'source-1'").run()
    ).toThrow(/FOREIGN KEY constraint failed/);

    db.prepare("DELETE FROM calendar_events WHERE id = 'event-1'").run();
    expect(db.prepare("SELECT * FROM calendar_external_event_meta").all()).toEqual([]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("enforces valid highlight JSON, enabled state, and unique nonnegative priority", () => {
    migrateCalendarFeedSync();
    const db = getDb();
    const insert = db.prepare(
      `INSERT INTO calendar_highlight_rules
         (id, emoji, keywords_json, enabled, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    insert.run("rule-1", "⭐", '["school"]', 1, 0, 1, 1);
    expect(() => insert.run("rule-2", "🎒", '["class"]', 1, 0, 1, 1)).toThrow(
      /UNIQUE constraint failed/
    );
    expect(() => insert.run("rule-3", "🎒", '["class"]', 1, -1, 1, 1)).toThrow(
      /calendar_highlight_rules_priority_check/
    );
    expect(() => insert.run("rule-4", "🎒", "not-json", 1, 1, 1, 1)).toThrow(
      /calendar_highlight_rules_keywords_json_check/
    );
    expect(() => insert.run("rule-5", "🎒", '["class"]', 2, 1, 1, 1)).toThrow(
      /calendar_highlight_rules_enabled_check/
    );
  });
});
