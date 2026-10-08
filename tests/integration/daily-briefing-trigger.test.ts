import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { getDb, resolveDbPath } from "../../src/server/db/client";
import { getScheduler, initScheduler } from "../../src/server/scheduler/index";
import { emit, todayInHouseholdTz } from "../../src/server/host-api";
import { completeChore } from "../../src/server/modules/routines/index";
import {
  ackJob,
  claimJob,
  enqueuePrintJob,
  failJob,
  supersedePrintRecord,
  __setPrintingPluginActiveForTests,
} from "../../src/server/modules/printing/index";
import { updateSettings } from "../../src/server/modules/daily-briefing/settings";
import {
  AUTO_PRINT_SWEEP_JOB_ID,
  DEFAULT_SWEEP_INTERVAL_MS,
  evaluateAutoPrintTrigger,
  registerAutoPrintTrigger,
} from "../../src/server/modules/daily-briefing/trigger";
import { readBriefing } from "../../src/server/modules/daily-briefing/index";
import { useIsolatedDb } from "../helpers/db";
import { seedMember } from "../helpers/daily-briefing-seed";
import { FakeClock, noopLog } from "../helpers/fake-clock";

/** docs/features/daily-briefing.md (US1, FR-017/FR-018) — the auto-print
 * trigger, the slice's MVP checkpoint. Covers US1's six acceptance scenarios + the
 * toggle-storm/double-event/midnight-rollover edge cases named in, the FR-018 gate
 * cascade, and the wakeup-hint's payload-independent re-evaluation.
 * Independent- (batch-C): the periodic sweep + startup evaluation route through the
 * REAL scheduler singleton (`registerAutoPrintTrigger` registers a `"interval"`-trigger job,
 * `./trigger.ts`) rather than a bespoke timer — those tests use `FakeClock` +
 * `initScheduler`/`getScheduler`, the same harness `daily-briefing-scheduled.test.ts` already
 * established for the sibling wall-clock generation job. Frozen, injected clock throughout — no
 * test here reads the real wall clock.
 */
describe("daily-briefing auto-print trigger (US1, research D3, FR-017/FR-018)", () => {
  useIsolatedDb();

  const NOW = Date.UTC(2026, 7, 13, 10, 0, 0); // 2026-08-13 12:00 Europe/Madrid (CEST) — Thursday
  const WEEKDAY = "thu";
  let DATE: string;

  beforeEach(() => {
    DATE = todayInHouseholdTz(NOW);
  });

  afterEach(async () => {
    __setPrintingPluginActiveForTests(undefined);
    try {
      await getScheduler().stop();
    } catch {
      // Not every test initializes a scheduler — nothing to drain.
    }
  });

  // ── seeding helpers ──────────────────────────────────────────────────────────────────────────

  function enableAutoPrint(): void {
    updateSettings({ autoPrintTrigger: "morning_complete" });
  }

  /** One routine in the 'morning' period, `choreCount` chores, assigned to `weekday`. */
  function seedMorningRoutine(memberId: string, choreCount: number, weekday: string): string[] {
    const db = getDb();
    const now = Date.now();
    const routineId = `routine-${memberId}`;
    db.prepare(
      "INSERT INTO routines (id, day_period_id, name, active, created_at, updated_at) VALUES (?, 'morning', 'Morning Routine', 1, ?, ?)"
    ).run(routineId, now, now);
    const choreIds: string[] = [];
    for (let i = 0; i < choreCount; i += 1) {
      const choreId = `chore-${memberId}-${i}`;
      db.prepare(
        "INSERT INTO chores (id, routine_id, name, sort_order, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)"
      ).run(choreId, routineId, `Chore ${i}`, i, now, now);
      choreIds.push(choreId);
    }
    db.prepare(
      "INSERT INTO routine_assignments (id, routine_id, member_id, weekdays, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)"
    ).run(`assign-${memberId}`, routineId, memberId, JSON.stringify([weekday]), now, now);
    return choreIds;
  }

  /** Direct completion write (bypasses routines' own eligibility/event machinery) — used for
   * predicate/gate tests that don't need a real `routines.completion_changed` emission. */
  function completeChoreDirect(choreId: string, memberId: string, date: string): void {
    getDb()
      .prepare(
        "INSERT INTO chore_completions (id, chore_id, member_id, date, completed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(member_id, chore_id, date) DO NOTHING"
      )
      .run(`${choreId}-${date}-completion`, choreId, memberId, date, Date.now());
  }

  /** A `daily_briefing` row carrying SOME stored raster (content is irrelevant — only NULL-ness
   * of `raster_bits` matters to the trigger's gate). */
  function seedBriefingRowWithRaster(memberId: string, date: string): void {
    const now = Date.now();
    getDb()
      .prepare(
        `INSERT INTO daily_briefing
          (id, member_id, date, status, payload, failed_render_blocks, raster_bits, raster_height, png, created_at, updated_at)
         VALUES (?, ?, ?, 'ready', '{}', '[]', ?, ?, ?, ?, ?)`
      )
      .run(
        `briefing-${memberId}-${date}`,
        memberId,
        date,
        Buffer.from([0]),
        1,
        Buffer.from([0]),
        now,
        now
      );
  }

  function outputRefFor(memberId: string, date: string = DATE): string {
    return `daily-briefing:${memberId}:${date}`;
  }

  function countJobsForOutputRef(outputRef: string): number {
    const row = getDb()
      .prepare("SELECT COUNT(*) AS n FROM print_jobs WHERE output_ref = ?")
      .get(outputRef) as { n: number };
    return row.n;
  }

  function countBriefingRows(memberId: string, date: string): number {
    const row = getDb()
      .prepare("SELECT COUNT(*) AS n FROM daily_briefing WHERE member_id = ? AND date = ?")
      .get(memberId, date) as { n: number };
    return row.n;
  }

  // ── US1 acceptance scenarios ─────────────────────────────────────────────────────────────────

  it("AC-1: the last morning chore completed -> exactly one print job enqueued", () => {
    const memberId = "member-last-chore";
    seedMember(memberId);
    enableAutoPrint();
    seedBriefingRowWithRaster(memberId, DATE);
    const [chore1, chore2] = seedMorningRoutine(memberId, 2, WEEKDAY);
    completeChoreDirect(chore1, memberId, DATE);

    evaluateAutoPrintTrigger(NOW);
    expect(countJobsForOutputRef(outputRefFor(memberId))).toBe(0);

    completeChoreDirect(chore2, memberId, DATE);
    evaluateAutoPrintTrigger(NOW);
    expect(countJobsForOutputRef(outputRefFor(memberId))).toBe(1);
  });

  it("AC-2 / toggle storm: un-complete + re-complete after the print -> still exactly one job", () => {
    const memberId = "member-toggle-storm";
    seedMember(memberId);
    enableAutoPrint();
    seedBriefingRowWithRaster(memberId, DATE);
    const [chore1] = seedMorningRoutine(memberId, 1, WEEKDAY);
    completeChoreDirect(chore1, memberId, DATE);

    evaluateAutoPrintTrigger(NOW);
    expect(countJobsForOutputRef(outputRefFor(memberId))).toBe(1);

    getDb()
      .prepare("DELETE FROM chore_completions WHERE chore_id = ? AND member_id = ? AND date = ?")
      .run(chore1, memberId, DATE);
    evaluateAutoPrintTrigger(NOW); // predicate now false — nothing changes
    completeChoreDirect(chore1, memberId, DATE);
    evaluateAutoPrintTrigger(NOW); // predicate true again — must NOT enqueue a SECOND job

    expect(countJobsForOutputRef(outputRefFor(memberId))).toBe(1);
  });

  it("P2-5: once the job is ACTUALLY printed, a later re-complete dedups via the alreadyPrinted branch, not the pending-job branch", () => {
    const memberId = "member-toggle-after-print";
    seedMember(memberId);
    enableAutoPrint();
    seedBriefingRowWithRaster(memberId, DATE);
    const [chore1] = seedMorningRoutine(memberId, 1, WEEKDAY);
    completeChoreDirect(chore1, memberId, DATE);

    evaluateAutoPrintTrigger(NOW);
    expect(countJobsForOutputRef(outputRefFor(memberId))).toBe(1);

    // Drive the enqueued job through the REAL claim -> ack path (printing/index.ts) so the
    // print_records row genuinely carries `printed_job_id` (no pending/claimed job survives) —
    // the ONLY way `enqueuePrintJob`'s next call can dedup is its `alreadyPrinted` branch
    // (printing/index.ts:433-435), never the "in-flight pending/claimed job" branch, since no such
    // job exists anymore.
    const claimed = claimJob(NOW);
    expect(claimed).not.toBeNull();
    ackJob(claimed!.job.id, claimed!.leaseToken, NOW);

    getDb()
      .prepare("DELETE FROM chore_completions WHERE chore_id = ? AND member_id = ? AND date = ?")
      .run(chore1, memberId, DATE);
    completeChoreDirect(chore1, memberId, DATE);
    evaluateAutoPrintTrigger(NOW);

    expect(countJobsForOutputRef(outputRefFor(memberId))).toBe(1); // still exactly one job, ever
  });

  it("Codex #702 FOLD-1: a terminally-failed (dead-lettered) job gates the trigger — no unbounded re-enqueue", () => {
    const memberId = "member-dead-letter";
    const recordKey = `daily-briefing:${memberId}`;
    seedMember(memberId);
    enableAutoPrint();
    seedBriefingRowWithRaster(memberId, DATE);
    const [chore1] = seedMorningRoutine(memberId, 1, WEEKDAY);
    completeChoreDirect(chore1, memberId, DATE);

    evaluateAutoPrintTrigger(NOW);
    expect(countJobsForOutputRef(outputRefFor(memberId))).toBe(1);

    // Drive the job to a PERMANENT, terminal failure through the REAL executor-report path
    // (printing/index.ts's own `failJob`) — this is the state a real dead-letter leaves behind:
    // `enqueuePrintJob`'s dedup deliberately does NOT treat `failed` as "already handled" (the
    // admin manual-retry remedy must stay reachable), so without the trigger's OWN gate this
    // would re-enqueue forever.
    const claimed = claimJob(NOW);
    expect(claimed).not.toBeNull();
    failJob(
      claimed!.job.id,
      claimed!.leaseToken,
      NOW,
      "printer reported permanent error",
      "render_failure"
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // "Advance two sweep intervals" — simulated as two further level-triggered evaluations
    // (every other test in this file drives repeated evaluations the same direct way; no
    // scheduler wiring is under test here, only the gate itself).
    evaluateAutoPrintTrigger(NOW);
    evaluateAutoPrintTrigger(NOW);

    expect(countJobsForOutputRef(outputRefFor(memberId))).toBe(1); // still just the one, dead-lettered job
    expect(warnSpy).toHaveBeenCalledWith(
      "daily-briefing.trigger.terminal-failed-job-skip",
      expect.objectContaining({ memberId, date: DATE })
    );
    warnSpy.mockRestore();

    // The admin remedy: supersede (or an equally-legitimate direct re-enqueue) still works —
    // this gate binds ONLY the trigger, never printing's own enqueue semantics.
    const outputRef = outputRefFor(memberId);
    supersedePrintRecord(recordKey, DATE, NOW);
    const remedy = enqueuePrintJob({ recordKey, targetDate: DATE, outputRef, memberId }, NOW);
    expect(remedy.enqueued).toBe(true);
    expect(countJobsForOutputRef(outputRef)).toBe(2); // the dead-lettered job PLUS the fresh remedy job
  });

  it("Codex #710: a regeneration (supersede bumps generation) un-poisons the trigger's dead-letter gate — the OLD generation's failure must not gate the NEW one", () => {
    const memberId = "member-dead-letter-regen";
    const recordKey = `daily-briefing:${memberId}`;
    const outputRef = outputRefFor(memberId);
    seedMember(memberId);
    enableAutoPrint();
    seedBriefingRowWithRaster(memberId, DATE);
    const [chore1] = seedMorningRoutine(memberId, 1, WEEKDAY);
    completeChoreDirect(chore1, memberId, DATE);

    evaluateAutoPrintTrigger(NOW);
    expect(countJobsForOutputRef(outputRef)).toBe(1);

    // Drive the job to a PERMANENT, terminal failure — same dead-letter setup as the test
    // above.
    const claimed = claimJob(NOW);
    expect(claimed).not.toBeNull();
    failJob(
      claimed!.job.id,
      claimed!.leaseToken,
      NOW,
      "printer reported permanent error",
      "render_failure"
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // OLD behavior, still correct: the trigger's OWN gate skips re-enqueuing the doomed job.
    evaluateAutoPrintTrigger(NOW);
    expect(countJobsForOutputRef(outputRef)).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "daily-briefing.trigger.terminal-failed-job-skip",
      expect.objectContaining({ memberId, date: DATE })
    );
    warnSpy.mockRestore();

    // REGENERATE: the core effect a real `generateBriefing` regeneration has on Printing's side —
    // supersede bumps the record's generation. The OLD (now-superseded) generation's terminal
    // `failed` job is left in place untouched (`supersedePrintRecordTxn` never cancels a `failed`
    // job — nothing to cancel), which is EXACTLY the state that used to falsely poison the gate.
    supersedePrintRecord(recordKey, DATE, NOW);

    // fix: the trigger evaluates AGAIN (no manual remedy call) and now ENQUEUES — the
    // fresh generation is unpoisoned by the old generation's dead letter.
    evaluateAutoPrintTrigger(NOW);
    expect(countJobsForOutputRef(outputRef)).toBe(2); // the old dead-lettered job PLUS a fresh one

    // Both jobs share the SAME frozen `NOW` `created_at` (no clock advance in this test), so pick
    // the fresh one by GENERATION rather than relying on `created_at` tie-breaking.
    const jobsForOutputRef = getDb()
      .prepare("SELECT state, generation FROM print_jobs WHERE output_ref = ?")
      .all(outputRef) as Array<{ state: string; generation: number }>;
    expect(jobsForOutputRef).toHaveLength(2);
    const newJob = jobsForOutputRef.find((job) => job.generation === 1);
    expect(newJob?.state).toBe("pending"); // the NEW generation, not the dead-lettered one's (0)

    // Printed-status read after this exact sequence must report "none" — nothing has printed or
    // permanently failed AT THE CURRENT generation; the stale generation-0 failure must not leak
    // through as "failed" (the same bug, observed from the read side).
    const result = readBriefing(memberId, DATE);
    if (!result.generated) throw new Error("expected a generated briefing");
    expect(result.printedStatus).toBe("none");
  });

  it("AC-3: a morning day-period with zero chores never counts as complete", () => {
    const memberId = "member-zero-chores";
    seedMember(memberId);
    enableAutoPrint();
    seedBriefingRowWithRaster(memberId, DATE);
    // No routine/assignment seeded: the member's 'morning' column exists (day_periods is
    // migration-seeded) but with zero chores.

    evaluateAutoPrintTrigger(NOW);
    expect(countJobsForOutputRef(outputRefFor(memberId))).toBe(0);
  });

  it("AC-4: the morning day-period missing entirely is recorded loudly, never silent 'not done'", () => {
    const memberId = "member-missing-period";
    seedMember(memberId);
    enableAutoPrint();
    seedBriefingRowWithRaster(memberId, DATE);
    // No routine references 'morning' for this member, so deleting the day_periods row itself is
    // FK-safe (drizzle/0005: routines.day_period_id REFERENCES day_periods(id)).
    getDb().prepare("DELETE FROM day_periods WHERE id = 'morning'").run();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    evaluateAutoPrintTrigger(NOW);

    expect(countJobsForOutputRef(outputRefFor(memberId))).toBe(0);
    expect(errorSpy).toHaveBeenCalledWith(
      "daily-briefing.trigger.morning-period-missing",
      expect.objectContaining({ memberId, date: DATE })
    );
    errorSpy.mockRestore();
  });

  it("P2-2: an opted-in ADULT member (no board column at all) warns distinctly — never the AC-4 anomaly", () => {
    const memberId = "member-adult";
    const now = Date.now();
    getDb()
      .prepare(
        "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, 'Adult Member', 'parent', 'active', ?, ?)"
      )
      .run(memberId, now, now);
    getDb()
      .prepare(
        "INSERT INTO daily_briefing_optin (member_id, enabled, created_at, updated_at) VALUES (?, 1, ?, ?)"
      )
      .run(memberId, now, now);
    enableAutoPrint();
    seedBriefingRowWithRaster(memberId, DATE);
    // Deliberately NO routine seeded — `getBoard` only returns children (`listActiveChildren`),
    // so this adult member never has a board column regardless.

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    evaluateAutoPrintTrigger(NOW);

    expect(countJobsForOutputRef(outputRefFor(memberId))).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      "daily-briefing.trigger.board-column-missing",
      expect.objectContaining({ memberId, date: DATE })
    );
    expect(errorSpy).not.toHaveBeenCalledWith(
      "daily-briefing.trigger.morning-period-missing",
      expect.anything()
    );
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("AC-5 / FR-010 purity: raster-missing is a loud skip, no enqueue, and creates NO daily_briefing row", () => {
    const memberId = "member-raster-missing";
    seedMember(memberId);
    enableAutoPrint();
    const [chore1] = seedMorningRoutine(memberId, 1, WEEKDAY);
    completeChoreDirect(chore1, memberId, DATE); // morning IS complete — the anomalous combination
    // Deliberately no seedBriefingRowWithRaster call — no printable raster stored.

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    evaluateAutoPrintTrigger(NOW);

    expect(countJobsForOutputRef(outputRefFor(memberId))).toBe(0);
    expect(errorSpy).toHaveBeenCalledWith(
      "daily-briefing.trigger.raster-missing",
      expect.objectContaining({ memberId, date: DATE })
    );
    // The evaluation only ever SELECTs — never lazily generates a briefing (FR-010).
    expect(countBriefingRows(memberId, DATE)).toBe(0);
    errorSpy.mockRestore();
  });

  it("Codex #702 FOLD-2: raster-missing writes a REAL client_log telemetry record, not just stderr", () => {
    const memberId = "member-raster-missing-telemetry";
    seedMember(memberId);
    enableAutoPrint();
    const [chore1] = seedMorningRoutine(memberId, 1, WEEKDAY);
    completeChoreDirect(chore1, memberId, DATE); // morning IS complete — the anomalous combination
    // Deliberately no seedBriefingRowWithRaster call — no printable raster stored.

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    evaluateAutoPrintTrigger(NOW);
    errorSpy.mockRestore();

    const rows = getDb()
      .prepare("SELECT component, message, level, data FROM client_log")
      .all() as Array<{ component: string; message: string; level: string; data: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].component).toBe("daily-briefing");
    expect(rows[0].message).toBe("raster_missing_on_completed_morning");
    expect(rows[0].level).toBe("error");
    expect(JSON.parse(rows[0].data ?? "{}")).toMatchObject({ memberId, date: DATE });
  });

  it("P1-2: raster-missing is SILENT while the morning is merely incomplete (not yet an anomaly)", () => {
    const memberId = "member-raster-missing-incomplete";
    seedMember(memberId);
    enableAutoPrint();
    const [chore1] = seedMorningRoutine(memberId, 2, WEEKDAY);
    completeChoreDirect(chore1, memberId, DATE); // NOT all complete — predicate false
    // No raster seeded either — but since the predicate is false, the raster gate must never
    // even be reached (batch-C: logging follows the PREDICATE, not the raw
    // gate-cascade doc order).

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    evaluateAutoPrintTrigger(NOW);

    expect(countJobsForOutputRef(outputRefFor(memberId))).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("AC-6: startup evaluation after a simulated restart enqueues a pending completed morning", async () => {
    const memberId = "member-startup";
    seedMember(memberId);
    enableAutoPrint();
    seedBriefingRowWithRaster(memberId, DATE);
    const [chore1] = seedMorningRoutine(memberId, 1, WEEKDAY);
    completeChoreDirect(chore1, memberId, DATE); // completed BEFORE the simulated "restart"

    const clock = new FakeClock(NOW);
    initScheduler({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      log: noopLog(),
    });
    registerAutoPrintTrigger({ now: clock.now });

    // The scheduler's own interval-trigger arm fires IMMEDIATELY (0ms delay) on start — this
    // IS the startup evaluation (batch-C); it only runs because start actually
    // executed, matching the kill-switch's own placement (see this file's header doc comment).
    // `FakeClock` only fires DUE timers on an explicit `advanceTo`/`advanceBy` (never on `flush`
    // alone, which just drains microtasks) — `advanceTo(NOW)` reaches the 0ms-delay immediate
    // timer armed at exactly `NOW`.
    await getScheduler().start();
    await clock.advanceTo(NOW);

    expect(countJobsForOutputRef(outputRefFor(memberId))).toBe(1);
  });

  it("kill-switch parity: with the scheduler never started, NOTHING fires — no startup eval, no sweep", async () => {
    const memberId = "member-kill-switch";
    seedMember(memberId);
    enableAutoPrint();
    seedBriefingRowWithRaster(memberId, DATE);
    const [chore1] = seedMorningRoutine(memberId, 1, WEEKDAY);
    completeChoreDirect(chore1, memberId, DATE);

    const clock = new FakeClock(NOW);
    initScheduler({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      log: noopLog(),
    });
    registerAutoPrintTrigger({ now: clock.now });
    // Deliberately NEVER call getScheduler.start — mirrors SCHEDULER_DISABLED=1
    // (src/server/index.ts): every job is registered, but `registerJob` only arms once
    // lifecycle === "started", so nothing is ever armed and nothing fires.
    await clock.advanceBy(DEFAULT_SWEEP_INTERVAL_MS * 2);

    expect(countJobsForOutputRef(outputRefFor(memberId))).toBe(0);
  });

  // ── FR-018 gate cascade ──────────────────────────────────────────────────────────────────────

  describe("FR-018 gate cascade — a failed gate is a silent no-op (except raster-missing)", () => {
    it("trigger binding absent -> nothing enqueued, even with predicate true and NO raster (mutation-hardened)", () => {
      const memberId = "member-gate-binding";
      seedMember(memberId);
      // No enableAutoPrint call — the binding stays unset (null).
      // Deliberately NO raster row (batch-C): a raster row seeded here would let
      // a mutation that reorders/removes the binding gate slip through undetected, since "raster
      // present" alone already forces 0 jobs. Asserting the log never fires proves the binding
      // gate short-circuits BEFORE the raster-missing check is ever reached.
      const [chore1] = seedMorningRoutine(memberId, 1, WEEKDAY);
      completeChoreDirect(chore1, memberId, DATE);

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      evaluateAutoPrintTrigger(NOW);

      expect(countJobsForOutputRef(outputRefFor(memberId))).toBe(0);
      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it("member opt-in off -> nothing enqueued", () => {
      const memberId = "member-gate-optin";
      seedMember(memberId, { optedIn: false });
      enableAutoPrint();
      seedBriefingRowWithRaster(memberId, DATE);
      const [chore1] = seedMorningRoutine(memberId, 1, WEEKDAY);
      completeChoreDirect(chore1, memberId, DATE);

      evaluateAutoPrintTrigger(NOW);
      expect(countJobsForOutputRef(outputRefFor(memberId))).toBe(0);
    });

    it("Printing plugin inactive -> nothing enqueued, and the raster gate is never even reached", () => {
      const memberId = "member-gate-printing";
      seedMember(memberId);
      enableAutoPrint();
      // Deliberately NO raster row: if the printing-inactive gate were checked AFTER the raster
      // gate (wrong order), this would wrongly produce a raster-missing log.
      const [chore1] = seedMorningRoutine(memberId, 1, WEEKDAY);
      completeChoreDirect(chore1, memberId, DATE);
      __setPrintingPluginActiveForTests(false);

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      evaluateAutoPrintTrigger(NOW);

      expect(countJobsForOutputRef(outputRefFor(memberId))).toBe(0);
      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });

  // ── Wakeup-hint semantics ────────────────────────────────────────────────────────────────────

  it("records SQLITE_BUSY wakeup failures and recovers without duplicate print reservations", async () => {
    const memberId = "member-busy-wakeup";
    seedMember(memberId);
    enableAutoPrint();
    seedBriefingRowWithRaster(memberId, DATE);
    const [choreId] = seedMorningRoutine(memberId, 1, WEEKDAY);
    completeChoreDirect(choreId, memberId, DATE);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    initScheduler({ now: () => NOW, log: { ...noopLog(), error: errorSpy } });
    registerAutoPrintTrigger({ now: () => NOW });
    const locker = new Database(resolveDbPath());
    const db = getDb();
    const previousTimeout = db.pragma("busy_timeout", { simple: true }) as number;
    db.pragma("busy_timeout = 0");
    const wakeup = () =>
      emit("routines.completion_changed", {
        memberId,
        choreId,
        routineId: "routine-busy",
        date: DATE,
        completed: true,
        timestamp: NOW,
      });
    try {
      locker.exec("BEGIN IMMEDIATE");
      const scheduled = await getScheduler().runJobNow(AUTO_PRINT_SWEEP_JOB_ID);
      expect(scheduled.status).toBe("failed");
      expect(getScheduler().getJobState(AUTO_PRINT_SWEEP_JOB_ID)?.lastError).toMatch(/locked/);
      errorSpy.mockClear();
      expect(() => wakeup()).not.toThrow();
      await Promise.resolve();
      expect(countJobsForOutputRef(outputRefFor(memberId))).toBe(0);
      expect(db.prepare("SELECT COUNT(*) AS n FROM print_records").get()).toEqual({ n: 0 });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("event-bus.subscriber-failed"));
      const diagnostic = JSON.parse(errorSpy.mock.calls[0][0] as string);
      expect(diagnostic.data).toMatchObject({
        event: "routines.completion_changed",
        subscriber: "daily-briefing.auto-print-wakeup",
        error: { code: "SQLITE_BUSY" },
      });
      locker.exec("ROLLBACK");
      wakeup();
      wakeup();
      await Promise.resolve();
      expect(countJobsForOutputRef(outputRefFor(memberId))).toBe(1);
      expect(db.prepare("SELECT COUNT(*) AS n FROM print_records").get()).toEqual({ n: 1 });
    } finally {
      if (locker.inTransaction) locker.exec("ROLLBACK");
      locker.close();
      db.pragma(`busy_timeout = ${previousTimeout}`);
      errorSpy.mockRestore();
    }
  });

  it("wakeup-hint re-reads state — a LYING event payload never substitutes for the real predicate", async () => {
    const memberId = "member-wakeup-lying";
    seedMember(memberId);
    enableAutoPrint();
    seedBriefingRowWithRaster(memberId, DATE);
    const [chore1, chore2] = seedMorningRoutine(memberId, 2, WEEKDAY);
    completeChoreDirect(chore1, memberId, DATE); // NOT all complete yet — predicate is FALSE

    // A scheduler must exist for `registerJob` to succeed, but is deliberately never `start`'d —
    // only the (non-timer) wakeup subscription is live here, isolating it from the sweep/startup
    // path under test elsewhere.
    initScheduler({ now: () => NOW, log: noopLog() });
    registerAutoPrintTrigger({ now: () => NOW });

    // A LYING payload claiming completion — the DB state itself is still incomplete.
    emit("routines.completion_changed", {
      memberId,
      choreId: chore2,
      routineId: "routine-irrelevant",
      date: DATE,
      completed: true,
      timestamp: NOW,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(countJobsForOutputRef(outputRefFor(memberId))).toBe(0); // re-read from state, not the lie

    // Make the DB state genuinely complete, then emit again with an IRRELEVANT payload — only
    // the re-read state (not `completed: false` below) governs the outcome.
    completeChoreDirect(chore2, memberId, DATE);
    emit("routines.completion_changed", {
      memberId,
      choreId: chore2,
      routineId: "routine-irrelevant",
      date: DATE,
      completed: false,
      timestamp: NOW,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(countJobsForOutputRef(outputRefFor(memberId))).toBe(1);
  });

  it("a duplicate/no-op completion event is harmless — still exactly one job", async () => {
    const memberId = "member-double-event";
    seedMember(memberId);
    enableAutoPrint();
    seedBriefingRowWithRaster(memberId, DATE);
    const [chore1] = seedMorningRoutine(memberId, 1, WEEKDAY);

    initScheduler({ now: () => NOW, log: noopLog() });
    registerAutoPrintTrigger({ now: () => NOW });

    // routines' completeChore emits `routines.completion_changed` EVEN on a no-op
    // (`ON CONFLICT DO NOTHING`) second call — v1-study gotcha.
    completeChore(chore1, memberId, DATE);
    completeChore(chore1, memberId, DATE);

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(countJobsForOutputRef(outputRefFor(memberId))).toBe(1);
  });

  // ── Midnight rollover ────────────────────────────────────────────────────────────────────────

  it("midnight rollover: the household date is re-derived per evaluation, never cached", () => {
    const memberId = "member-midnight";
    seedMember(memberId);
    enableAutoPrint();

    const NOW1 = NOW; // 2026-08-13 (thu)
    const DATE1 = todayInHouseholdTz(NOW1);
    const NOW2 = Date.UTC(2026, 7, 14, 10, 0, 0); // the NEXT calendar day, 2026-08-14 (fri)
    const DATE2 = todayInHouseholdTz(NOW2);
    expect(DATE2).not.toBe(DATE1);

    seedBriefingRowWithRaster(memberId, DATE1);
    seedBriefingRowWithRaster(memberId, DATE2);
    const [choreThu] = seedMorningRoutine(memberId, 1, "thu");
    completeChoreDirect(choreThu, memberId, DATE1);

    evaluateAutoPrintTrigger(NOW1);
    expect(countJobsForOutputRef(outputRefFor(memberId, DATE1))).toBe(1);
    expect(countJobsForOutputRef(outputRefFor(memberId, DATE2))).toBe(0);

    // A SEPARATE routine assigned to "fri" proves DATE2 is genuinely evaluated (a distinct
    // record/job for a distinct date), not DATE1 replayed under a stale cached value.
    const db = getDb();
    const now = Date.now();
    const choreFri = "chore-midnight-fri";
    db.prepare(
      "INSERT INTO routines (id, day_period_id, name, active, created_at, updated_at) VALUES ('routine-midnight-fri', 'morning', 'Friday Routine', 1, ?, ?)"
    ).run(now, now);
    db.prepare(
      "INSERT INTO chores (id, routine_id, name, sort_order, active, created_at, updated_at) VALUES (?, 'routine-midnight-fri', 'Fri chore', 0, 1, ?, ?)"
    ).run(choreFri, now, now);
    db.prepare(
      `INSERT INTO routine_assignments (id, routine_id, member_id, weekdays, active, created_at, updated_at)
       VALUES ('assign-midnight-fri', 'routine-midnight-fri', ?, '["fri"]', 1, ?, ?)`
    ).run(memberId, now, now);
    completeChoreDirect(choreFri, memberId, DATE2);

    evaluateAutoPrintTrigger(NOW2);
    expect(countJobsForOutputRef(outputRefFor(memberId, DATE2))).toBe(1);
    // DATE1's job count is unaffected by the later, DATE2 evaluation.
    expect(countJobsForOutputRef(outputRefFor(memberId, DATE1))).toBe(1);
  });

  // ── Sweep cadence ────────────────────────────────────────────────────────────────────────────

  it("the default sweep cadence never exceeds the spec's 60-second bound", () => {
    expect(DEFAULT_SWEEP_INTERVAL_MS).toBeLessThanOrEqual(60_000);
  });

  it("registerAutoPrintTrigger arms a REAL scheduler interval job at the configured cadence, and each tick re-evaluates", async () => {
    const memberId = "member-sweep";
    seedMember(memberId);
    enableAutoPrint();
    seedBriefingRowWithRaster(memberId, DATE);
    const [chore1] = seedMorningRoutine(memberId, 1, WEEKDAY);
    // Predicate is false at registration/startup time — the chore isn't completed yet.

    const sweepIntervalMs = 5_000; //: the override param an e2e suite can later inject
    const clock = new FakeClock(NOW);
    initScheduler({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      log: noopLog(),
    });
    registerAutoPrintTrigger({ now: clock.now, sweepIntervalMs });

    await getScheduler().start();
    // Fires the immediate (0ms-delay) startup tick and re-arms the NEXT one at `NOW +
    // sweepIntervalMs` — `advanceTo(NOW)` reaches exactly the first, not the second.
    await clock.advanceTo(NOW);
    expect(countJobsForOutputRef(outputRefFor(memberId))).toBe(0); // startup fire: predicate false

    completeChoreDirect(chore1, memberId, DATE);
    await clock.advanceBy(sweepIntervalMs); // the next periodic tick, now with the completed chore

    expect(countJobsForOutputRef(outputRefFor(memberId))).toBe(1);
  });
});
