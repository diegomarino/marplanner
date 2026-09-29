/** Shared DB seeding helpers for the daily-briefing scheduler
 * integration suites — mirrors the seeding style already used in
 * `tests/boundary/daily-briefing-generate.test.ts`, factored out so the job
 * predicate tests and the scheduled/catch-up integration tests don't each
 * duplicate the same raw SQL.
 */
import { getDb } from "../../src/server/db/client";

/** Seed a member row (+ optionally its daily-briefing opt-in row). Defaults
 * to an active, opted-in member.
 */
export function seedMember(id: string, opts: { active?: boolean; optedIn?: boolean } = {}): void {
  const { active = true, optedIn = true } = opts;
  const now = Date.now();
  const db = getDb();
  db.prepare(
    "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, 'child', ?, ?, ?)"
  ).run(id, id, active ? "active" : "archived", now, now);
  if (optedIn) {
    db.prepare(
      "INSERT INTO daily_briefing_optin (member_id, enabled, created_at, updated_at) VALUES (?, 1, ?, ?)"
    ).run(id, now, now);
  }
}

/** Seed a pre-existing `daily_briefing` row (simulating a prior generation —
 * manual or a previous scheduled fire). Returns the seeded row's id so a
 * test can assert it stays stable across a later upsert.
 */
export function seedBriefingRow(memberId: string, date: string): string {
  const id = `pre-${memberId}-${date}`;
  const now = Date.now();
  getDb()
    .prepare(
      "INSERT INTO daily_briefing (id, member_id, date, status, payload, created_at, updated_at) VALUES (?, ?, ?, 'ready', '{}', ?, ?)"
    )
    .run(id, memberId, date, now, now);
  return id;
}

/** Look up a member's `daily_briefing` row for a date, if any. */
export function findBriefingRow(memberId: string, date: string): { id: string } | undefined {
  return getDb()
    .prepare("SELECT id FROM daily_briefing WHERE member_id = ? AND date = ?")
    .get(memberId, date) as { id: string } | undefined;
}

/** Count a member's `daily_briefing` rows for a date (0 or 1 — unique constraint). */
export function countBriefingRows(memberId: string, date: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS count FROM daily_briefing WHERE member_id = ? AND date = ?")
    .get(memberId, date) as { count: number };
  return row.count;
}

/** Seed the `daily-briefing` settings object's `generationTime` field
 * (seam, `getBriefingTime` in `src/server/modules/
 * daily-briefing/job.ts`) — lets a test drive `registerDailyBriefingJob`'s * real wall-clock time through the same settings-object path production
 * uses, instead of overriding the trigger by hand.
 */
export function seedBriefingTime(generationTime: string): void {
  getDb()
    .prepare(
      "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('daily-briefing', ?, ?)"
    )
    .run(JSON.stringify({ generationTime }), Date.now());
}
