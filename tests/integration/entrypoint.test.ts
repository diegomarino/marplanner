import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { getDb, resetDb } from "../../src/server/db/client";
import { runMigrations } from "../../src/server/db/migrate";

/** — process-level assembly proof for the scheduler runnable skeleton
 * (Constitution XIII / ADR-059).
 * A logs-only boot proof is NOT sufficient: this spawns the REAL entrypoint
 * (`src/server/index.ts`, via `tsx` — no build step required) as its own
 * child process against a fresh temp DATA_DIR + a free ephemeral port, and
 * exercises ONE real register→fire→drain path through the fully assembled
 * stack (`initScheduler` → `registerJob` → `start` → wall-clock/interval
 * fire → `SIGTERM`/`SIGINT` → `stop` drain → `app.close` → exit).
 * Covers: (1) "scheduler started (N jobs)" on boot with SCHEDULER_SMOKE_JOB=1;
 * (2) the smoke job actually fires ("smoke job fired"); (3) SIGINT during a
 * slow smoke run drains before exiting cleanly (exit code 0), including
 * that the in-flight job's genuinely TWO-STEP write
 * (SCHEDULER_SMOKE_WRITE_PATH: two sequential files) lands with BOTH steps
 * complete — never only the first — before the process exits; (4)
 * SCHEDULER_DISABLED=1 logs "scheduler disabled" and starts no timers (the
 * smoke job never fires even when requested); (5) the server serves /health
 * while the scheduler is running.
 * Traces: BACKGROUND-JOBS-SCHEDULER-INV-06 (process-level drain: `stop`
 * AWAITS the in-flight run rather than interrupting it, so a multi-step
 * action's later steps are never dropped by a SIGINT arriving mid-run — the
 * "completes as a recoverable unit" branch of INV-06's contract wording,
 * docs/architecture/contracts/background-jobs-scheduler.md) — this file proves the
 * process-level start→fire→drain assembly. The other negative proofs (SC-006
 * schema table set = INV-03, zero bus events = INV-08, the full pure-reads
 * GET sweep = INV-05) are NOT asserted here; they land in the * `tests/boundary/migrate-runner.test.ts` and
 * `tests/integration/scheduler-lifecycle.test.ts`.
 * PROCESS-GROUP NOTE: this harness spawns node directly with `--import tsx`
 * (see `startEntrypoint` below) rather than the `tsx` CLI binary, so there is
 * only ONE process running the server — no wrapper/grandchild pair. `tsx`'s * loader can still spawn a persistent `esbuild --service` helper process for
 * transforms; `detached: true` keeps this test's spawn as the leader of its
 * own process group so `hardKill`/`signalGroup` can reach that helper too via
 * the negative-pid convention (`process.kill(-pid,...)`) — though empirically
 * it exits on its own once the parent's stdio pipes close, this is defense in
 * depth, mirroring the same reasoning that used to apply to the `tsx`-wrapper
 * case.
 * SIGNAL-RELAY RACE — CI flake (3rd occurrence, root-caused): running
 * via the `tsx` CLI binary (`node_modules/.bin/tsx`, the ORIGINAL shape of
 * this harness) means `tsx`'s CLI is itself a wrapper process that re-execs
 * node (with `--require preflight.cjs --import loader.mjs`) as a real OS
 * grandchild and forwards CATCHABLE signals down to it. That wrapper's own
 * signal handler (`node_modules/tsx/dist/cli.mjs`'s `relaySignalToChild`) is
 * NOT a simple pass-through: on receiving SIGINT/SIGTERM it waits up to 30ms
 * for the grandchild to self-report (via an IPC message its `--require`d
 * preflight shim sends the instant ITS OWN signal handler runs) that the
 * signal was received; if no report lands, it RE-SENDS the same signal
 * directly to the grandchild and waits ANOTHER 30ms; if that ALSO produces no
 * report — a 60ms total budget — the wrapper force-`SIGKILL`s the grandchild
 * outright and exits ITSELF with `128 + signum` (130 for SIGINT) once the
 * grandchild dies. This is a hard watchdog with no relation to how far the
 * grandchild's OWN graceful shutdown has progressed: if the OS doesn't
 * schedule the grandchild's event loop to run its (prepended) preflight
 * signal handler within that 60ms window — plausible under CI's tighter
 * CPU/IPC scheduling, not reproduced under local load — the wrapper kills it
 * mid-drain and reports exit code 130 on ITS OWN pid (the exact
 * `code=130, signal=null` shape observed), regardless of whether
 * `src/server/index.ts`'s own `shutdown` had already started draining. An
 * EARLIER fix (below) closed a DIFFERENT race in this same mechanism —
 * `src/server/index.ts` used to register its shutdown handlers with
 * `process.once`, which self-removes after the first delivery, so the
 * preflight shim's OWN hidden, prepended listener (which force-`exit`s the
 * instant the REAL listener count for that signal hits zero) would kill the
 * grandchild on a REDELIVERED signal that found zero real listeners left.
 * That fix (switching to `process.on` + an idempotency guard, so a
 * redelivered signal is always a safe no-op) remains correct and necessary,
 * but it cannot help here: the 60ms watchdog above kills the grandchild
 * BEFORE any redelivery even matters, and it lives entirely inside `tsx`'s * vendored wrapper (`node_modules/tsx/dist/{cli,preflight}.{cjs,mjs}`) —
 * nothing this repo's own signal handling can observe or extend. No amount
 * of readiness-handshaking on the SENDING side (this test already waits for
 * "smoke job started" before signaling — see below) can close a race that
 * happens entirely AFTER the signal is sent.
 * THE FIX: stop spawning the `tsx` CLI binary at all. `startEntrypoint` below
 * spawns `node --import tsx <entry>` directly — `tsx`'s package.json exports
 * its loader (`dist/loader.mjs`) as the `"."` conditional specifically for
 * this usage. This is the SAME `--require`-free loader hook `tsx`'s own CLI
 * registers internally, minus the wrapper process and its preflight/relay
 * machinery — there is no longer a second process racing an IPC report
 * against a kill timer, so SIGINT/SIGTERM are delivered by the OS straight to
 * the actual entrypoint process running `src/server/index.ts`, which handles
 * them itself (`process.on` + the idempotency guard, unchanged) with no
 * external watchdog able to pre-empt the drain. Verified empirically
 * (manual repro against this exact env/args shape): the old `tsx`-CLI spawn
 * reproduces the wrapper's `relaySignalToChild` codepath on every run (harmless
 * when the report lands inside 30ms, which is the overwhelmingly common case
 * — hence "passes on rerun"); the `--import`-based spawn has no such codepath
 * to race in the first place, closing the window rather than narrowing it.
 * The drain test below additionally waits for the "scheduler drained" log
 * itself (bounded) before reading final output, rather than only racing the
 * child's `exit` event, as defense in depth.
 * network-devices.poll's test-runtime throw: the filed hypothesis floated
 * this job's `createUniFiClient` throw (a spawned child inherits `VITEST=
 * true` from the parent test process, so `isTestRuntime` is always true
 * here) as possibly perturbing drain sequencing. Traced and ruled out: the
 * poller is an INTERVAL trigger armed with `{immediate: true}`
 * (`src/server/scheduler/index.ts` `armInterval`), which schedules its first
 * fire via a plain 0ms `setTimeout` — it fires once, at boot, as part of the
 * SAME timer-phase burst as every other interval job (including the smoke
 * job itself), fully settles (the throw is synchronous inside an `async`
 * action, so it becomes an already-caught rejected promise within the same
 * microtask turn), and never fires again within this test's lifetime (its
 * `POLL_INTERVAL_MS` is 60s, far longer than the whole test). It shares no
 * state, job id, or in-flight promise with the smoke job, so by the time
 * "smoke job started" prints — which only happens once `scheduler.start`
 * has already returned and a LATER 0ms tick has fired — the poller's one
 * action has already resolved. It appearing in a failure's dumped stderr
 * merely reflects that ALL boot-time logs necessarily precede a LATER exit,
 * not causal proximity to the SIGINT; no change was needed here.
 * REVIEW C3 — not independently tested here, documented per that
 * finding's own escape hatch: `src/server/index.ts`'s `startScheduler` now
 * `publish`es the scheduler instance to `main`'s shutdown closure BEFORE
 * `await scheduler.start` runs, instead of only after `startScheduler`'s * whole promise resolves — closing a window where a SIGINT/SIGTERM arriving
 * during `start`'s own startup catch-up sweep (a REAL write when a
 * wall-clock job's `isMissed` predicate is true on boot, e.g. the * backups job on a never-backed-up instance booting past 03:30
 * household-local) would previously find `scheduler === null` and skip
 * `stop` entirely. The EXISTING "SIGINT during a slow smoke run" test
 * below does NOT exercise this specific window: the smoke job is an
 * INTERVAL trigger, armed with a 0ms timer INSIDE `start` but fired on a
 * LATER tick — by the time its action is ever running, `scheduler.start`
 * has already fully resolved and `startScheduler`'s promise has already
 * returned, so `scheduler` would have been assigned even under the OLD
 * (pre-C3) code. Reproducing the true race deterministically would require
 * a WALL-CLOCK job whose `isMissed` predicate is forced true and whose
 * action is artificially slowed DURING `start`'s own
 * `Promise.all(ids.map(runCatchupIfNeeded))` await — no such seam exists in
 * this entrypoint today (the smoke job is interval-only), and inventing one
 * purely for this test would add production-only test surface out of
 * proportion to a P2 process-lifecycle hardening fix. Relying on the
 * structural change instead: see `startScheduler`'s own doc comment in
 * `src/server/index.ts` for the full rationale.
 */

const SERVER_ENTRY = resolve(process.cwd(), "src", "server", "index.ts");
const HEALTH_TIMEOUT_MS = 20_000;
const LOG_WAIT_TIMEOUT_MS = 10_000;

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "localhost", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolvePort(port));
      } else {
        srv.close(() => reject(new Error("could not reserve a free port")));
      }
    });
  });
}

interface Booted {
  child: ChildProcess;
  /** Accumulated stdout+stderr so far. */
  output: () => string;
  /** Resolves once `pattern` appears in the combined output, or rejects on timeout/early exit. */
  waitForLog: (pattern: string, timeoutMs?: number) => Promise<void>;
  /** Resolves with { code, signal } once the child has exited. */
  waitForExit: () => Promise<{ code: number | null; signal: string | null }>;
}

function activateDailyBriefingFixture(dataDir: string): void {
  const previousDataDir = process.env.DATA_DIR;
  const previousDatabasePath = process.env.DATABASE_PATH;
  try {
    process.env.DATA_DIR = dataDir;
    process.env.DATABASE_PATH = "marplanner.db";
    resetDb();
    runMigrations();
    getDb()
      .prepare(
        "UPDATE plugin_activation_registry SET state = 'active' WHERE plugin_id = 'daily-briefing'"
      )
      .run();
  } finally {
    resetDb();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
  }
}

/** Send `signal` to the whole process group the (detached) child leads, so it
 * reaches any transforms helper `tsx`'s loader spawns too — see the
 * PROCESS-GROUP NOTE above. Falls back to signaling the child directly if the
 * group send fails (e.g. the group is already gone).
 */
function signalGroup(child: ChildProcess, signal: "SIGKILL" | "SIGINT" | "SIGTERM"): void {
  if (typeof child.pid !== "number") return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    } catch {
      // already gone — nothing to signal
    }
  }
}

/** Spawn the real entrypoint (no build required) against a given port +
 * DATA_DIR, resolving once GET /health answers. Runs `node --import tsx
 * <entry>` DIRECTLY — never the `tsx` CLI binary — per the SIGNAL-RELAY RACE
 * note above: the CLI is itself a wrapper that re-execs a grandchild node
 * process and races a 60ms watchdog against that grandchild self-reporting
 * signal receipt, which under CI load can SIGKILL the grandchild mid-drain
 * and report a misleading exit on the WRAPPER's own pid. `--import
 * tsx` registers the exact same loader hooks in THIS process instead, so
 * there is no wrapper/grandchild pair and no relay to race — SIGINT/SIGTERM
 * reach the real entrypoint directly. `detached: true` still makes this
 * process the leader of its own process group (see the PROCESS-GROUP NOTE)
 * so `hardKill`/`signalGroup` can reach `tsx`'s persistent `esbuild
 * --service` transform helper too. stdout+stderr are both piped and
 * accumulated so tests can assert on the assembly's log lines (unlike the
 * e2e helper, which discards stdout — this test's whole point is observing
 * those logs).
 */
async function startEntrypoint(
  port: number,
  dataDir: string,
  extraEnv: Record<string, string> = {}
): Promise<Booted> {
  const child = spawn(process.execPath, ["--import", "tsx", SERVER_ENTRY], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "localhost",
      DATA_DIR: dataDir,
      DATABASE_PATH: "marplanner.db",
      // Pinned so the base env never inherits an ambient SCHEDULER_DISABLED
      // from the caller's shell; placed BEFORE `...extraEnv` so a test that
      // explicitly requests SCHEDULER_DISABLED=1 still wins.
      SCHEDULER_DISABLED: "0",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  let buffer = "";
  child.stdout?.on("data", (d: Buffer) => {
    buffer += String(d);
  });
  child.stderr?.on("data", (d: Buffer) => {
    buffer += String(d);
  });

  const exitState: { done: boolean; code: number | null; signal: string | null } = {
    done: false,
    code: null,
    signal: null,
  };
  let exitResolvers: Array<(v: { code: number | null; signal: string | null }) => void> = [];
  child.once("exit", (code, signal) => {
    exitState.done = true;
    exitState.code = code;
    exitState.signal = signal;
    for (const resolveFn of exitResolvers) resolveFn({ code, signal });
    exitResolvers = [];
  });

  function waitForExit(): Promise<{ code: number | null; signal: string | null }> {
    if (exitState.done) return Promise.resolve({ code: exitState.code, signal: exitState.signal });
    return new Promise((resolveFn) => exitResolvers.push(resolveFn));
  }

  async function waitForLog(pattern: string, timeoutMs = LOG_WAIT_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (buffer.includes(pattern)) return;
      if (exitState.done) {
        throw new Error(
          `child exited (code=${exitState.code}, signal=${exitState.signal}) before log "${pattern}" appeared. output:\n${buffer}`
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timed out waiting for log "${pattern}". output so far:\n${buffer}`);
  }

  try {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exitState.done) {
        throw new Error(
          `entrypoint exited before becoming healthy on :${port} (code=${exitState.code}, signal=${exitState.signal}). output:\n${buffer}`
        );
      }
      try {
        const res = await fetch(`http://localhost:${port}/health`);
        if (res.ok) {
          return { child, output: () => buffer, waitForLog, waitForExit };
        }
      } catch {
        // not accepting connections yet — keep polling
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(
      `entrypoint on :${port} never became healthy within ${HEALTH_TIMEOUT_MS}ms. output:\n${buffer}`
    );
  } catch (err) {
    await hardKill(child);
    throw err;
  }
}

/** Force-kill helper for cleanup — never leaves a (grand)child process leaked. */
async function hardKill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    signalGroup(child, "SIGKILL");
    return;
  }
  const exited = new Promise<void>((res) => child.once("exit", () => res()));
  signalGroup(child, "SIGKILL");
  await exited;
}

describe("entrypoint — scheduler runnable skeleton", () => {
  let activeChild: ChildProcess | null = null;
  let activeDataDir: string | null = null;

  afterEach(async () => {
    // Hard-timeout safety: never leak a spawned process across tests, even
    // if an assertion above threw before the test's own cleanup ran.
    if (activeChild) {
      await hardKill(activeChild);
      activeChild = null;
    }
    if (activeDataDir) {
      try {
        rmSync(activeDataDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
      activeDataDir = null;
    }
  });

  it("SCHEDULER_SMOKE_JOB=1: registers the calendar feed job, fires the smoke job, and serves /health meanwhile", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mp-entrypoint-"));
    activeDataDir = dataDir;
    const port = await getFreePort();

    const booted = await startEntrypoint(port, dataDir, { SCHEDULER_SMOKE_JOB: "1" });
    activeChild = booted.child;

    // 6 jobs: the always-registered daily-briefing job, the
    // always-registered telemetry retention-prune job, the
    // always-registered backups nightly-snapshot job, the
    // always-registered network-devices poller job, plus
    // calendar-feed polling job, and this test's requested smoke job.
    //
    // daily-briefing's and telemetry's catch-up sweeps stay vacuously false
    // here regardless of wall-clock time — the fresh temp DATA_DIR has zero
    // opted-in members and zero client_log rows. Backups' `isMissed` is
    // DIFFERENT: a fresh DATA_DIR also has zero backup files, so it is
    // genuinely TRUE whenever real household-local wall-clock time is
    // currently past 03:30 today (see `src/server/backups/job.ts`'s doc
    // comment) — by design, a never-backed-up kiosk gets an immediate
    // catch-up snapshot. That catch-up, if it fires, runs a real
    // `getDb.backup` against this test's freshly-migrated temp DB
    // (migrations already applied by `runMigrations` before `app.listen`)
    // as part of this very `scheduler.start` call, strictly BEFORE
    // "scheduler started (6 jobs)" is logged — it does not affect this
    // test's assertions (no assertion inspects the backups shelf), only
    // whether this run happens to take a few extra ms for a real backup
    // write depending on what time of day CI executes it. The
    // network-devices poller job is an INTERVAL trigger (
    // "run-on-startup + interval") — it fires once immediately on
    // `scheduler.start`, calls `getUniFiClient`, finds no `unifi.*`
    // operator config in this test's env, and its production factory
    // additionally throws under `isTestRuntime` — this spawned child
    // inherits `VITEST=true` from the parent test process (`startEntrypoint`
    // spreads `...process.env`), so the very first poll tick throws inside
    // the job's own action; the scheduler's `executeGuarded` never lets an
    // action's rejection propagate (FR-008 containment) — it is caught and
    // logged, never crashing the process or affecting this test's
    // assertions (none of which inspect stderr content).
    await booted.waitForLog("scheduler started (6 jobs)");
    await booted.waitForLog("smoke job fired");

    // (5) the server keeps serving /health while the scheduler runs.
    const healthRes = await fetch(`http://localhost:${port}/health`);
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toEqual({ status: "ok" });

    await hardKill(booted.child);
    activeChild = null;
  }, 30_000);

  it("BACKGROUND-JOBS-SCHEDULER-INV-06: SIGINT during a slow smoke run drains the in-flight job's two-step write to completion before exiting cleanly", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mp-entrypoint-"));
    activeDataDir = dataDir;
    const port = await getFreePort();
    const slowMs = 1500;
    // (INV-06): a genuinely TWO-STEP write — `writePath` then
    // `writePath + ".second"` (src/server/index.ts), both performed AFTER
    // the slow delay but BEFORE logging "smoke job fired". Reading BOTH back
    // post-exit proves the multi-step action completed as a recoverable
    // unit: `stop` awaits the in-flight run rather than interrupting it,
    // so a SIGINT arriving mid-run never leaves only the FIRST step's effect
    // behind while dropping the second.
    const writePath = join(dataDir, "smoke-write-proof.txt");
    const secondWritePath = `${writePath}.second`;
    const EXPECTED_FIRST_CONTENT = "smoke job write complete\n";
    const EXPECTED_SECOND_CONTENT = "smoke job second write complete\n";

    const booted = await startEntrypoint(port, dataDir, {
      SCHEDULER_SMOKE_JOB: "1",
      SCHEDULER_SMOKE_SLOW_MS: String(slowMs),
      SCHEDULER_SMOKE_WRITE_PATH: writePath,
    });
    activeChild = booted.child;

    // The interval trigger runs on startup. Wait for the
    // action's own start log rather than "scheduler started" — that proves
    // the action is provably in flight (not just that it *should* be by
    // now), with no wall-clock assumption.
    await booted.waitForLog("smoke job started");
    const beforeSignal = booted.output();
    expect(beforeSignal).not.toContain("smoke job fired");
    // Both writes happen only after the slow delay elapses (still in
    // flight here, mid-delay) — neither must exist yet.
    expect(existsSync(writePath)).toBe(false);
    expect(existsSync(secondWritePath)).toBe(false);

    signalGroup(booted.child, "SIGINT");

    // Wait for the drain log itself (bounded) BEFORE reading final output or
    // waiting on process exit — this decouples the assertion from any race
    // between the child's `exit` event and its stdout/stderr pipes finishing
    // delivery of buffered data (see the SIGNAL-RELAY RACE note above).
    await booted.waitForLog("scheduler drained");

    const { code, signal } = await booted.waitForExit();

    // Drain proof: the in-flight action's completion log, then the drain
    // log, both appear IN THAT ORDER — a premature exit would either omit
    // "smoke job fired" entirely or reorder it after "scheduler drained",
    // proving stop does NOT await the in-flight run.
    const output = booted.output();
    expect(output).toContain("smoke job fired");
    expect(output.indexOf("smoke job fired")).toBeLessThan(output.indexOf("scheduler drained"));

    // (INV-06) — the stronger, non-log proof: BOTH of the action's real
    // writes landed on disk, byte-exact, before the process exited. A run
    // truncated after only the first step (the failure mode this guards
    // against) would fail the second file's existence check.
    expect(existsSync(writePath)).toBe(true);
    expect(readFileSync(writePath, "utf-8")).toBe(EXPECTED_FIRST_CONTENT);
    expect(existsSync(secondWritePath)).toBe(true);
    expect(readFileSync(secondWritePath, "utf-8")).toBe(EXPECTED_SECOND_CONTENT);

    expect(code).toBe(0);
    expect(signal).toBeNull();

    await hardKill(booted.child);
    activeChild = null;
  }, 30_000);

  it("SCHEDULER_DISABLED=1 logs 'scheduler disabled' and starts no timers (the smoke job never fires)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mp-entrypoint-"));
    activeDataDir = dataDir;
    const port = await getFreePort();

    // Request the smoke job too — disabled must win, proving this is a
    // real kill-switch and not merely "no job was registered".
    const booted = await startEntrypoint(port, dataDir, {
      SCHEDULER_DISABLED: "1",
      SCHEDULER_SMOKE_JOB: "1",
    });
    activeChild = booted.child;

    await booted.waitForLog("scheduler disabled");

    // Give a run-soon interval job every opportunity to have fired by now
    // if the kill-switch were leaky.
    await new Promise((r) => setTimeout(r, 500));

    const output = booted.output();
    expect(output).toContain("scheduler disabled");
    expect(output).not.toContain("scheduler started");
    expect(output).not.toContain("smoke job fired");

    const healthRes = await fetch(`http://localhost:${port}/health`);
    expect(healthRes.status).toBe(200);

    await hardKill(booted.child);
    activeChild = null;
  }, 30_000);

  it("#633: SCHEDULER_DISABLED=1 still lets a manual runJobNow call (the admin daily-briefing generate-all route) succeed instead of 500ing, and starts no timers", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mp-entrypoint-"));
    activeDataDir = dataDir;
    const port = await getFreePort();
    const bootstrapKey = "mpk-e2e-entrypoint-633-key";
    activateDailyBriefingFixture(dataDir);

    // Request the smoke job too — proving the kill-switch still arms zero timers even though
    // the scheduler singleton is now initialized under this env (fix).
    const booted = await startEntrypoint(port, dataDir, {
      SCHEDULER_DISABLED: "1",
      SCHEDULER_SMOKE_JOB: "1",
      MP_BOOTSTRAP_KEY: bootstrapKey,
    });
    activeChild = booted.child;

    await booted.waitForLog("scheduler disabled");

    // Before the fix, this request hit `getScheduler` (never initialized under this env)
    // inside the generate-all route's `runJobNow` call — an uncaught throw mapped by the route's
    // catch-all to an opaque 500 `internal_error`. A fresh temp DATA_DIR has zero opted-in
    // members, so a successful run is a genuine no-op: 200 with an empty generated batch.
    const res = await fetch(`http://localhost:${port}/api/daily-briefing/generate-all`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `mp_device_key=${bootstrapKey}`,
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "completed", count: 0, generated: [] });

    // Give a run-soon interval job every opportunity to have fired by now if the manual call
    // above somehow left the scheduler armed.
    await new Promise((r) => setTimeout(r, 500));

    const output = booted.output();
    expect(output).toContain("scheduler disabled");
    expect(output).not.toContain("scheduler started");
    expect(output).not.toContain("smoke job fired");

    await hardKill(booted.child);
    activeChild = null;
  }, 30_000);
});
