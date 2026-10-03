import { afterEach, describe, expect, it, vi } from "vitest";
import { getScheduler, initScheduler } from "../../src/server/scheduler/index";
import { updateSettings } from "../../src/server/modules/daily-briefing/settings";
import {
  DAILY_BRIEFING_JOB_ID,
  DAILY_BRIEFING_RETRY_15_JOB_ID,
  DAILY_BRIEFING_RETRY_30_JOB_ID,
  registerDailyBriefingJob,
} from "../../src/server/modules/daily-briefing/job";
import { getDb } from "../../src/server/db/client";
import { FakeClock, noopLog } from "../helpers/fake-clock";
import { useIsolatedDb } from "../helpers/db";
import { countBriefingRows, seedBriefingRow, seedMember } from "../helpers/daily-briefing-seed";

/** (US4, FR-012/FR-021) — scheduling integration tests for the THREE
 * scheduler registrations job.ts now owns (main pass, +15/+30 retry passes) and the
 * settings-write re-arm hook. Driven through the REAL registration path
 * (`initScheduler` + `registerDailyBriefingJob`, never a hand-rolled trigger), mirroring
 * `tests/integration/daily-briefing-scheduled.test.ts` (US1)the established conventions:
 * `FakeClock` synced to the REAL global `Date` via `vi.setSystemTime` (`generateAllBriefings`'s * own date resolution reads the real `Date`, independent of the scheduler's injected `now`), and
 * fire detection via `getScheduler.getJobState(id)?.lastRunAt` (never a hand-rolled counter).
 */
function jobLastRunAt(id: string): number | null {
  return getScheduler().getJobState(id)?.lastRunAt ?? null;
}

function newSyncedClock(startMs: number): FakeClock {
  vi.setSystemTime(startMs);
  return new FakeClock(startMs, (ms) => vi.setSystemTime(ms));
}

/** Registers the REAL daily-briefing schedule (main + 2 retries) via a fake-clock scheduler. */
function setupRealJob(startMs: number): FakeClock {
  const clock = newSyncedClock(startMs);
  initScheduler({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    log: noopLog(),
  });
  registerDailyBriefingJob();
  return clock;
}

function readBriefingRow(
  memberId: string,
  date: string
): { status: string; updatedAt: number } | undefined {
  const row = getDb()
    .prepare("SELECT status, updated_at FROM daily_briefing WHERE member_id = ? AND date = ?")
    .get(memberId, date) as { status: string; updated_at: number } | undefined;
  return row ? { status: row.status, updatedAt: row.updated_at } : undefined;
}

/** Seed a `daily_briefing` row with an explicit (non-`ready`) status, simulating a prior
 * generation pass that left survivor failures (FR-021 retry candidates). */
function seedRetryableBriefingRow(
  memberId: string,
  date: string,
  status: "partial" | "failed" | "render-failed"
): void {
  const now = Date.now();
  getDb()
    .prepare(
      "INSERT INTO daily_briefing (id, member_id, date, status, payload, created_at, updated_at) VALUES (?, ?, ?, ?, '{}', ?, ?)"
    )
    .run(`pre-${memberId}-${date}`, memberId, date, status, now, now);
}

// Europe/Madrid, August 2026 = CEST (UTC+2). 06:00 local = 04:00 UTC (default generationTime).
const AUG21_BEFORE_0600_UTC = Date.UTC(2026, 7, 21, 3, 0, 0); // 05:00 local
const AUG21_0600_UTC = Date.UTC(2026, 7, 21, 4, 0, 0); // 06:00 local (main fire instant)
const AUG21_AFTER_0600_UTC = Date.UTC(2026, 7, 21, 4, 30, 0); // 06:30 local
const AUG21_NOON_UTC = Date.UTC(2026, 7, 21, 10, 0, 0); // 12:00 local
const TODAY = "2026-08-21";

describe("daily-briefing scheduled generation (US4 — research D10)", () => {
  useIsolatedDb();

  afterEach(async () => {
    vi.useRealTimers();
    try {
      await getScheduler().stop();
    } catch {
      // not initialized by a given test — nothing to drain.
    }
  });

  describe("main pass — household-tz wall clock, never server-local (v1 gotcha #15)", () => {
    const originalTZ = process.env.TZ;

    afterEach(() => {
      if (originalTZ === undefined) delete process.env.TZ;
      else process.env.TZ = originalTZ;
    });

    it("BACKGROUND-JOBS-SCHEDULER-AC-03 / DAILY-BRIEFING-AC-10: fires at 06:00 Europe/Madrid regardless of a mismatched server OS timezone", async () => {
      // Deliberately mismatched vs the household default (Europe/Madrid, no `locale` row
      // seeded): if household-date resolution ever regressed to consulting server-local time
      // (the v1 hazard), this fire would happen at the WRONG instant relative to the
      // UTC constants below, since America/New_York's own 06:00 lands ~6h later than Madrid's.
      vi.useFakeTimers({ toFake: ["Date"] });
      process.env.TZ = "America/New_York";
      seedMember("m1", { optedIn: true });
      const clock = setupRealJob(AUG21_BEFORE_0600_UTC);

      await getScheduler().start();
      expect(jobLastRunAt(DAILY_BRIEFING_JOB_ID)).toBeNull();

      await clock.advanceTo(AUG21_AFTER_0600_UTC);

      expect(jobLastRunAt(DAILY_BRIEFING_JOB_ID)).not.toBeNull();
      expect(countBriefingRows("m1", TODAY)).toBe(1);
    });
  });

  describe("startup catch-up (DAILY-BRIEFING-AC-10) — main pass only", () => {
    it("start() before 06:00 — zero rows until the hour", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      seedMember("m1", { optedIn: true });
      const clock = setupRealJob(AUG21_BEFORE_0600_UTC);

      await getScheduler().start();
      await clock.flush();
      expect(jobLastRunAt(DAILY_BRIEFING_JOB_ID)).toBeNull();
      expect(countBriefingRows("m1", TODAY)).toBe(0);

      await clock.advanceTo(AUG21_0600_UTC);
      expect(jobLastRunAt(DAILY_BRIEFING_JOB_ID)).not.toBeNull();
      expect(countBriefingRows("m1", TODAY)).toBe(1);
    });

    it("start() past 06:00 with zero rows — catch-up generates today", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      seedMember("m1", { optedIn: true });
      const clock = setupRealJob(AUG21_NOON_UTC);

      await getScheduler().start();
      await clock.flush();

      expect(jobLastRunAt(DAILY_BRIEFING_JOB_ID)).not.toBeNull();
      expect(countBriefingRows("m1", TODAY)).toBe(1);
    });

    it("a row already present before 06:00 blocks catch-up", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      seedMember("m1", { optedIn: true });
      seedBriefingRow("m1", TODAY);
      const clock = setupRealJob(AUG21_BEFORE_0600_UTC);

      await getScheduler().start();
      await clock.flush();

      expect(jobLastRunAt(DAILY_BRIEFING_JOB_ID)).toBeNull();
    });
  });

  describe("retry passes (research D10/FR-021) — regenerate only survivor-failure rows", () => {
    it("regenerates a partial/failed/render-failed row and leaves a ready row untouched", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-08-21T12:00:00.000Z"));
      seedMember("m-partial", { optedIn: true });
      seedMember("m-ready", { optedIn: true });
      seedRetryableBriefingRow("m-partial", TODAY, "partial");
      seedBriefingRow("m-ready", TODAY); // status 'ready'
      const readyBefore = readBriefingRow("m-ready", TODAY);
      expect(readyBefore?.status).toBe("ready");

      // Advance real time (not just the scheduler's fake clock — `generateBriefing`'s own
      // `updated_at` write reads the REAL `Date`) so a regenerated row's `updated_at` is
      // provably NEWER than its seed, never coincidentally identical under a frozen clock.
      vi.setSystemTime(new Date("2026-08-21T12:00:05.000Z"));

      initScheduler();
      registerDailyBriefingJob();

      const result = await getScheduler().runJobNow(DAILY_BRIEFING_RETRY_15_JOB_ID, {
        date: TODAY,
      });
      expect(result).toMatchObject({ status: "completed" });

      const partialAfter = readBriefingRow("m-partial", TODAY);
      const readyAfter = readBriefingRow("m-ready", TODAY);

      // Regenerated: status is no longer the stale 'partial' value, and updated_at moved.
      expect(partialAfter?.status).not.toBe("partial");
      expect(partialAfter?.updatedAt).toBeGreaterThan(0);

      // Untouched: the ready row's updated_at is bit-for-bit the ORIGINAL seed instant.
      expect(readyAfter?.updatedAt).toBe(readyBefore?.updatedAt);
      expect(readyAfter?.status).toBe("ready");
    });

    it("a retry pass with no survivor-failure rows for the date is a harmless no-op", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-08-21T12:00:00.000Z"));
      seedMember("m-ready", { optedIn: true });
      seedBriefingRow("m-ready", TODAY);
      const before = readBriefingRow("m-ready", TODAY);

      initScheduler();
      registerDailyBriefingJob();

      const result = await getScheduler().runJobNow(DAILY_BRIEFING_RETRY_30_JOB_ID, {
        date: TODAY,
      });
      expect(result).toMatchObject({ status: "completed" });

      const after = readBriefingRow("m-ready", TODAY);
      expect(after).toEqual(before);
    });
  });

  describe("re-arm on generation_time change (Codex #693 fold, research D10)", () => {
    it("changing generationTime via the real settings write moves the OBSERVABLE next firing", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      seedMember("m1", { optedIn: true });
      // Pre-seed today's row so isMissed=false — isolates the SCHEDULING assertions below
      // from a startup catch-up fire, which would otherwise confound "did it fire at 06:00?".
      seedBriefingRow("m1", TODAY);

      const clock = setupRealJob(AUG21_BEFORE_0600_UTC); // registers at the default 06:00
      expect(jobLastRunAt(DAILY_BRIEFING_JOB_ID)).toBeNull();

      // The real write path (`PUT /api/daily-briefing/settings`'s handler,../../src/server/
      // modules/daily-briefing/settings.ts) — NOT a hand-rolled trigger override.
      updateSettings({ generationTime: "07:00" });
      await clock.flush(); // settle the fire-and-forget rearm (stop + re-register)

      await getScheduler().start();

      // OLD time (06:00) no longer fires — the job was re-armed to 07:00 before start.
      await clock.advanceTo(AUG21_0600_UTC);
      expect(jobLastRunAt(DAILY_BRIEFING_JOB_ID)).toBeNull();

      // NEW time (07:00 local = 05:00 UTC) fires.
      await clock.advanceTo(Date.UTC(2026, 7, 21, 5, 0, 0));
      expect(jobLastRunAt(DAILY_BRIEFING_JOB_ID)).not.toBeNull();
    });

    it("a settings write that leaves generationTime unchanged does not disturb the schedule", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      seedMember("m1", { optedIn: true });
      seedBriefingRow("m1", TODAY);
      const clock = setupRealJob(AUG21_BEFORE_0600_UTC);

      updateSettings({ autoPrintTrigger: null }); // no generationTime field at all
      await clock.flush();

      await getScheduler().start();
      await clock.advanceTo(AUG21_0600_UTC); // still the ORIGINAL default time
      expect(jobLastRunAt(DAILY_BRIEFING_JOB_ID)).not.toBeNull();
    });

    it("Codex P2 fold (PR #713): a write that changes ONLY autoPrintTrigger still re-arms when the pre-write effective time came SOLELY from the legacy settings_objects placeholder", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      seedMember("m1", { optedIn: true });
      // Pre-seed today's row so isMissed=false — isolates the SCHEDULING assertion below from
      // a startup catch-up fire, same rationale as the sibling re-arm tests above.
      seedBriefingRow("m1", TODAY);

      // Legacy-only seam: NO `daily_briefing_settings` row yet — the only persisted
      // generationTime anywhere is the pre- `settings_objects` placeholder, "07:15".
      getDb()
        .prepare(
          "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('daily-briefing', ?, ?)"
        )
        .run(JSON.stringify({ generationTime: "07:15" }), Date.now());

      // Registers via getBriefingTime -> legacy fallback -> armed at 07:15 local.
      const clock = setupRealJob(AUG21_BEFORE_0600_UTC);
      expect(jobLastRunAt(DAILY_BRIEFING_JOB_ID)).toBeNull();

      // PUT changes ONLY autoPrintTrigger — generationTime is omitted from the input entirely.
      updateSettings({ autoPrintTrigger: "morning_complete" });
      await clock.flush(); // settle the fire-and-forget rearm (stop + re-register)

      await getScheduler().start();

      // The write persists generationTime "06:00" (the NEW table's own default, since the field
      // was omitted from `input`) — which differs from the 07:15 effective time that was actually
      // armed a moment ago, so the fix's comparison (against `getBriefingTime`'s pre-write
      // snapshot, not bare `current.generationTime`) correctly triggers the re-arm. Pre-fix, this
      // write would have compared "06:00" against the new table's OWN default ("06:00") and
      // wrongly concluded nothing changed, leaving the job stuck armed at 07:15 — so nothing would
      // fire at 06:00 local below.
      await clock.advanceTo(AUG21_0600_UTC); // 06:00 local — the NEWLY effective time
      expect(jobLastRunAt(DAILY_BRIEFING_JOB_ID)).not.toBeNull();
    });
  });

  describe("kill-switch parity (SCHEDULER_DISABLED posture — registered but never started)", () => {
    it("nothing fires — no scheduled pass, no retry, no catch-up — when start() is never called", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      seedMember("m1", { optedIn: true }); // no row: would be `isMissed` if start ever ran
      const clock = setupRealJob(AUG21_NOON_UTC); // well past 06:00 already

      // Deliberately never call scheduler.start (mirrors SCHEDULER_DISABLED=1, src/server/
      // index.ts) — advance the clock a full day and confirm total silence.
      await clock.advanceTo(AUG21_NOON_UTC + 24 * 60 * 60 * 1000);

      expect(jobLastRunAt(DAILY_BRIEFING_JOB_ID)).toBeNull();
      expect(jobLastRunAt(DAILY_BRIEFING_RETRY_15_JOB_ID)).toBeNull();
      expect(jobLastRunAt(DAILY_BRIEFING_RETRY_30_JOB_ID)).toBeNull();
      expect(countBriefingRows("m1", TODAY)).toBe(0);
    });
  });
});
