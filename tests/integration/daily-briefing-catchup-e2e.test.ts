import { execSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getDb, resetDb } from "../../src/server/db/client";
import { runMigrations } from "../../src/server/db/migrate";
import { todayInHouseholdTz } from "../../src/server/lib/household-date";
import { hashKey } from "../../src/server/auth/credentials";
import { DEVICE_COOKIE } from "../../src/server/auth/cookies";
import type { BriefingReadResult } from "../../src/shared";

/** — MANDATORY carry-forward from the independent no
 * current green CI path exercises the enabled-scheduler branch of the
 * esbuild-bundled server output (`dist/server/index.js`) — every other
 * scheduler process test (`tests/integration/entrypoint.test.ts`) boots
 * via `tsx` against `src/server/index.ts` directly, never the built bundle.
 * This repo has already been burned once by a CI-only ESM interop break
 * inside the esbuild bundle (the `rrule` default-import fix, memory gotcha
 * `cjs-dep-esm-interop-ci-only`) that a tsx-sourced test could never catch.
 * This test therefore:
 * 1. runs `npm run build` in its own setup so `dist/server/index.js`
 * reflects the CURRENT worktree (never assumes a stale prior build);
 * 2. spawns `node dist/server/index.js` directly — never `tsx`;
 * 3. boots with the scheduler ENABLED, unlike the shared playwright
 * webServer (which sets `SCHEDULER_DISABLED=1` specifically because
 * this dedicated file exists — see `playwright.config.ts`'s comment);
 * 4. seeds an opted-in active member + a `daily-briefing` settings object
 * with `generationTime: "00:00"` (seam) BEFORE boot, so the
 * household-local time is deterministically past "00:00" the instant
 * the process starts, at any realistic wall-clock boot time — the
 * startup catch-up sweep fires with no wait and no
 * dependency on what hour the test happens to run;
 * 5. seeds a `locale` settings row pinning the household tz to a
 * NO-DST, fixed-offset `Etc/GMT±N` zone chosen at runtime so the
 * household-local time sits at ~midday — see `middayFixedOffsetTz`
 * below. Without this, a real run starting within a few minutes of
 * real-UTC local midnight could compute `today` (via
 * `todayInHouseholdTz`, called once before boot) on one side of the
 * household-local date boundary while the child process's OWN internal
 * clock — which keeps ticking during boot/DB-seed/HTTP-poll — crosses
 * to the other side before generation actually happens, making the
 * read 404 on a date the child never wrote (midnight-
 * rollover race). Pinning to local midday makes that boundary
 * hours away, not seconds.
 * Traces: DAILY-BRIEFING-AC-10 (scheduled/catch-up generation runs on
 * startup catch-up when missed same-date), BACKGROUND-JOBS-SCHEDULER-AC-03
 * (the wall-clock trigger arms and fires through the assembled entrypoint),
 * -AC-04 (the catch-up sweep fires past-time+missing), -INV-04 (wall-clock
 * jobs fire on household-local time, DST-correct — this is the built-bundle
 * proof that `nextOccurrenceInTz` ships correctly through esbuild, not a
 * re-derivation of the math itself, already unit-proven in /),
 * -INV-03 (no scheduler-owned persistence: the read below returns the
 * daily-briefing module's own row via its own read route, never scheduler
 * state — the scheduler itself never touches a table).
 * PROCESS-GROUP / SIGKILL note: mirrors `tests/integration/entrypoint.test.ts`
 * — `detached: true` + negative-pid `process.kill(-pid,...)` so a
 * SIGKILL reaches the whole process group, not just the immediate child.
 * `node dist/server/index.js` has no `tsx` wrapper layer, but the same
 * defense-in-depth costs nothing and keeps this file self-contained.
 */

const NODE_BIN = process.execPath;
const BUILT_ENTRY = resolve(process.cwd(), "dist", "server", "index.js");

/** A no-DST, fixed-offset IANA zone whose local time is ~midday RIGHT NOW —
 * closes the midnight-rollover race (see the file doc comment
 * above). `Etc/GMT` names are POSIX-inverted: `Etc/GMT-N` is UTC+N and
 * `Etc/GMT+N` is UTC-N — the sign flip is deliberate, not a typo.
 */
function middayFixedOffsetTz(): string {
  const n = 12 - new Date().getUTCHours();
  return `Etc/GMT${n <= 0 ? "+" + -n : "-" + n}`;
}
const HEALTH_TIMEOUT_MS = 20_000;
const BUILD_TIMEOUT_MS = 180_000;

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

function signalGroup(child: ChildProcess, signal: "SIGKILL"): void {
  if (typeof child.pid !== "number") return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone — nothing to signal
    }
  }
}

async function hardKill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((res) => child.once("exit", () => res()));
  signalGroup(child, "SIGKILL");
  await Promise.race([exited, new Promise<void>((res) => setTimeout(res, 5_000))]);
}

interface Booted {
  child: ChildProcess;
  output: () => string;
  waitForLog: (pattern: string, timeoutMs?: number) => Promise<void>;
}

async function startBuiltEntrypoint(
  port: number,
  dataDir: string,
  extraEnv: Record<string, string> = {}
): Promise<Booted> {
  const child = spawn(NODE_BIN, [BUILT_ENTRY], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "localhost",
      DATA_DIR: dataDir,
      DATABASE_PATH: "marplanner.db",
      // Pinned before `...extraEnv` so the base env never leaks an ambient
      // SCHEDULER_DISABLED from the caller's shell — this file's whole point
      // is the scheduler-ENABLED path.
      SCHEDULER_DISABLED: "0",
      //: this spawn's `...process.env` spread ALREADY inherits
      // `VITEST=true` from the vitest worker process, which is what makes
      // `isTestRuntime` (src/server/host-api/index.ts) true in the CHILD too — that in turn
      // is what makes `resolveQuoteSource`/`resolveOnThisDaySource`
      // (modules/daily-briefing/index.ts) resolve to `null` instead of the real
      // zenQuotesSource/wikipediaOnThisDaySource adapters, so this test performs zero real
      // egress today. That protection was previously INCIDENTAL (it survives only as long as
      // nobody trims the `...process.env` spread) — pinned here explicitly so it's load-bearing
      // and self-documenting instead. Do NOT add QUOTE_ENDPOINT/ONTHISDAY_ENDPOINT here: no
      // fixture server runs in this vitest context, so the null-source path (not a fixture) is
      // the correct protection.
      VITEST: "true",
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
  child.once("exit", (code, signal) => {
    exitState.done = true;
    exitState.code = code;
    exitState.signal = signal;
  });

  async function waitForLog(pattern: string, timeoutMs = HEALTH_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs; // polling deadline only — never used inside an expect
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
    const deadline = Date.now() + HEALTH_TIMEOUT_MS; // polling deadline only
    while (Date.now() < deadline) {
      if (exitState.done) {
        throw new Error(
          `entrypoint exited before becoming healthy on :${port} (code=${exitState.code}, signal=${exitState.signal}). output:\n${buffer}`
        );
      }
      try {
        const res = await fetch(`http://localhost:${port}/health`);
        if (res.ok) {
          return { child, output: () => buffer, waitForLog };
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
    signalGroup(child, "SIGKILL");
    throw err;
  }
}

describe("daily-briefing catch-up — built-bundle process boot", () => {
  let activeChild: ChildProcess | null = null;
  let activeDataDir: string | null = null;

  beforeAll(() => {
    // Builds the CURRENT worktree's dist/ — required per the mandatory
    // carry-forward above, so a stale or absent build can never mask this
    // test exercising the real bundled output.
    execSync("npm run build", {
      cwd: process.cwd(),
      stdio: "inherit",
      timeout: BUILD_TIMEOUT_MS,
    });
  }, BUILD_TIMEOUT_MS + 10_000);

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

  it(
    "DAILY-BRIEFING-AC-10 / BACKGROUND-JOBS-SCHEDULER-AC-03 / -AC-04 / -INV-04 / -INV-03: a scheduler-enabled boot catches up today's briefing for an opted-in member",
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "mp-catchup-e2e-"));
      activeDataDir = dataDir;
      const port = await getFreePort();
      const runTag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const memberId = `member-catchup-${runTag}`;
      const deviceKey = `mpk-catchup-${runTag}`;
      const tz = middayFixedOffsetTz();

      // Seed the DB file BEFORE spawning the child: the household-local
      // opt-in state + "00:00" briefing time must already be in place when
      // the child's own startup catch-up sweep runs, or the
      // sweep would see zero candidates and never fire. Migrations are
      // idempotent (`drizzle_universe_migrations` bookkeeping), so the
      // child re-running them against this same file on boot is a no-op.
      const prevDataDir = process.env.DATA_DIR;
      const prevDbPath = process.env.DATABASE_PATH;
      process.env.DATA_DIR = dataDir;
      process.env.DATABASE_PATH = "marplanner.db";
      resetDb();
      runMigrations();
      const now = Date.now();
      const db = getDb();
      db.prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
      ).run(`device-${runTag}`, hashKey(deviceKey), now);
      db.prepare(
        "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, 'Catchup Kid', 'child', 'active', ?, ?)"
      ).run(memberId, now, now);
      db.prepare(
        "INSERT INTO daily_briefing_optin (member_id, enabled, created_at, updated_at) VALUES (?, 1, ?, ?)"
      ).run(memberId, now, now);
      db.prepare(
        "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('daily-briefing', ?, ?)"
      ).run(JSON.stringify({ generationTime: "00:00" }), now);
      db.prepare(
        "UPDATE plugin_activation_registry SET state = 'active', activated_at = ?, updated_at = ? WHERE plugin_id = 'daily-briefing'"
      ).run(new Date(now).toISOString(), new Date(now).toISOString());
      // Pin the household tz to a no-DST, fixed-offset zone whose local time
      // is ~midday right now (review — midnight-rollover race, see the
      // file doc comment above). Both this test's own `today` computation
      // below AND the spawned child read this SAME row via
      // `readHouseholdTimezone`, so they stay consistent by construction.
      db.prepare(
        "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('locale', ?, ?)"
      ).run(JSON.stringify({ timezone: tz }), now);
      // Business-date resolution — needed to know WHICH date the live child
      // process will resolve "today" to (reads the SAME `locale` row just
      // seeded above), not a wall-clock DURATION assertion. Computed once,
      // before handing the DB file off.
      const today = todayInHouseholdTz(Date.now());
      resetDb();
      if (prevDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = prevDataDir;
      if (prevDbPath === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = prevDbPath;

      const booted = await startBuiltEntrypoint(port, dataDir);
      activeChild = booted.child;

      await booted.waitForLog("scheduler started");

      const deadline = Date.now() + HEALTH_TIMEOUT_MS; // polling deadline only
      let result: BriefingReadResult | undefined;
      while (Date.now() < deadline) {
        const res = await fetch(
          `http://localhost:${port}/api/daily-briefing/${memberId}/${today}`,
          { headers: { cookie: `${DEVICE_COOKIE}=${deviceKey}` } }
        );
        if (res.ok) {
          const body = (await res.json()) as BriefingReadResult;
          if (body.generated) {
            result = body;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      expect(result).toBeDefined();
      expect(result?.generated).toBe(true);
      if (result?.generated) {
        expect(result.briefing.memberId).toBe(memberId);
        expect(result.briefing.date).toBe(today);
      }

      await hardKill(booted.child);
      activeChild = null;
    },
    BUILD_TIMEOUT_MS
  );
});
