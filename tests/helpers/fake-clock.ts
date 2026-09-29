/** Deterministic fake clock + timer harness for the scheduler's injectable
 * `now`/`setTimeout`/`clearTimeout` dependencies in
 * `src/server/scheduler/index.ts`. Extracted from `tests/integration/scheduler.test.ts` so
 * integration suites that register a real job against a private scheduler instance can drive
 * time explicitly via
 * `advanceTo`/`advanceBy` — no `vi.useFakeTimers` global patching, no
 * wall-clock-dependent assertions.
 */
export class FakeClock {
  private currentMs: number;
  private nextId = 1;
  private timers: Array<{ id: number; fireAt: number; cb: () => void }> = [];
  private readonly onTick?: (ms: number) => void;

  /** `onTick` (optional) fires whenever `currentMs` changes — including once
   * at construction. Consumers that need the REAL global `Date` to track
   * this virtual clock (e.g. `vi.useFakeTimers({toFake:["Date"]})` +
   * `vi.setSystemTime`, so a fired job's own `new Date` calls — like
   * `resolveBusinessDate` — see the same instant the scheduler fired it at)
   * wire this hook; pure scheduler-only tests can omit it.
   */
  constructor(startMs: number, onTick?: (ms: number) => void) {
    this.currentMs = startMs;
    this.onTick = onTick;
    this.onTick?.(startMs);
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

  /** Flush pending microtasks (promise chains) without moving time forward.
   * A scheduled generation can run up to 21 block generators serially. Each generator and the
   * scheduler wrapper adds promise hops, and the renderer adds more work proportional to the
   * generated content. The 5000-round flush lets the full job settle without advancing time.
   */
  async flush(): Promise<void> {
    for (let i = 0; i < 5000; i++) {
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
      this.onTick?.(this.currentMs);
      next.cb();
      await this.flush();
    }
    this.currentMs = ms;
    this.onTick?.(this.currentMs);
    await this.flush();
  }

  async advanceBy(ms: number): Promise<void> {
    await this.advanceTo(this.currentMs + ms);
  }
}

/** Silent scheduler logger for tests that don't assert on log output. */
export function noopLog() {
  return {
    warn: () => {},
    error: () => {},
  };
}
