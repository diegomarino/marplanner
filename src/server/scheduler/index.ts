/** Background-Jobs Scheduler core (ADR-014). A thin in-process primitive: it owns
 * when* work fires and *that it never overlaps itself* — nothing else.
 * No scheduler-owned table, no persisted lease, no bus events (INV-01/03/08,
 * ADR-040). Plugin jobs register only through the host-api barrel
 * (`src/server/host-api/index.ts`, Rule B / ADR-039) — this module itself is
 * core and is the thing that barrel re-exports from.
 * Its design covers re-arming timers, DST-aware wall-clock math in
 * `../lib/household-date`, an injectable clock/timer seam, a shared in-flight
 * guard, domain-state-driven catch-up, and drain-on-stop behavior.
 */
import {
  nextOccurrenceInTz,
  readHouseholdTimezone,
  todayInHouseholdTz,
} from "../lib/household-date";

export interface SchedulerLogger {
  warn: (message: string) => void;
  error: (message: string, err?: unknown) => void;
}

/** Injectable clock/timer seam — production defaults wrap the globals. */
export interface SchedulerDeps {
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  log: SchedulerLogger;
}

export type Trigger =
  | { kind: "interval"; everyMs: number }
  | { kind: "wallClock"; at: string; isMissed?: (date: string) => boolean };

export interface JobRegistration {
  id: string;
  trigger: Trigger;
  /** Retry-safe domain action, owned by the registrant (INV-06 stays domain-side). */
  action: (arg?: unknown) => unknown | Promise<unknown>;
  /** Activity predicate seam (AC-07/INV-07); default always-active. */
  isActive?: () => boolean;
}

export interface StopHandle {
  /** Idempotent: clears the job's timer, awaits its in-flight/pending run, and — once fully
   * drained — DEREGISTERS the job: the
   * daily-briefing settings write path needs to stop and re-`registerJob` the SAME job id
   * after a `generation_time` edit, since this scheduler captures `trigger.at` at registration
   * and exposes no update op. Removing the entry lets a later `registerJob(sameId)` call
   * register the updated job instead of throwing
   * "already registered". Full removal is deferred until AFTER the drain
   * completes, so `getJobState`/`requireState` still see the (disposed) entry for the entire
   * in-flight-run window, matching every pre-existing observation of a job mid-stop.
   */
  stop: () => Promise<void>;
}

/** `"failed"`: a MANUAL (`runJobNow`) invocation whose action threw. Only the
 * manual entry point ever sees this — scheduled/catch-up fires still fully swallow a throw
 * (FR-008 containment: `executeGuarded` always resolves, never rejects) and only ever record it
 * in `getJobState(id).lastError` + logs, exactly as before. `error` is the raw thrown value
 * (never re-serialized/typed here — the scheduler core stays domain-agnostic, INV-01/03/08, so
 * it cannot know about a caller's own error classes like `DailyBriefingValidationError`); the
 * caller decides how to map it (e.g. `handleDailyBriefingError`'s existing `instanceof` check).
 */
export type RunJobResult =
  | { status: "completed"; result: unknown }
  | { status: "already_running" }
  | { status: "failed"; error: unknown };

export interface JobRuntimeState {
  lastRunAt: number | null;
  lastError: string | null;
}

export interface Scheduler {
  registerJob(reg: JobRegistration): StopHandle;
  runJobNow(id: string, arg?: unknown): Promise<RunJobResult>;
  /** Arms every registered trigger + runs the catch-up sweep. Idempotent-ish: only the first call arms. */
  start(): Promise<void>;
  /** Idempotent drain: clears timers, rejects new acquisitions, awaits in-flight/pending work. */
  stop(): Promise<void>;
  /** Await only the named jobs' current runs, bounded by the injected absolute deadline. */
  drainJobs(
    ids: readonly string[],
    deadline: { readonly expiresAt: string }
  ): Promise<"drained" | "expired">;
  /** Restart after a restore re-arms every still-registered, non-disposed
   * job's trigger after a prior `stop` has fully drained, THEN runs the SAME startup catch-up
   * sweep `start` runs. A restore can install an OLDER database missing recent backups, making catch-up MORE warranted
   * here than at a normal boot, never less; the contract's own Behaviors section frames catch-up
   * as domain-state-driven precisely so "irregular kiosk uptime never silently skips a backup" —
   * a restore's quiesce window is exactly that kind of irregular uptime gap). Each wall-clock
   * job's PENDING (never-fired) target is reset before re-arming, for the same reason: leaving it
   * in place would anchor the re-arm's baseline on that still-future target and always compute
   * the occurrence AFTER it, silently dropping the one `stop` interrupted — on EVERY restore,
   * regardless of time of day, not just ones that straddle midnight. A no-op unless the scheduler
   * is currently `stopped` (never call this instead of `start` on a fresh instance — `start`
   * remains the ONLY first-arm entry point: if this instance's `stopped` state was reached
   * WITHOUT ever having `start`'ed, this call instead returns
   * it to `"created"` — zero timers armed, zero catch-up, but no longer wedged at `"stopped"`
   * either, so a manual `runJobNow` keeps working). Never a process restart (ADR-017 §3) — this
   * only re-arms in-process timers on the SAME instance; no job re-registration occurs, so a job
   * disposed via its own `StopHandle.stop` before the quiesce stays disposed.
   */
  restart(): Promise<void>;
  getJobState(id: string): JobRuntimeState | undefined;
  /** True once `stop` has fully drained. Used by `initScheduler` to allow re-initialization. */
  isStopped(): boolean;
}

type TriggerKind = "manual" | "interval" | "wallClock" | "catchup";
type Lifecycle = "created" | "started" | "stopping" | "stopped";

interface JobState {
  reg: JobRegistration;
  running: Promise<unknown> | null;
  pendingPromise: Promise<void> | null;
  timer: unknown;
  lastRunAt: number | null;
  lastError: string | null;
  disposed: boolean;
  /** wallClock only: the instant the current/last arm targeted (hardening nit 1). */
  armedTargetMs: number | null;
}

let pluginJobLifecycleGate: (jobId: string) => boolean = () => true;

/** Core-owned lifecycle gate applied to every scheduler entry point, including manual runs. */
export function configurePluginJobLifecycleGate(
  gate: ((jobId: string) => boolean) | undefined
): void {
  pluginJobLifecycleGate = gate ?? (() => true);
}

function defaultLog(): SchedulerLogger {
  return {
    warn: (message: string) => console.warn(message),
    error: (message: string, err?: unknown) => console.error(message, err),
  };
}

export function createScheduler(overrides?: Partial<SchedulerDeps>): Scheduler {
  const deps: SchedulerDeps = {
    now: overrides?.now ?? (() => Date.now()),
    setTimeout: overrides?.setTimeout ?? ((cb, ms) => globalThis.setTimeout(cb, ms)),
    clearTimeout:
      overrides?.clearTimeout ??
      ((handle) =>
        globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0])),
    log: overrides?.log ?? defaultLog(),
  };

  const jobs = new Map<string, JobState>();
  let lifecycle: Lifecycle = "created";
  let stoppingPromise: Promise<void> | null = null;
  /** True only once `start` has actually transitioned this
   * instance out of `"created"`. Guards `restart` (below) from being a back-door FIRST arm —
   * without this, a scheduler that was `initScheduler`'d + `registerJob`'d but deliberately
   * never `start`'ed (the `SCHEDULER_DISABLED=1` posture, `src/server/index.ts`) could still be
   * armed by an UNRELATED `stop`+`restart` cycle: `backups/restore.ts`'s * `stopSchedulerIfPresent` stops whatever scheduler singleton it finds regardless of whether
   * it was ever started (`created` -> `stopped` is a normal `stop` transition), and
   * `restartSchedulerIfWasStopped` then unconditionally calls `restart` — which previously
   * guarded only on `lifecycle === "stopped"`, arming every job's trigger and running full
   * catch-up. A restore during the default e2e/dev posture would therefore defeat the kill-switch
   * entirely. `restart` now also requires `everStarted`, so a scheduler that never really
   * started stays inert through any number of stop/restart cycles.
   */
  let everStarted = false;

  function requireState(id: string): JobState {
    const state = jobs.get(id);
    if (!state) {
      throw new Error(`Scheduler: unknown job "${id}"`);
    }
    return state;
  }

  /** The single choke point every trigger kind funnels through:
   * synchronous check-and-set of the per-job guard, closing the
   * two-simultaneous-triggers race. Collision handling differs by kind:
   * manual → already_running; interval tick → skip+log; wall-clock/catch-up
   * → coalesce-one (dedupe on a shared pending promise, executed exactly
   * once when the guard releases).
   */
  function runGuarded(
    id: string,
    kind: TriggerKind,
    arg: unknown
  ): Promise<RunJobResult | undefined> {
    const state = requireState(id);

    if (state.disposed || lifecycle === "stopping" || lifecycle === "stopped") {
      return kind === "manual"
        ? Promise.resolve<RunJobResult>({ status: "already_running" })
        : Promise.resolve(undefined);
    }

    const active = pluginJobLifecycleGate(id) && (state.reg.isActive ? state.reg.isActive() : true);
    if (!active) {
      return kind === "manual"
        ? Promise.resolve<RunJobResult>({ status: "already_running" })
        : Promise.resolve(undefined);
    }

    if (state.running) {
      if (kind === "manual") {
        return Promise.resolve<RunJobResult>({ status: "already_running" });
      }
      if (kind === "interval") {
        deps.log.warn(`Scheduler: job "${id}" tick skipped — previous run still in flight`);
        return Promise.resolve(undefined);
      }
      // wallClock or catchup: coalesce-one.
      if (!state.pendingPromise) {
        deps.log.warn(
          `Scheduler: job "${id}" wall-clock fire coalesced — previous run still in flight`
        );
        const blockingRun = state.running;
        state.pendingPromise = blockingRun
          .then(() => {
            // Re-check eligibility: the guard release can land after the scheduler began
            // stopping, after this job was individually disposed via its
            // stop handle, or after isActive flipped false — in every case
            // the deferred coalesced run must be skipped, not started.
            const stillEligible =
              !state.disposed &&
              lifecycle === "started" &&
              pluginJobLifecycleGate(id) &&
              (state.reg.isActive ? state.reg.isActive() : true);
            if (!stillEligible) return undefined;
            return executeGuarded(id, undefined);
          })
          .then(() => undefined)
          .finally(() => {
            state.pendingPromise = null;
          });
      }
      return state.pendingPromise.then(() => undefined);
    }

    return executeGuarded(id, arg).then((outcome) => {
      if (kind !== "manual") return undefined;
      return outcome.ok
        ? ({ status: "completed", result: outcome.result } as const)
        : ({ status: "failed", error: outcome.error } as const);
    });
  }

  /** Actually runs the action under the guard. Never REJECTS (FR-008 containment) — a thrown
   * action is always caught and reflected in the resolved `{ ok: false, error }` outcome instead,
   * so every caller (scheduled/catch-up fires included) can safely `.then` this without a
   * `.catch`. Only the MANUAL path (`runGuarded` above) actually inspects `ok`/`error` — a
   * scheduled/catch-up fire discards them the same way it always has, since `state.lastError` +
   * the log line right below remain the sole record for those paths; this used
   * to always resolve the bare `result`/`undefined`, indistinguishable from a real
   * `undefined`-returning success; the explicit `ok` flag removes that ambiguity for the manual
   * caller without changing anything for the non-manual ones).
   */
  function executeGuarded(
    id: string,
    arg: unknown
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: unknown }> {
    const state = requireState(id);
    const runPromise = Promise.resolve()
      .then(() => state.reg.action(arg))
      .then(
        (result): { ok: true; result: unknown } => {
          state.lastError = null;
          return { ok: true, result };
        },
        (err: unknown): { ok: false; error: unknown } => {
          const message = err instanceof Error ? err.message : String(err);
          state.lastError = message;
          deps.log.error(`Scheduler: job "${id}" action threw`, err);
          return { ok: false, error: err };
        }
      )
      .finally(() => {
        state.lastRunAt = deps.now();
        state.running = null;
      });
    state.running = runPromise;
    return runPromise;
  }

  function armInterval(id: string, opts: { immediate: boolean }): void {
    const state = jobs.get(id);
    if (!state || state.disposed || lifecycle !== "started") return;
    const trigger = state.reg.trigger as Extract<Trigger, { kind: "interval" }>;
    const delay = opts.immediate ? 0 : trigger.everyMs;
    state.timer = deps.setTimeout(() => {
      fireInterval(id).catch((err: unknown) =>
        deps.log.error(`Scheduler: job "${id}" interval tick failed unexpectedly`, err)
      );
    }, delay);
  }

  async function fireInterval(id: string): Promise<void> {
    await runGuarded(id, "interval", undefined);
    armInterval(id, { immediate: false });
  }

  function armWallClock(id: string): void {
    const state = jobs.get(id);
    if (!state || state.disposed || lifecycle !== "started") return;
    const trigger = state.reg.trigger as Extract<Trigger, { kind: "wallClock" }>;
    const tz = readHouseholdTimezone();
    // Anchor the re-arm baseline to the instant this job's arm last
    // targeted, never earlier (hardening nit 1): a re-arm called right
    // after a fire could read deps.now a few ms *before* the target that
    // just (nominally) fired, due to timer/clock skew — passing that raw
    // `now` to nextOccurrenceInTz would recompute the SAME occurrence
    // again and double-fire. Math.max closes that window; on the very
    // first arm (no prior target) this is just deps.now.
    const baseline = Math.max(deps.now(), state.armedTargetMs ?? -Infinity);
    const nextMs = nextOccurrenceInTz(trigger.at, tz, baseline);
    state.armedTargetMs = nextMs;
    const delay = Math.max(0, nextMs - deps.now());
    state.timer = deps.setTimeout(() => {
      fireWallClock(id).catch((err: unknown) =>
        deps.log.error(`Scheduler: job "${id}" wall-clock fire failed unexpectedly`, err)
      );
    }, delay);
  }

  async function fireWallClock(id: string): Promise<void> {
    await runGuarded(id, "wallClock", undefined);
    armWallClock(id);
  }

  function armJob(id: string): void {
    const state = jobs.get(id);
    if (!state || state.disposed) return;
    if (state.reg.trigger.kind === "interval") {
      armInterval(id, { immediate: true });
    } else {
      armWallClock(id);
    }
  }

  /** Domain-state-driven startup catch-up: a wall-clock job
   * with `isMissed` fires once, at start, if the household-local time is
   * already past `at` for today AND the domain reports today's output
   * missing. "Past `at`" is derived by reusing `nextOccurrenceInTz` itself:
   * if the next occurrence it computes has already rolled to a later
   * household-local date, today's window has closed.
   */
  async function runCatchupIfNeeded(id: string): Promise<void> {
    const state = jobs.get(id);
    if (!state || state.disposed) return;
    if (state.reg.trigger.kind !== "wallClock") return;
    const trigger = state.reg.trigger;
    if (!trigger.isMissed) return;

    const tz = readHouseholdTimezone();
    const nowMs = deps.now();
    const today = todayInHouseholdTz(nowMs);
    const nextOcc = nextOccurrenceInTz(trigger.at, tz, nowMs);
    const isPastToday = todayInHouseholdTz(nextOcc) !== today;

    if (isPastToday && trigger.isMissed(today)) {
      await runGuarded(id, "catchup", undefined);
    }
  }

  function registerJob(reg: JobRegistration): StopHandle {
    if (jobs.has(reg.id)) {
      throw new Error(`Scheduler: job "${reg.id}" is already registered`);
    }
    const state: JobState = {
      reg,
      running: null,
      pendingPromise: null,
      timer: null,
      lastRunAt: null,
      lastError: null,
      disposed: false,
      armedTargetMs: null,
    };
    jobs.set(reg.id, state);
    if (lifecycle === "started") {
      armJob(reg.id);
    }

    let stopPromise: Promise<void> | null = null;
    return {
      stop: () => {
        if (!stopPromise) {
          stopPromise = disposeJob(reg.id);
        }
        return stopPromise;
      },
    };
  }

  async function disposeJob(id: string): Promise<void> {
    const state = jobs.get(id);
    if (!state || state.disposed) return;
    state.disposed = true;
    if (state.timer !== null) {
      deps.clearTimeout(state.timer);
      state.timer = null;
    }
    await Promise.allSettled([state.running, state.pendingPromise]);
    // Deregister (cancel seam, see `StopHandle.stop`'s doc comment above): only
    // AFTER the drain settles, so every in-flight observer (`getJobState`, a coalesced fire's
    // `runGuarded` re-check) still sees the disposed entry throughout the wait — deletion only
    // frees the id for a FUTURE `registerJob` call, it changes nothing about this drain itself.
    jobs.delete(id);
  }

  function runJobNow(id: string, arg?: unknown): Promise<RunJobResult> {
    requireState(id); // fail loud on an unknown id
    return runGuarded(id, "manual", arg) as Promise<RunJobResult>;
  }

  async function start(): Promise<void> {
    if (lifecycle !== "created") return; // idempotent-ish: only the first call arms
    lifecycle = "started";
    everStarted = true;
    const ids = [...jobs.keys()];
    for (const id of ids) {
      armJob(id);
    }
    await Promise.all(ids.map((id) => runCatchupIfNeeded(id)));
  }

  async function stop(): Promise<void> {
    if (lifecycle === "stopped") return;
    if (lifecycle === "stopping") {
      await stoppingPromise;
      return;
    }
    lifecycle = "stopping";
    for (const state of jobs.values()) {
      if (state.timer !== null) {
        deps.clearTimeout(state.timer);
        state.timer = null;
      }
    }
    const inFlight: Promise<unknown>[] = [];
    for (const state of jobs.values()) {
      if (state.running) inFlight.push(state.running);
      if (state.pendingPromise) inFlight.push(state.pendingPromise);
    }
    stoppingPromise = Promise.allSettled(inFlight).then(() => {
      lifecycle = "stopped";
    });
    await stoppingPromise;
  }

  async function drainJobs(
    ids: readonly string[],
    deadline: { readonly expiresAt: string }
  ): Promise<"drained" | "expired"> {
    const pending = ids.flatMap((id) => {
      const state = jobs.get(id);
      if (!state) return [];
      return [state.running, state.pendingPromise].filter(
        (promise): promise is Promise<unknown> => promise !== null
      );
    });
    if (pending.length === 0) return "drained";

    const expiresAt = Date.parse(deadline.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= deps.now()) return "expired";

    let expiryTimer: unknown = null;
    const expiry = new Promise<"expired">((resolve) => {
      expiryTimer = deps.setTimeout(() => resolve("expired"), expiresAt - deps.now());
    });
    const completion = Promise.allSettled(pending).then(() => "drained" as const);
    const result = await Promise.race([completion, expiry]);
    if (result === "drained" && expiryTimer !== null) deps.clearTimeout(expiryTimer);
    return result;
  }

  function getJobState(id: string): JobRuntimeState | undefined {
    const state = jobs.get(id);
    if (!state) return undefined;
    return { lastRunAt: state.lastRunAt, lastError: state.lastError };
  }

  function isStopped(): boolean {
    return lifecycle === "stopped";
  }

  async function restart(): Promise<void> {
    if (lifecycle !== "stopped") return; // only meaningful after a full stop has landed
    // A scheduler stopped before its first start must not be armed by this call. Return it to
    // `"created"` instead of leaving it wedged at `"stopped"` — `runGuarded`'s manual path treats `"stopped"` as
    // terminal-refuse (`already_running`, see the top of this function's sibling), so every
    // subsequent MANUAL `runJobNow` (e.g. the admin daily-briefing "generate all" / backups
    // "snapshot now" routes) would silently break after the FIRST backup restore, staying
    // unusable until the whole process restarted. Returning to `"created"` instead keeps the
    // kill-switch invariant intact — `armJob`/`armInterval`/`armWallClock` all gate on
    // `lifecycle === "started"`, so zero timers get armed and zero catch-up runs — while
    // restoring exactly the pristine pre-`stop` state: manual calls fall through
    // `runGuarded`'s normal (non-blocked) path again, indistinguishable from a scheduler that was
    // simply never stopped in the first place.
    if (!everStarted) {
      lifecycle = "created";
      stoppingPromise = null;
      return;
    }
    lifecycle = "started";
    stoppingPromise = null;
    const ids = [...jobs.keys()];
    for (const id of ids) {
      const state = jobs.get(id);
      if (!state || state.disposed) continue;
      // Reset the PENDING (never-fired) wall-clock target before re-arming —
      // otherwise armWallClock's `baseline = max(now, armedTargetMs)` anchors on the stale
      // still-future target `stop` interrupted and always computes the occurrence AFTER it,
      // silently dropping the one that never fired. A no-op for interval jobs (unused field).
      state.armedTargetMs = null;
      armJob(id);
    }
    // A restore can install an OLDER database missing recent backups — catch-up is
    // MORE warranted here than at a normal boot, never less (mirrors start's own sweep).
    await Promise.all(ids.map((id) => runCatchupIfNeeded(id)));
  }

  return { registerJob, runJobNow, start, stop, drainJobs, getJobState, isStopped, restart };
}

let singleton: Scheduler | null = null;

/** Module singleton for the entrypoint + host-api. Throws on a
 * double-init while the previous instance is still live (hardening nit 2):
 * silently replacing it would leak that instance's armed timers, which keep
 * firing against a scheduler nothing references any more. Re-initializing
 * after the previous instance has fully `stop`ped is fine.
 */
export function initScheduler(overrides?: Partial<SchedulerDeps>): Scheduler {
  if (singleton && !singleton.isStopped()) {
    throw new Error("Scheduler: already initialized — call stop() before re-initializing");
  }
  singleton = createScheduler(overrides);
  return singleton;
}

export function getScheduler(): Scheduler {
  if (!singleton) {
    throw new Error("Scheduler: not initialized — call initScheduler() first");
  }
  return singleton;
}

/** A not-yet-initialized scheduler has no in-flight scheduled work to drain. */
export function drainScheduledJobs(
  ids: readonly string[],
  deadline: { readonly expiresAt: string }
): Promise<"drained" | "expired"> {
  return singleton?.drainJobs(ids, deadline) ?? Promise.resolve("drained");
}
