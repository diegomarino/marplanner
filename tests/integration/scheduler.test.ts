import { describe, it, expect } from "vitest";
import { useIsolatedDb } from "../helpers/db";
import { createScheduler, initScheduler } from "../../src/server/scheduler/index";
import type { RunJobResult, SchedulerDeps } from "../../src/server/scheduler/index";

/** Deterministic fake clock + timer harness for the scheduler's injectable
 * `now`/`setTimeout`/`clearTimeout` deps — no `vi.useFakeTimers`
 * global patching, no wall-clock-dependent assertions. Timers are driven
 * explicitly via `advanceTo`/`advanceBy`; slow actions are controlled via a
 * manually-resolvable gate (see `deferred` below) rather than real delays.
 */
class FakeClock {
  private currentMs: number;
  private nextId = 1;
  private timers: Array<{ id: number; fireAt: number; cb: () => void }> = [];

  constructor(startMs: number) {
    this.currentMs = startMs;
  }

  now = (): number => this.currentMs;

  setTimeout = ((cb: () => void, delayMs: number): unknown => {
    const id = this.nextId++;
    this.timers.push({ id, fireAt: this.currentMs + Math.max(0, delayMs), cb });
    return id;
  }) as (cb: () => void, delayMs: number) => unknown;

  clearTimeout = ((handle: unknown): void => {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }) as (handle: unknown) => void;

  pendingCount(): number {
    return this.timers.length;
  }

  /** Flush pending microtasks (promise chains) without moving time forward. */
  async flush(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
  }

  /** Advance the clock to `ms`, firing every due timer in order, flushing between each. */
  async advanceTo(ms: number): Promise<void> {
    for (;;) {
      const due = this.timers.filter((t) => t.fireAt <= ms).sort((a, b) => a.fireAt - b.fireAt);
      if (due.length === 0) break;
      const next = due[0];
      this.timers = this.timers.filter((t) => t.id !== next.id);
      this.currentMs = next.fireAt;
      next.cb();
      await this.flush();
    }
    this.currentMs = ms;
    await this.flush();
  }

  async advanceBy(ms: number): Promise<void> {
    await this.advanceTo(this.currentMs + ms);
  }
}

/** A promise the test controls the resolution of, to simulate a slow action. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function noopLog() {
  return {
    warn: () => {},
    error: () => {},
  };
}

describe("scheduler core (T002 — research D1/D3/D4/D5/D7)", () => {
  useIsolatedDb();

  it("BACKGROUND-JOBS-SCHEDULER-INV-07: registerJob throws on a duplicate job id", () => {
    const clock = new FakeClock(0);
    const scheduler = createScheduler({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      log: noopLog(),
    });
    scheduler.registerJob({
      id: "dup",
      trigger: { kind: "interval", everyMs: 1000 },
      action: () => undefined,
    });
    expect(() =>
      scheduler.registerJob({
        id: "dup",
        trigger: { kind: "interval", everyMs: 1000 },
        action: () => undefined,
      })
    ).toThrow();
  });

  describe("guard collisions", () => {
    it("BACKGROUND-JOBS-SCHEDULER-INV-02 / AC-01 / AC-02: an interval tick arriving while a manual run is in flight is skipped, not started", async () => {
      const clock = new FakeClock(0);
      const scheduler = createScheduler({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        log: noopLog(),
      });
      let callCount = 0;
      const gate = deferred<void>();
      scheduler.registerJob({
        id: "job",
        trigger: { kind: "interval", everyMs: 1000 },
        action: async () => {
          callCount++;
          await gate.promise;
        },
      });

      // Manual invocation acquires the guard synchronously (in flight).
      const manualPromise = scheduler.runJobNow("job");
      // The scheduled run-soon-on-startup tick is armed AFTER start; it collides.
      await scheduler.start();
      await clock.advanceBy(0); // process the already-due run-soon tick

      expect(callCount).toBe(1); // only the manual run executed the action
      gate.resolve();
      await clock.flush();
      const manualResult = await manualPromise;
      expect(manualResult).toEqual<RunJobResult>({ status: "completed", result: undefined });
      expect(callCount).toBe(1); // the skipped tick never ran
    });

    it("BACKGROUND-JOBS-SCHEDULER-AC-01 / INV-02: a manual invocation arriving while the same job is running is answered already_running", async () => {
      const clock = new FakeClock(0);
      const scheduler = createScheduler({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        log: noopLog(),
      });
      let callCount = 0;
      const gate = deferred<void>();
      scheduler.registerJob({
        id: "job",
        trigger: { kind: "interval", everyMs: 1000 },
        action: async () => {
          callCount++;
          await gate.promise;
        },
      });

      const first = scheduler.runJobNow("job");
      const second = scheduler.runJobNow("job");
      expect(await second).toEqual<RunJobResult>({ status: "already_running" });
      gate.resolve();
      expect(await first).toEqual<RunJobResult>({ status: "completed", result: undefined });
      expect(callCount).toBe(1);
    });

    it("BACKGROUND-JOBS-SCHEDULER-INV-01 / INV-02: two simultaneous manual invocations — exactly one runs", async () => {
      const clock = new FakeClock(0);
      const scheduler = createScheduler({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        log: noopLog(),
      });
      let callCount = 0;
      const gate = deferred<void>();
      scheduler.registerJob({
        id: "job",
        trigger: { kind: "interval", everyMs: 1000 },
        action: async () => {
          callCount++;
          await gate.promise;
          return "ok";
        },
      });

      const [a, b] = [scheduler.runJobNow("job"), scheduler.runJobNow("job")];
      gate.resolve();
      const [resultA, resultB] = await Promise.all([a, b]);
      const statuses = [resultA.status, resultB.status].sort();
      expect(statuses).toEqual(["already_running", "completed"]);
      expect(callCount).toBe(1);
    });

    it("BACKGROUND-JOBS-SCHEDULER-AC-01: a wall-clock fire colliding with an in-flight manual run is coalesced — exactly one deferred run executes on release", async () => {
      const startMs = Date.UTC(2026, 5, 15, 5, 0, 0); // 2026-06-15T05:00:00Z, well before 10:00 local (Europe/Madrid default)
      const clock = new FakeClock(startMs);
      const scheduler = createScheduler({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        log: noopLog(),
      });
      let callCount = 0;
      const manualGate = deferred<void>();
      scheduler.registerJob({
        id: "job",
        trigger: { kind: "wallClock", at: "10:00" },
        action: async () => {
          callCount++;
          if (callCount === 1) {
            await manualGate.promise; // only the manual (first) call blocks
          }
        },
      });

      const manualPromise = scheduler.runJobNow("job"); // acquires the guard, in flight
      await scheduler.start(); // arms the wall-clock timer for 10:00 local (08:00 UTC)

      // Advance the clock to the wall-clock fire instant while the manual run is still in flight.
      await clock.advanceTo(Date.UTC(2026, 5, 15, 8, 0, 0));
      expect(callCount).toBe(1); // coalesced fire has not run yet — guard still held

      manualGate.resolve();
      await clock.flush();
      await manualPromise;
      await clock.flush();

      expect(callCount).toBe(2); // exactly one coalesced run executed on release
    });
  });

  it("BACKGROUND-JOBS-SCHEDULER-INV-01 / INV-02: interval re-arms only after completion — a slow run is never double-fired by its own cadence", async () => {
    const clock = new FakeClock(0);
    const scheduler = createScheduler({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      log: noopLog(),
    });
    let callCount = 0;
    const gate = deferred<void>();
    scheduler.registerJob({
      id: "job",
      trigger: { kind: "interval", everyMs: 1000 },
      action: async () => {
        callCount++;
        if (callCount === 1) await gate.promise;
      },
    });

    await scheduler.start();
    await clock.advanceBy(0); // run-soon-on-startup fires immediately
    expect(callCount).toBe(1);

    // Advance well past several would-be cadence periods — no re-arm exists yet
    // because the first run hasn't completed, so nothing new can fire.
    await clock.advanceBy(5000);
    expect(callCount).toBe(1);
    expect(clock.pendingCount()).toBe(0);

    gate.resolve();
    await clock.flush(); // completion re-arms at now + everyMs

    await clock.advanceBy(999);
    expect(callCount).toBe(1); // cadence anchored to completion time, not start time
    await clock.advanceBy(1);
    expect(callCount).toBe(2);
  });

  describe("wall-clock fire + DST re-arm (real nextOccurrenceInTz, Europe/Madrid fall-back 2026-10-25)", () => {
    it("BACKGROUND-JOBS-SCHEDULER-INV-01: fires once at the first occurrence and re-arms to the next household-local DATE, never a same-day repeat", async () => {
      const startMs = Date.UTC(2026, 9, 24, 12, 0, 0); // well before the transition
      const clock = new FakeClock(startMs);
      const scheduler = createScheduler({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        log: noopLog(),
      });
      const fireTimes: number[] = [];
      scheduler.registerJob({
        id: "job",
        trigger: { kind: "wallClock", at: "02:30" },
        action: () => {
          fireTimes.push(clock.now());
        },
      });

      await scheduler.start();

      const firstOccurrence = Date.UTC(2026, 9, 25, 0, 30, 0); // 2026-10-25T00:30:00.000Z (CEST, first occurrence)
      await clock.advanceTo(firstOccurrence);
      expect(fireTimes).toEqual([firstOccurrence]);

      // The phantom "second occurrence" of the same repeated local hour must NOT fire.
      const secondOccurrenceSameDay = Date.UTC(2026, 9, 25, 1, 30, 0);
      await clock.advanceTo(secondOccurrenceSameDay);
      expect(fireTimes).toEqual([firstOccurrence]);

      // The next household-local DATE's occurrence fires.
      const nextDateOccurrence = Date.UTC(2026, 9, 26, 1, 30, 0); // 2026-10-26T01:30:00.000Z (CET, no transition)
      await clock.advanceTo(nextDateOccurrence);
      expect(fireTimes).toEqual([firstOccurrence, nextDateOccurrence]);
    });
  });

  describe("catch-up sweep (research D5)", () => {
    it("BACKGROUND-JOBS-SCHEDULER-AC-04: household-local now past `at` AND isMissed(today) → fires once on start()", async () => {
      const nowMs = Date.UTC(2026, 5, 15, 9, 0, 0); // 2026-06-15T09:00:00Z -> 11:00 CEST, past 10:00
      const clock = new FakeClock(nowMs);
      const scheduler = createScheduler({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        log: noopLog(),
      });
      let callCount = 0;
      scheduler.registerJob({
        id: "job",
        trigger: { kind: "wallClock", at: "10:00", isMissed: () => true },
        action: () => {
          callCount++;
        },
      });
      await scheduler.start();
      await clock.flush();
      expect(callCount).toBe(1);
    });

    it("BACKGROUND-JOBS-SCHEDULER-AC-04: household-local now before `at` → no catch-up fire even when isMissed is true", async () => {
      const nowMs = Date.UTC(2026, 5, 15, 5, 0, 0); // 2026-06-15T05:00:00Z -> 07:00 CEST, before 10:00
      const clock = new FakeClock(nowMs);
      const scheduler = createScheduler({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        log: noopLog(),
      });
      let callCount = 0;
      scheduler.registerJob({
        id: "job",
        trigger: { kind: "wallClock", at: "10:00", isMissed: () => true },
        action: () => {
          callCount++;
        },
      });
      await scheduler.start();
      await clock.flush();
      expect(callCount).toBe(0);
    });

    it("BACKGROUND-JOBS-SCHEDULER-AC-04: household-local now past `at` but isMissed is false (output already present) → no catch-up fire", async () => {
      const nowMs = Date.UTC(2026, 5, 15, 9, 0, 0);
      const clock = new FakeClock(nowMs);
      const scheduler = createScheduler({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        log: noopLog(),
      });
      let callCount = 0;
      scheduler.registerJob({
        id: "job",
        trigger: { kind: "wallClock", at: "10:00", isMissed: () => false },
        action: () => {
          callCount++;
        },
      });
      await scheduler.start();
      await clock.flush();
      expect(callCount).toBe(0);
    });
  });

  describe("isActive predicate gates every trigger kind (FR-011)", () => {
    it("BACKGROUND-JOBS-SCHEDULER-AC-07: isActive=false blocks interval ticks, wall-clock fires, manual runs, and catch-up", async () => {
      const nowMs = Date.UTC(2026, 5, 15, 9, 0, 0); // past 10:00 local, would otherwise catch up
      const clock = new FakeClock(nowMs);
      const scheduler = createScheduler({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        log: noopLog(),
      });
      let callCount = 0;
      scheduler.registerJob({
        id: "wc",
        trigger: { kind: "wallClock", at: "10:00", isMissed: () => true },
        action: () => {
          callCount++;
        },
        isActive: () => false,
      });
      let intervalCalls = 0;
      scheduler.registerJob({
        id: "iv",
        trigger: { kind: "interval", everyMs: 1000 },
        action: () => {
          intervalCalls++;
        },
        isActive: () => false,
      });

      await scheduler.start(); // catch-up sweep + run-soon-on-startup, both gated
      await clock.advanceBy(0);
      await clock.flush();
      expect(callCount).toBe(0); // no catch-up
      expect(intervalCalls).toBe(0); // no run-soon tick

      const manualResult = await scheduler.runJobNow("wc");
      expect(manualResult).toEqual<RunJobResult>({ status: "already_running" });
      expect(callCount).toBe(0);

      await clock.advanceTo(Date.UTC(2026, 5, 16, 8, 0, 0)); // next day's 10:00 local wall-clock fire
      expect(callCount).toBe(0); // still gated
    });
  });

  describe("error containment (FR-008 / INV-06)", () => {
    it("BACKGROUND-JOBS-SCHEDULER-INV-06: a throwing action is contained — lastError is set, the loop survives, the next tick still fires", async () => {
      const clock = new FakeClock(0);
      const scheduler = createScheduler({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        log: noopLog(),
      });
      let callCount = 0;
      scheduler.registerJob({
        id: "job",
        trigger: { kind: "interval", everyMs: 1000 },
        action: () => {
          callCount++;
          if (callCount === 1) throw new Error("boom");
          return "ok";
        },
      });

      await scheduler.start();
      await clock.advanceBy(0);
      await clock.flush();

      expect(callCount).toBe(1);
      expect(scheduler.getJobState("job")?.lastError).toBe("boom");
      expect(scheduler.getJobState("job")?.lastRunAt).toBe(clock.now());

      await clock.advanceBy(1000); // next tick still fires — the loop survived
      expect(callCount).toBe(2);
      expect(scheduler.getJobState("job")?.lastError).toBeNull(); // cleared on success
    });

    it('#633 follow-up: a MANUAL runJobNow call whose action throws resolves {status:"failed", error} — never rejects, never silently resolves completed/undefined', async () => {
      const clock = new FakeClock(0);
      const scheduler = createScheduler({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        log: noopLog(),
      });
      const thrown = new Error("boom — manual run");
      scheduler.registerJob({
        id: "job",
        trigger: { kind: "interval", everyMs: 1000 },
        action: () => {
          throw thrown;
        },
      });

      const result = await scheduler.runJobNow("job");

      expect(result).toEqual<RunJobResult>({ status: "failed", error: thrown });
      // The non-manual containment guarantees above stay intact — same lastError bookkeeping.
      expect(scheduler.getJobState("job")?.lastError).toBe("boom — manual run");
    });

    it('#633 follow-up: an interval/wall-clock fire whose action throws is unaffected — it still resolves undefined to its own caller, never a {status:"failed"} result', async () => {
      const clock = new FakeClock(0);
      const scheduler = createScheduler({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        log: noopLog(),
      });
      scheduler.registerJob({
        id: "job",
        trigger: { kind: "interval", everyMs: 1000 },
        action: () => {
          throw new Error("boom — interval tick");
        },
      });

      await scheduler.start();
      await clock.advanceBy(0);
      await clock.flush();

      expect(scheduler.getJobState("job")?.lastError).toBe("boom — interval tick");
    });
  });

  describe("lastRunAt recorded on success", () => {
    it("BACKGROUND-JOBS-SCHEDULER-INV-01: lastRunAt reflects the completion instant", async () => {
      const startMs = Date.UTC(2026, 0, 1, 0, 0, 0);
      const clock = new FakeClock(startMs);
      const scheduler = createScheduler({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        log: noopLog(),
      });
      scheduler.registerJob({
        id: "job",
        trigger: { kind: "interval", everyMs: 1000 },
        action: () => "ok",
      });
      expect(scheduler.getJobState("job")?.lastRunAt).toBeNull();
      await scheduler.start();
      await clock.advanceBy(0);
      await clock.flush();
      expect(scheduler.getJobState("job")?.lastRunAt).toBe(startMs);
    });
  });

  describe("shutdown & lifecycle (research D7)", () => {
    it("BACKGROUND-JOBS-SCHEDULER-INV-07: stop() drains in-flight work, is idempotent (double-stop safe), and a trigger racing stop never starts a run", async () => {
      const clock = new FakeClock(0);
      const scheduler = createScheduler({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        log: noopLog(),
      });
      let callCount = 0;
      const gate = deferred<void>();
      scheduler.registerJob({
        id: "job",
        trigger: { kind: "interval", everyMs: 1000 },
        action: async () => {
          callCount++;
          await gate.promise;
        },
      });

      await scheduler.start();
      await clock.advanceBy(0); // in-flight run-soon tick
      expect(callCount).toBe(1);

      let stopResolved = false;
      const stopPromise = scheduler.stop().then(() => {
        stopResolved = true;
      });
      await clock.flush();
      expect(stopResolved).toBe(false); // stop waits for the in-flight run to drain

      // A trigger racing stop must never start a new run.
      const racedResult = await scheduler.runJobNow("job");
      expect(racedResult).toEqual<RunJobResult>({ status: "already_running" });
      expect(callCount).toBe(1);

      gate.resolve();
      await stopPromise;
      expect(stopResolved).toBe(true);

      // Double-stop is safe.
      await expect(scheduler.stop()).resolves.toBeUndefined();
    });
  });

  describe("coalesced continuation re-checks its gates on release (review B2)", () => {
    it("BACKGROUND-JOBS-SCHEDULER-INV-02 / INV-07: a wall-clock fire coalesced behind an in-flight manual run does NOT execute once stop() has begun before the guard releases", async () => {
      const startMs = Date.UTC(2026, 5, 15, 5, 0, 0); // well before 10:00 local (Europe/Madrid default)
      const clock = new FakeClock(startMs);
      const scheduler = createScheduler({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        log: noopLog(),
      });
      let callCount = 0;
      const manualGate = deferred<void>();
      scheduler.registerJob({
        id: "job",
        trigger: { kind: "wallClock", at: "10:00" },
        action: async () => {
          callCount++;
          if (callCount === 1) await manualGate.promise;
        },
      });

      const manualPromise = scheduler.runJobNow("job"); // acquires the guard, in flight
      await scheduler.start(); // arms the wall-clock timer for 10:00 local (08:00 UTC)
      await clock.advanceTo(Date.UTC(2026, 5, 15, 8, 0, 0)); // wall-clock fires, coalesces behind the manual run
      expect(callCount).toBe(1);

      let stopResolved = false;
      const stopPromise = scheduler.stop().then(() => {
        stopResolved = true;
      });
      await clock.flush();
      expect(stopResolved).toBe(false); // still draining the in-flight manual run

      manualGate.resolve();
      await manualPromise;
      await stopPromise;
      expect(stopResolved).toBe(true);
      expect(callCount).toBe(1); // the coalesced deferred run never executed
    });

    it("BACKGROUND-JOBS-SCHEDULER-AC-07: a wall-clock fire coalesced behind an in-flight run does NOT execute once isActive flips false before the guard releases", async () => {
      const startMs = Date.UTC(2026, 5, 15, 5, 0, 0);
      const clock = new FakeClock(startMs);
      const scheduler = createScheduler({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        log: noopLog(),
      });
      let callCount = 0;
      let active = true;
      const manualGate = deferred<void>();
      scheduler.registerJob({
        id: "job",
        trigger: { kind: "wallClock", at: "10:00" },
        action: async () => {
          callCount++;
          if (callCount === 1) await manualGate.promise;
        },
        isActive: () => active,
      });

      const manualPromise = scheduler.runJobNow("job");
      await scheduler.start();
      await clock.advanceTo(Date.UTC(2026, 5, 15, 8, 0, 0)); // coalesces behind the manual run
      expect(callCount).toBe(1);

      active = false; // flips while the manual run is still in flight
      manualGate.resolve();
      await manualPromise;
      await clock.flush();

      expect(callCount).toBe(1); // the coalesced deferred run was gated out by isActive
    });

    it("BACKGROUND-JOBS-SCHEDULER-INV-07: a wall-clock fire coalesced behind an in-flight run does NOT execute once the job's own stop handle disposes it before the guard releases", async () => {
      const startMs = Date.UTC(2026, 5, 15, 5, 0, 0);
      const clock = new FakeClock(startMs);
      const scheduler = createScheduler({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        log: noopLog(),
      });
      let callCount = 0;
      const manualGate = deferred<void>();
      const stopHandle = scheduler.registerJob({
        id: "job",
        trigger: { kind: "wallClock", at: "10:00" },
        action: async () => {
          callCount++;
          if (callCount === 1) await manualGate.promise;
        },
      });

      const manualPromise = scheduler.runJobNow("job");
      await scheduler.start();
      await clock.advanceTo(Date.UTC(2026, 5, 15, 8, 0, 0)); // coalesces behind the manual run
      expect(callCount).toBe(1);

      const handleStopPromise = stopHandle.stop(); // disposes just this job, awaits its drain
      manualGate.resolve();
      await manualPromise;
      await handleStopPromise;

      expect(callCount).toBe(1); // the coalesced deferred run never executed
    });
  });

  describe("wall-clock re-arm anchors to the fired target under clock skew (hardening nit 1)", () => {
    it("BACKGROUND-JOBS-SCHEDULER-INV-04: re-arming never targets an instant at or before the target that just fired, even if deps.now() reads slightly behind it", async () => {
      const startMs = Date.UTC(2026, 5, 15, 5, 0, 0);
      const clock = new FakeClock(startMs);
      // A `now` wrapper that simulates a few ms of clock skew for the calls
      // immediately following a fire (the re-arm's own now reads), while
      // leaving the fake timer queue itself (driven by `clock.setTimeout`,
      // keyed off `clock`'s own internal `currentMs`) completely unaffected.
      let skewedCallsRemaining = 0;
      const skewedNow = (): number => {
        const real = clock.now();
        if (skewedCallsRemaining > 0) {
          skewedCallsRemaining--;
          return real - 5;
        }
        return real;
      };
      const scheduler = createScheduler({
        now: skewedNow,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        log: noopLog(),
      });
      const fireTimes: number[] = [];
      scheduler.registerJob({
        id: "job",
        trigger: { kind: "wallClock", at: "10:00" },
        action: () => {
          fireTimes.push(clock.now());
          // The next few deps.now calls (lastRunAt + the re-arm's two
          // reads) will read 5ms "behind" the true fire target.
          skewedCallsRemaining = 3;
        },
      });

      await scheduler.start();
      const firstTarget = Date.UTC(2026, 5, 15, 8, 0, 0); // 10:00 CEST
      await clock.advanceTo(firstTarget);
      expect(fireTimes).toEqual([firstTarget]);

      // Without the fix, the skewed re-arm would recompute "today's" 10:00
      // again (since its now reading is still before firstTarget) and
      // schedule a near-immediate second fire at/around firstTarget.
      await clock.advanceTo(firstTarget + 1);
      expect(fireTimes).toEqual([firstTarget]); // still exactly one fire

      // The re-arm's `delay` was itself computed from the same skewed
      // now reading (nextMs - (firstTarget - 5)), so the timer's REAL
      // fire instant (computed against the unskewed fake-timer queue) lands
      // 5ms after the next day's target — a fixed, deterministic artifact
      // of this test's simulated skew, not an assertion about real-world
      // precision. The key property under test is the one above: no
      // same-day double-fire.
      const nextDayTarget = Date.UTC(2026, 5, 16, 8, 0, 0);
      await clock.advanceTo(nextDayTarget + 5);
      expect(fireTimes).toEqual([firstTarget, nextDayTarget + 5]);
    });
  });

  describe("module singleton double-init guard (hardening nit 2)", () => {
    it("initScheduler throws on double-init while the previous instance is live, but allows re-init once it has fully stopped", async () => {
      const noopSetTimeout: SchedulerDeps["setTimeout"] = (_cb, _ms) => 0;
      const noopClearTimeout: SchedulerDeps["clearTimeout"] = (_handle) => {};
      const deps: Partial<SchedulerDeps> = {
        now: () => 0,
        setTimeout: noopSetTimeout,
        clearTimeout: noopClearTimeout,
        log: noopLog(),
      };

      const first = initScheduler(deps);
      expect(() => initScheduler(deps)).toThrow(/already initialized/i);

      await first.stop();
      expect(() => initScheduler(deps)).not.toThrow();
    });
  });

  describe("restart() (slice-014 PR-B review P1-4 — restore-quiesce re-arm)", () => {
    it("does NOT skip the pending wall-clock occurrence stop() interrupted, regardless of time of day", async () => {
      // 2026-06-15T05:00:00Z -> 07:00 CEST, well before 10:00 local — deliberately NOT a
      // day-boundary edge case, to prove the drop happens on an ORDINARY restore at ANY time of
      // day, not just ones that straddle midnight.
      const nowMs = Date.UTC(2026, 5, 15, 5, 0, 0);
      const clock = new FakeClock(nowMs);
      const scheduler = createScheduler({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        log: noopLog(),
      });
      let fireCount = 0;
      scheduler.registerJob({
        id: "job",
        trigger: { kind: "wallClock", at: "10:00" },
        action: () => {
          fireCount++;
        },
      });

      await scheduler.start();
      expect(clock.pendingCount()).toBe(1); // armed for TODAY's 10:00 local

      // Interrupted well before the target ever fired (a restore's quiesce window).
      await scheduler.stop();
      expect(clock.pendingCount()).toBe(0);

      await scheduler.restart();
      expect(clock.pendingCount()).toBe(1); // re-armed

      // 10:00 CEST = 08:00Z. Without resetting the stale armedTargetMs, restart would have
      // anchored the re-arm's baseline on the never-fired target itself, computing the occurrence
      // AFTER it (tomorrow's 10:00) — advancing only to TODAY's target would then never fire.
      const today1000Local = Date.UTC(2026, 5, 15, 8, 0, 0);
      await clock.advanceTo(today1000Local);
      expect(fireCount).toBe(1);
    });

    it("runs the SAME startup catch-up sweep start() runs — a restore can install an older DB, making a missed backup MORE likely, not less", async () => {
      const nowMs = Date.UTC(2026, 5, 15, 9, 0, 0); // past 10:00 local
      const clock = new FakeClock(nowMs);
      const scheduler = createScheduler({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        log: noopLog(),
      });
      let callCount = 0;
      // isMissed flips true only AFTER stop— modeling "the restore itself is what made
      // today's output missing" (an older swapped-in DB, or a pruned/replaced file).
      let missed = false;
      scheduler.registerJob({
        id: "job",
        trigger: { kind: "wallClock", at: "10:00", isMissed: () => missed },
        action: () => {
          callCount++;
        },
      });

      await scheduler.start();
      await clock.flush();
      expect(callCount).toBe(0); // isMissed was false at start — nothing to catch up on yet

      await scheduler.stop();
      missed = true;
      await scheduler.restart();
      await clock.flush();

      expect(callCount).toBe(1); // restart's OWN catch-up sweep caught it — never a re-arm-only op
    });

    it("P2-5: a job genuinely resumes firing after stop() -> restart(), not merely re-armed at the state level", async () => {
      const clock = new FakeClock(0);
      const scheduler = createScheduler({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        log: noopLog(),
      });
      let fireCount = 0;
      scheduler.registerJob({
        id: "job",
        trigger: { kind: "interval", everyMs: 1000 },
        action: () => {
          fireCount++;
        },
      });

      // Interval jobs arm "immediate" (delay=0) both at start and at restart— the first
      // fire happens right away, at whatever instant arming occurred (still requires draining
      // the FakeClock's own timer queue via advanceTo, not just microtasks).
      await scheduler.start();
      await clock.advanceTo(0);
      expect(fireCount).toBe(1);

      await scheduler.stop();
      expect(scheduler.isStopped()).toBe(true);

      await scheduler.restart();
      expect(scheduler.isStopped()).toBe(false);
      await clock.advanceTo(0);
      // The action was genuinely invoked AGAIN post-restart — not just "timer re-armed" at the
      // state level with no observable effect.
      expect(fireCount).toBe(2);
    });

    it("is a no-op when the scheduler was never stopped (only meaningful after a full stop())", async () => {
      const clock = new FakeClock(0);
      const scheduler = createScheduler({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        log: noopLog(),
      });
      scheduler.registerJob({
        id: "job",
        trigger: { kind: "interval", everyMs: 1000 },
        action: () => undefined,
      });
      await scheduler.start();
      expect(clock.pendingCount()).toBe(1);

      await scheduler.restart(); // never stopped — must not double-arm
      expect(clock.pendingCount()).toBe(1);
    });

    it("#633 P2-1: a scheduler that was never start()ed (SCHEDULER_DISABLED=1 posture) stays inert through a stop()+restart() cycle — restart() must not be the FIRST arm", async () => {
      const clock = new FakeClock(0);
      const scheduler = createScheduler({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        log: noopLog(),
      });
      let callCount = 0;
      scheduler.registerJob({
        id: "job",
        trigger: { kind: "interval", everyMs: 1000 },
        action: () => {
          callCount++;
        },
      });

      // Mirrors src/server/index.ts's SCHEDULER_DISABLED=1 posture: init + registerJob only —
      // start is deliberately never called.
      expect(scheduler.isStopped()).toBe(false); // lifecycle: "created", not "stopped" either
      expect(clock.pendingCount()).toBe(0); // registerJob never arms before start

      // Mirrors backups/restore.ts's stopSchedulerIfPresent + restartSchedulerIfWasStopped(true):
      // a restore quiesces around WHATEVER scheduler singleton it finds, started or not, and
      // unconditionally restarts it afterward when it did the stopping.
      await scheduler.stop();
      expect(scheduler.isStopped()).toBe(true);
      await scheduler.restart();

      // The kill-switch's guarantee must survive the round trip: restart must have refused to
      // perform the FIRST arm, so the scheduler never transitions to "started" and zero timers
      // ever get armed — advancing well past several interval periods proves it, not just a
      // snapshot immediately after the call. (see the sibling test right below):
      // restart now returns a never-started scheduler to "created", not wedged "stopped" —
      // isStopped is therefore false here, which is itself the fix (a "stopped" scheduler
      // permanently refuses every future manual runJobNow, see the sibling test).
      expect(scheduler.isStopped()).toBe(false);
      expect(clock.pendingCount()).toBe(0);
      await clock.advanceBy(5000);
      expect(callCount).toBe(0);
    });

    it("Codex P2 on #676: a never-started scheduler's stop()+restart() cycle returns to a manual-ready state — a SUBSEQUENT manual runJobNow call still completes, never wedged at already_running", async () => {
      const clock = new FakeClock(0);
      const scheduler = createScheduler({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        log: noopLog(),
      });
      let callCount = 0;
      scheduler.registerJob({
        id: "job",
        trigger: { kind: "interval", everyMs: 1000 },
        action: () => {
          callCount++;
          return "ok";
        },
      });

      // Mirrors src/server/index.ts's SCHEDULER_DISABLED=1 posture (init + registerJob, never
      // start) followed by backups/restore.ts's stop+restart quiesce cycle around it.
      await scheduler.stop();
      await scheduler.restart();

      // Zero timers armed — same kill-switch proof as the test above.
      expect(clock.pendingCount()).toBe(0);

      // If restart leaves `lifecycle` wedged at "stopped" after this round trip, runGuarded's
      // manual path treats "stopped" as terminal-refuse, so this call would have resolved
      // `already_running` FOREVER (nothing is
      // actually running; the scheduler is just stuck), breaking the admin daily-briefing
      // "generate all" / backups "snapshot now" routes after the FIRST restore until the whole
      // process restarted. It must genuinely run and complete instead.
      const result = await scheduler.runJobNow("job");
      expect(result).toEqual<RunJobResult>({ status: "completed", result: "ok" });
      expect(callCount).toBe(1);

      // Still zero timers armed after the manual call — running a job manually must never itself
      // arm anything.
      expect(clock.pendingCount()).toBe(0);
    });
  });
});
