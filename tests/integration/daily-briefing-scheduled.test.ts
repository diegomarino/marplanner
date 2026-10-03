import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getScheduler, initScheduler } from "../../src/server/scheduler/index";
import { readBriefing } from "../../src/server/modules/daily-briefing/index";
import {
  DAILY_BRIEFING_JOB_ID,
  registerDailyBriefingJob,
} from "../../src/server/modules/daily-briefing/job";
import { FakeClock, noopLog } from "../helpers/fake-clock";
import { useIsolatedDb } from "../helpers/db";
import {
  countBriefingRows,
  findBriefingRow,
  seedBriefingRow,
  seedBriefingTime,
  seedMember,
} from "../helpers/daily-briefing-seed";

/** (US1) — scheduled-generation + catch-up integration tests, driven
 * through the REAL registration path: `initScheduler` with the fake
 * clock/timer deps, then the REAL `registerDailyBriefingJob`
 * from `job.ts` (never a hand-rolled trigger) against a real isolated
 * SQLite DB. This exercises job.ts's own `at: getBriefingTime` binding —
 * a hand-rolled registration that computed `getBriefingTime` itself and
 * passed it into a manually-built trigger would never prove
 * `registerDailyBriefingJob` actually wires that seam correctly. DST
 * scenarios drive the wall-clock time via `seedBriefingTime` (a real
 * `daily-briefing` settings row), never a trigger override — the only way
 * to reach a non-default time is the same settings-object path production
 * uses.
 * `generateAllBriefings`'s own date resolution (`resolveBusinessDate`,
 * module `index.ts`) reads the REAL global `Date`, independently of the
 * scheduler's injected `now`/`setTimeout` deps — it has no clock seam of its
 * own (by design; it is a domain function, not the scheduler). So the
 * `FakeClock` here is wired with `vi.useFakeTimers({toFake:["Date"]})` +
 * `vi.setSystemTime` via its `onTick` hook, keeping the REAL `Date` in
 * lockstep with the virtual clock at every tick — otherwise a fired job
 * would write rows dated to whatever the wall-clock actually reads when the
 * test happens to run, not the fixture dates below.
 * Fire detection: because the job is registered through the real singleton
 * (`getScheduler`), there is no hand-rolled fire counter to close over
 * (unlike a manually-built trigger). Fires are detected via two
 * independently-meaningful, scheduler-observable signals instead of a
 * test-only counter: (1) `getScheduler.getJobState(id)?.lastRunAt` — the
 * exact epoch-ms the last run COMPLETED at (`null` until the first
 * completion; unchanged across a window with zero further completions,
 * updated the instant a new one lands) — and (2) the `daily_briefing` row
 * state itself. A "fires exactly once, not twice" assertion snapshots
 * `lastRunAt` after the first expected fire, advances the clock across the
 * second candidate instant, and asserts `lastRunAt` is BIT-FOR-BIT
 * unchanged — a second completion would necessarily overwrite it.
 */
function lastRunAt(): number | null {
  return getScheduler().getJobState(DAILY_BRIEFING_JOB_ID)?.lastRunAt ?? null;
}

function newSyncedClock(startMs: number): FakeClock {
  vi.setSystemTime(startMs);
  return new FakeClock(startMs, (ms) => vi.setSystemTime(ms));
}

/** Initializes the scheduler singleton with fake clock/timer deps and
 * registers the REAL daily-briefing job through it. Any
 * `daily-briefing` settings row a test wants in effect (`seedBriefingTime`)
 * MUST be seeded BEFORE calling this — `registerDailyBriefingJob` reads
 * `getBriefingTime` synchronously at registration time.
 */
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

// Europe/Madrid, August 2026 = CEST (UTC+2). 06:00 local = 04:00 UTC.
const AUG21_BEFORE_0600_UTC = Date.UTC(2026, 7, 21, 3, 0, 0); // 05:00 local
const AUG21_0600_UTC = Date.UTC(2026, 7, 21, 4, 0, 0); // 06:00 local (the fire instant)
const AUG21_AFTER_0600_UTC = Date.UTC(2026, 7, 21, 4, 30, 0); // 06:30 local
const AUG21_NOON_UTC = Date.UTC(2026, 7, 21, 10, 0, 0); // 12:00 local (well past 06:00)
const TODAY = "2026-08-21";
const YESTERDAY = "2026-08-20";

describe("daily-briefing scheduled generation + catch-up (US1)", () => {
  useIsolatedDb();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    try {
      await getScheduler().stop();
    } catch {
      // not initialized by a given test (e.g. the pure-read test below) —
      // nothing to drain.
    }
  });

  it("BACKGROUND-JOBS-SCHEDULER-INV-05: reads are pure — a read does not generate", () => {
    seedMember("m1", { optedIn: true });

    readBriefing("m1", TODAY);

    expect(countBriefingRows("m1", TODAY)).toBe(0);
  });

  it("BACKGROUND-JOBS-SCHEDULER-AC-03: clock advanced past 06:00 household-local — rows exist for opted-in members only", async () => {
    seedMember("m-optin", { optedIn: true });
    seedMember("m-not-optin", { optedIn: false });
    const clock = setupRealJob(AUG21_BEFORE_0600_UTC);

    await getScheduler().start();
    expect(countBriefingRows("m-optin", TODAY)).toBe(0);

    await clock.advanceTo(AUG21_AFTER_0600_UTC);

    expect(countBriefingRows("m-optin", TODAY)).toBe(1);
    expect(countBriefingRows("m-not-optin", TODAY)).toBe(0);
  });

  it("BACKGROUND-JOBS-SCHEDULER-AC-04 / DAILY-BRIEFING-AC-10: start() past 06:00 with zero rows — catch-up generates TODAY only, no backfill", async () => {
    seedMember("m1", { optedIn: true });
    const clock = setupRealJob(AUG21_NOON_UTC);

    await getScheduler().start();
    await clock.flush();

    expect(lastRunAt()).not.toBeNull();
    expect(countBriefingRows("m1", TODAY)).toBe(1);
    // No scanning of past dates (— single-day scope, INV-03 no
    // scheduler-side bookkeeping): yesterday was equally "missing" and stays
    // untouched.
    expect(countBriefingRows("m1", YESTERDAY)).toBe(0);
  });

  it("BACKGROUND-JOBS-SCHEDULER-AC-04: start() before 06:00 — zero rows until the hour", async () => {
    seedMember("m1", { optedIn: true });
    const clock = setupRealJob(AUG21_BEFORE_0600_UTC);

    await getScheduler().start();
    await clock.flush();
    expect(lastRunAt()).toBeNull();
    expect(countBriefingRows("m1", TODAY)).toBe(0);

    await clock.advanceTo(AUG21_0600_UTC);

    expect(lastRunAt()).not.toBeNull();
    expect(countBriefingRows("m1", TODAY)).toBe(1);
  });

  it("BACKGROUND-JOBS-SCHEDULER-AC-04: a row already present before 06:00 blocks catch-up; the scheduled fire refreshes it in place (stable id, zero duplicates)", async () => {
    seedMember("m1", { optedIn: true });
    const preId = seedBriefingRow("m1", TODAY);
    const clock = setupRealJob(AUG21_BEFORE_0600_UTC);

    await getScheduler().start();
    await clock.flush();
    // isMissed(today) is false — m1's only opted-in row already exists — so
    // start must not catch up even though a wallClock job with isMissed is
    // registered.
    expect(lastRunAt()).toBeNull();

    await clock.advanceTo(AUG21_AFTER_0600_UTC);

    expect(lastRunAt()).not.toBeNull();
    expect(countBriefingRows("m1", TODAY)).toBe(1);
    expect(findBriefingRow("m1", TODAY)?.id).toBe(preId);
  });

  it("BACKGROUND-JOBS-SCHEDULER-AC-04 / DAILY-BRIEFING-AC-10: PARTIAL rows — catch-up fires and the missing member gains a row", async () => {
    seedMember("m-has-row", { optedIn: true });
    seedMember("m-missing", { optedIn: true });
    const preId = seedBriefingRow("m-has-row", TODAY);
    const clock = setupRealJob(AUG21_NOON_UTC);

    await getScheduler().start();
    await clock.flush();

    expect(lastRunAt()).not.toBeNull();
    expect(countBriefingRows("m-has-row", TODAY)).toBe(1);
    expect(countBriefingRows("m-missing", TODAY)).toBe(1);
    // generateAllBriefings regenerates every opted-in candidate on a fire —
    // m-has-row's existing row is refreshed in place, never duplicated.
    expect(findBriefingRow("m-has-row", TODAY)?.id).toBe(preId);
  });

  describe("DST transition day — exactly one fire, both directions (research D2)", () => {
    it("BACKGROUND-JOBS-SCHEDULER-INV-04: fall-back repeated local hour (Europe/Madrid 2026-10-25) fires once, not twice", async () => {
      seedMember("m1", { optedIn: true });
      // Oct 24 12:00 UTC = 14:00 CEST — already past THAT day's own 02:30
      // occurrence, so without a pre-existing row `isMissed("2026-10-24")`
      // would be true and start's catch-up sweep would fire a SECOND,
      // unrelated generation for Oct 24 before the DST-day scheduled fire
      // this test is isolating. Seed it "already generated" to neutralize
      // catch-up and isolate the wall-clock/DST re-arm behavior.
      seedBriefingRow("m1", "2026-10-24");
      seedBriefingTime("02:30"); // MUST be seeded before setupRealJob registers
      const startMs = Date.UTC(2026, 9, 24, 12, 0, 0); // well before the transition
      const clock = setupRealJob(startMs);

      await getScheduler().start();
      await clock.flush();
      expect(lastRunAt()).toBeNull(); // catch-up correctly skipped (Oct 24 already has a row)

      const firstOccurrence = Date.UTC(2026, 9, 25, 0, 30, 0); // 2026-10-25T00:30Z = 02:30 CEST (first)
      await clock.advanceTo(firstOccurrence);
      const afterFirstFire = lastRunAt();
      expect(afterFirstFire).not.toBeNull();
      expect(countBriefingRows("m1", "2026-10-25")).toBe(1);

      const secondOccurrenceSameDay = Date.UTC(2026, 9, 25, 1, 30, 0); // 01:30Z = 02:30 CET (repeated)
      await clock.advanceTo(secondOccurrenceSameDay);
      // No second completion happened — lastRunAt is bit-for-bit unchanged.
      expect(lastRunAt()).toBe(afterFirstFire);
      expect(countBriefingRows("m1", "2026-10-25")).toBe(1);
    });

    it("BACKGROUND-JOBS-SCHEDULER-INV-04: spring-forward gap (Europe/Madrid 2026-03-29) fires exactly once at the first valid instant after the gap", async () => {
      seedMember("m1", { optedIn: true });
      seedBriefingTime("02:30"); // nonexistent local time that day — MUST be seeded before setupRealJob
      const startMs = Date.UTC(2026, 2, 29, 0, 0, 0); // 2026-03-29T00:00Z = 01:00 CET, before the gap
      const clock = setupRealJob(startMs);

      await getScheduler().start();
      // 02:00Z = well past the gap's end (03:00 CEST) on the transition day.
      await clock.advanceTo(Date.UTC(2026, 2, 29, 2, 0, 0));

      expect(lastRunAt()).not.toBeNull();
      expect(countBriefingRows("m1", "2026-03-29")).toBe(1);
    });
  });
});
