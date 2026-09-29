import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../src/server/db/client";
import { getScheduler, initScheduler } from "../../src/server/scheduler/index";
import {
  DAILY_BRIEFING_JOB_ID,
  getBriefingTime,
  isMissed,
  registerDailyBriefingJob,
} from "../../src/server/modules/daily-briefing/job";
import { useIsolatedDb } from "../helpers/db";
import { seedBriefingRow, seedMember } from "../helpers/daily-briefing-seed";

/** — unit tests for the daily-briefing job registration module
 * (`src/server/modules/daily-briefing/job.ts`). Covers the
 * `isMissed` predicate truth table, the `getBriefingTime` settings seam, and
 * the manual-invocation argument pass-through through the real scheduler
 * singleton (no timers armed — `registerJob` only arms once `start` has
 * run, so `runJobNow` here never touches a real timer).
 */
describe("daily-briefing job registration (T005 — research D8/D9)", () => {
  useIsolatedDb();
  const date = "2026-08-21";
  const yesterday = "2026-08-20";

  describe("isMissed predicate truth table (Codex review F1: per-member, never COUNT(*)==0)", () => {
    it("DAILY-BRIEFING-AC-10: no daily_briefing row for an opted-in active member — missed", () => {
      seedMember("m1");
      expect(isMissed(date)).toBe(true);
    });

    it("every opted-in active member already has a row for the date — not missed", () => {
      seedMember("m1");
      seedBriefingRow("m1", date);
      expect(isMissed(date)).toBe(false);
    });

    it("PARTIAL: one opted-in member generated, another missing — still missed", () => {
      seedMember("m1");
      seedMember("m2");
      seedBriefingRow("m1", date);
      // A naive COUNT(*)==0 predicate would already read false here (one row
      // exists) and strand m2 for the rest of the day — the per-member scan
      // must still report missed.
      expect(isMissed(date)).toBe(true);
    });

    it("an opted-out member with no row is excluded from the predicate", () => {
      seedMember("m1", { optedIn: false });
      expect(isMissed(date)).toBe(false);
    });

    it("an archived member (still opted in, no row) is excluded from the predicate", () => {
      seedMember("m1", { active: false });
      expect(isMissed(date)).toBe(false);
    });

    it("an archived member's stale row for a DIFFERENT date does not mask a currently-missing opted-in member", () => {
      seedMember("m1"); // active, opted-in, no row for `date`
      seedMember("m2", { active: false });
      seedBriefingRow("m2", yesterday);
      expect(isMissed(date)).toBe(true);
    });
  });

  describe("getBriefingTime seam (research D9)", () => {
    it("defaults to 06:00 when no daily-briefing settings object exists", () => {
      expect(getBriefingTime()).toBe("06:00");
    });

    it("reads the persisted generationTime when a daily-briefing settings object exists", () => {
      getDb()
        .prepare(
          "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('daily-briefing', ?, ?)"
        )
        .run(JSON.stringify({ generationTime: "07:15" }), Date.now());
      expect(getBriefingTime()).toBe("07:15");
    });

    it("falls back to the default when the settings object exists but has no generationTime field", () => {
      getDb()
        .prepare(
          "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('daily-briefing', ?, ?)"
        )
        .run(JSON.stringify({ unrelatedField: true }), Date.now());
      expect(getBriefingTime()).toBe("06:00");
    });

    it("falls back to the default on malformed data — invalid JSON, wrong type, and an out-of-shape HH:MM never brick the seam", () => {
      getDb()
        .prepare(
          "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('daily-briefing', ?, ?)"
        )
        .run("{not valid json", Date.now());
      expect(getBriefingTime()).toBe("06:00");
    });

    it.each([
      { generationTime: 630 }, // wrong type (number, not "HH:MM" string)
      { generationTime: "6:00" }, // not zero-padded
      { generationTime: "25:00" }, // out-of-range hour
      { generationTime: "06:60" }, // out-of-range minute
      { generationTime: "not-a-time" },
    ])(
      "falls back to the default for a malformed generationTime value: %j",
      ({ generationTime }) => {
        getDb()
          .prepare(
            "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('daily-briefing', ?, ?)"
          )
          .run(JSON.stringify({ generationTime }), Date.now());
        expect(getBriefingTime()).toBe("06:00");
      }
    );

    it("T011 Codex P2 fold (PR #713): when BOTH the new table and the legacy settings_objects row exist, the new table wins", () => {
      getDb()
        .prepare(
          "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('daily-briefing', ?, ?)"
        )
        .run(JSON.stringify({ generationTime: "07:15" }), Date.now());
      getDb()
        .prepare(
          "INSERT INTO daily_briefing_settings (id, generation_time, auto_print_trigger, updated_at) VALUES (1, ?, NULL, ?)"
        )
        .run("08:30", Date.now());

      expect(getBriefingTime()).toBe("08:30");
    });
  });

  describe("registerDailyBriefingJob + action arg pass-through", () => {
    afterEach(async () => {
      try {
        await getScheduler().stop();
      } catch {
        // not initialized by a given test — nothing to drain
      }
      vi.useRealTimers();
    });

    it("DAILY-BRIEFING-AC-10: a manual run with { date } generates only for that explicit date", async () => {
      seedMember("m1");
      initScheduler();
      registerDailyBriefingJob();

      const result = await getScheduler().runJobNow(DAILY_BRIEFING_JOB_ID, { date });

      expect(result).toMatchObject({ status: "completed" });
      const row = getDb().prepare("SELECT date FROM daily_briefing WHERE member_id = ?").get("m1");
      expect(row).toEqual({ date });
    });

    it("a manual run with no invocation arg resolves today via the household timezone default", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-08-21T12:00:00.000Z")); // well inside the Madrid business day
      seedMember("m1");
      initScheduler();
      registerDailyBriefingJob();

      const result = await getScheduler().runJobNow(DAILY_BRIEFING_JOB_ID);

      expect(result).toMatchObject({ status: "completed" });
      const row = getDb().prepare("SELECT date FROM daily_briefing WHERE member_id = ?").get("m1");
      expect(row).toEqual({ date: "2026-08-21" });
    });

    it("an invocation arg without a date field is ignored the same as no arg (today)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-08-21T12:00:00.000Z"));
      seedMember("m1");
      initScheduler();
      registerDailyBriefingJob();

      const result = await getScheduler().runJobNow(DAILY_BRIEFING_JOB_ID, {});

      expect(result).toMatchObject({ status: "completed" });
      const row = getDb().prepare("SELECT date FROM daily_briefing WHERE member_id = ?").get("m1");
      expect(row).toEqual({ date: "2026-08-21" });
    });
  });
});
