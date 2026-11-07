import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configurePluginJobLifecycleGate, createScheduler } from "../../src/server/scheduler/index";
import { SqlitePluginLifecycleStore } from "../../src/server/plugins/store";
import type { PluginId, PluginJobId } from "../../src/shared/plugins";
import { eventBus } from "../../src/server/lib/event-bus";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";
import { FakeClock, noopLog } from "../helpers/fake-clock";
import { ALL_SCHEMA_TABLES } from "../helpers/schema-tables";

/** (US3) — negative-proof + lifecycle suite for the scheduler
 * core (FR-006/FR-007/FR-008/FR-010). Four independently-meaningful
 * guarantees live in this one file, each proved against its own correctly
 * mapped id (docs/architecture/contracts/background-jobs-scheduler.md):
 * - BACKGROUND-JOBS-SCHEDULER-INV-08 (FR-010) — the scheduler core emits and
 * subscribes to ZERO domain events. Two halves: (a) STRUCTURAL — the
 * module source has no `event-bus` import at all (grep-verified: it
 * imports only from `../lib/household-date`), so there is no *syntactic* way for it to reach the bus; (b) RUNTIME — a spy on the bus singleton's
 * `emit`/`subscribe` across a full register -> fire (success) -> fire
 * (failure) -> manual run -> stop cycle, against a private scheduler
 * instance with an injected clock, proves zero *dynamic* calls either.
 * Together they cover the whole surface a hidden/indirect emit could hide
 * behind — a docblock instead of a second spy target, since there is no
 * second target: `createScheduler`'s closure holds no reference to
 * anything bus-shaped to spy on.
 * - BACKGROUND-JOBS-SCHEDULER-INV-05 (FR-007) — reads stay pure: no read
 * path may lazily generate or mutate scheduled output. The scheduled
 * suite (`tests/integration/daily-briefing-scheduled.test.ts`) already
 * proves this for ONE read (`readBriefing`); this suite does the FULL
 * sweep — every GET route the built app exposes, hit via `app.inject`
 * on a real `buildApp` instance — and asserts EVERY table's row count
 * (`ALL_SCHEMA_TABLES`, shared with the SC-006 snapshot, not just
 * `daily_briefing`/`client_log`) is bit-for-bit unchanged. A guard test
 * keeps the route inventory honest: it fails the moment a new GET route
 * lands without this suite being updated to sweep it too.
 * - SC-007 — a trace-tag audit: all 14 traced guarantees (13
 * BACKGROUND-JOBS-SCHEDULER + DAILY-BRIEFING-AC-10, per the own SC-007
 * wording) each appear in >=1 `it` title belonging to a call that WILL
 * ACTUALLY RUN AN ASSERTION (a real `it` or its `.only` variant —
 * `describe` titles don't count, since a describe block asserts
 * nothing on its own; neither do `.skip`/`.todo` titles or commented-out
 * call sites) somewhere under `tests/`.
 * (The remaining two items — SC-006's schema-table-set snapshot and the
 * INV-06 process-level drain/write-completion proof — live elsewhere:
 * `tests/boundary/migrate-runner.test.ts` and the extended kill test in
 * `tests/integration/entrypoint.test.ts`, respectively; see those files'
 * docblocks.)
 */

describe("scheduler emits zero bus events (US3 — BACKGROUND-JOBS-SCHEDULER-INV-08)", () => {
  useIsolatedDb();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("BACKGROUND-JOBS-SCHEDULER-INV-08: the scheduler core module has no event-bus import at all (structural half)", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src", "server", "scheduler", "index.ts"),
      "utf-8"
    );
    // The scheduler's own doc comment already asserts this (`No... bus
    // events (INV-01/03/08...)`); this assertion makes it machine-checked
    // instead of merely documented. Scoped to IMPORT lines only (never the
    // whole file) so a future prose mention of "event-bus" elsewhere in a
    // comment can't trip a false positive.
    const importLines = source.split("\n").filter((line) => /^\s*import\b/.test(line));
    expect(importLines.some((line) => line.includes("event-bus"))).toBe(false);
  });

  it("BACKGROUND-JOBS-SCHEDULER-INV-08: emit/subscribe are never called across a full register -> fire (success) -> fire (failure) -> manual run -> stop cycle (runtime half)", async () => {
    const emitSpy = vi.spyOn(eventBus, "emit");
    const subscribeSpy = vi.spyOn(eventBus, "subscribe");

    const clock = new FakeClock(0);
    const scheduler = createScheduler({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      log: noopLog(),
    });

    let succeedCalls = 0;
    scheduler.registerJob({
      id: "ok-job",
      trigger: { kind: "interval", everyMs: 1000 },
      action: () => {
        succeedCalls += 1;
      },
    });

    let failCalls = 0;
    scheduler.registerJob({
      id: "fail-job",
      trigger: { kind: "interval", everyMs: 1000 },
      action: () => {
        failCalls += 1;
        throw new Error("boom — deliberate, proves the fail path stays bus-silent too");
      },
    });

    // register (above) -> fire via the immediate arm at start -> a second
    // interval tick -> a manual run -> stop. Both jobs fire on every tick,
    // so both the success and the failure path are exercised repeatedly.
    await scheduler.start();
    await clock.advanceTo(0); // fires the immediate arm for both jobs
    await clock.advanceTo(1000); // fires the next interval tick for both jobs
    await scheduler.runJobNow("ok-job"); // exercises the "manual" trigger kind too
    await scheduler.stop();

    expect(succeedCalls).toBeGreaterThan(0);
    expect(failCalls).toBeGreaterThan(0);

    expect(emitSpy).not.toHaveBeenCalled();
    expect(subscribeSpy).not.toHaveBeenCalled();
  });
});

/** Full GET-route inventory of the built app, as of this module — 37 routes,
 * derived from `buildApp`'s own `app.printRoutes({ commonPrefix: false })`
 * output (Fastify's route tree). `:param` segments use the SAME template
 * syntax Fastify reports, so the guard test below can diff this list
 * directly against a live parse with no translation step. `toRequestUrl`
 * (below) fills in concrete placeholder values/query strings for the actual
 * sweep.
 * `/api/weather` needs no entry in `REQUIRED_QUERY` below —
 * `useIsolatedDb` gives every test a fresh DB with no `weather` settings
 * row, so the route's `readWeatherLocation` reads blank and returns
 * `{forecast: null}` WITHOUT ever calling the forecast port (which would
 * otherwise throw under the test runtime per `createOpenMeteoPort`'s * research-D4 safety net) — a read exactly as pure as every other route here.
 * `/api/printing/jobs` needs no `REQUIRED_QUERY` entry — it
 * takes none. `/api/printing/status` (FR-013, issue 691) needs none either: it
 * takes no path/query params and reads only the in-process `isPrintingPluginActive`
 * flag — no table touched at all. `/api/printing/jobs/:id/payload` also needs none: with `:id`
 * replaced by the fake `does-not-exist` id and no `leaseToken` query string,
 * the route's own `if (!leaseToken)` guard 409s before ever reaching
 * `getPayload` — below the 500 floor, and the row-count purity check below
 * is unaffected either way since `getPayload`'s lease-refresh is an
 * UPDATE (touches content, never row COUNT).
 */
const GET_ROUTE_TEMPLATES = [
  "/api/auth/credentials",
  "/api/backups",
  "/api/backups/:filename/download",
  "/api/backups/:filename/download-sql",
  "/api/calendar/events",
  "/api/calendar/external-sources",
  "/api/calendar/highlight-rules",
  "/api/chores/:id",
  "/api/chores/board",
  "/api/daily-briefing/:memberId/:date",
  "/api/daily-briefing/:memberId/:date/preview.png",
  "/api/daily-briefing/history/:memberId",
  "/api/daily-briefing/opt-in",
  "/api/daily-briefing/settings",
  "/api/daily-messages",
  "/api/daily-messages/current",
  "/api/day-periods",
  "/api/day-periods/active",
  "/api/docs",
  "/api/docs/",
  "/api/docs/js/scalar.js",
  "/api/meal-plans",
  "/api/meal-plans/:id",
  "/api/meal-plans/:id/entries",
  "/api/members",
  "/api/menu",
  "/api/menu/week",
  "/api/network-devices",
  "/api/network-devices/live-clients",
  "/api/openapi.json",
  "/api/plugins",
  "/api/printing/jobs",
  "/api/printing/jobs/:id/payload",
  "/api/printing/status",
  "/api/recipes",
  "/api/recipes/:id",
  "/api/recipes/:id/dependents",
  "/api/reminders",
  "/api/reminders/:id",
  "/api/reminders/emissions",
  "/api/routines",
  "/api/routines/:id",
  "/api/routines/:id/assignments",
  "/api/routines/:id/chores",
  "/api/settings",
  "/api/telemetry/client-log",
  "/api/telemetry/system-status",
  "/api/time-announcements",
  "/api/weather",
  "/health",
].sort();

// Computed once at module load ("now" whenever the suite actually runs —
// never a hardcoded past/future date, so this never rots; see the repo's
// "test date time-bomb" lesson). Only /api/calendar/events needs it: its
// range is validated against a REAL now-relative window (-30d/+365d,
// src/server/modules/calendar/index.ts), so a fixed 2026-01-01-style
// constant would eventually fall outside that window and start 400ing.
const TODAY_ISO = new Date().toISOString().slice(0, 10);

/** Query strings required by routes that 400 without them (optional-query
 * routes are hit with none — an empty result set/list is still a read).
 * Every entry here is a VALID-SHAPED value chosen so the route actually
 * reaches its read (200), not just a differently-shaped 400 — verified by
 * running the sweep and inspecting each of these four routes' status code
 * individually (see the rework commit for the mutation evidence). */
const REQUIRED_QUERY: Record<string, string> = {
  "/api/daily-messages": "memberId=does-not-exist&from=2026-01-01&days=1",
  "/api/daily-messages/current": "memberId=does-not-exist&date=2026-01-01",
  "/api/chores/board": "date=2026-01-01",
  // Real now-relative window (see TODAY_ISO above) — from===to is a valid
  // one-day range.
  "/api/calendar/events": `from=${TODAY_ISO}&to=${TODAY_ISO}`,
  // getMenu/getWeekMenu only validate the date's SHAPE (isStrictCalendarDate),
  // never its recency — a fixed date is fine here, unlike calendar/events.
  "/api/menu": "date=2026-01-01",
  "/api/menu/week": "date=2026-01-01",
  // getReminders returns [] (200) for a memberId that isn't an active
  // member — it never 404s/400s on an unknown-but-well-shaped id.
  "/api/reminders/emissions": "memberId=does-not-exist&date=2026-01-01",
};

function toRequestUrl(template: string): string {
  const withParams = template
    .replace(/:memberId/g, "does-not-exist")
    .replace(/:date/g, "2026-01-01")
    .replace(/:id/g, "does-not-exist")
    // A well-formed-but-never-written filename: reaches the real
    // resolveExistingBackupPath read path and 404s as not_found — never a 401/5xx.
    .replace(/:filename/g, "scheduled-20260101-000000-000.db");
  const qs = REQUIRED_QUERY[template];
  return qs ? `${withParams}?${qs}` : withParams;
}

/** Parses Fastify's `printRoutes({ commonPrefix: false })` tree output into a
 * sorted list of full route templates that support GET. The tree indents
 * each nesting level by exactly 4 columns (either `"│ "` or `" "`)
 * before a `"├── "`/`"└── "` marker; a segment's full path is the
 * concatenation of every ancestor segment on the stack above it.
 * A node's segment is pushed onto the stack UNCONDITIONALLY, even when the
 * line has no trailing `" (methods)"` suffix (a pure grouping/prefix node
 * with no route of its own) — descendants still need that segment to build
 * their own full path. Skipping the push there (the bug this fixes) would
 * leave a STALE ancestor on the stack, silently concatenating an earlier
 * sibling's segment into every route beneath the parenless node instead.
 */
function parseGetRouteTemplates(printRoutesOutput: string): string[] {
  const stack: string[] = [];
  const results: string[] = [];

  for (const line of printRoutesOutput.split("\n")) {
    if (line.trim().length === 0) continue;
    const markerMatch = line.match(/^([│ ]*)(├── |└── )(.*)$/);
    if (!markerMatch) continue;
    const [, indent, , rest] = markerMatch;
    const depth = indent.length / 4;
    const segMatch = rest.match(/^(.*?) \(([^)]*)\)\s*$/);

    if (!segMatch) {
      // No "(methods)" suffix — a parenless grouping node. Still register
      // its segment on the stack (at the right depth) so descendants
      // concatenate the REAL path, not a stale ancestor; it contributes no
      // GET route of its own, so there is nothing to push to `results`.
      stack[depth] = rest.trimEnd();
      stack.length = depth + 1;
      continue;
    }

    const [, segment, methodsRaw] = segMatch;
    const methods = methodsRaw.split(",").map((s) => s.trim());

    stack[depth] = segment;
    stack.length = depth + 1;

    if (methods.includes("GET")) {
      results.push(stack.join(""));
    }
  }

  return results.sort();
}

function countTable(db: ReturnType<typeof getDb>, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

/** Row counts for EVERY table in the schema (`ALL_SCHEMA_TABLES`, shared with
 * the SC-006 snapshot in `tests/boundary/migrate-runner.test.ts`) — not just
 * `daily_briefing`/`client_log`, the two tables the scheduler's OWN jobs
 * happen to write to. A read path with an unexpected side effect on some
 * OTHER table (e.g. an accidental audit-log insert, a stray settings write)
 * would pass a narrower two-table check but fails this one. */
function snapshotAllTables(db: ReturnType<typeof getDb>): Record<string, number> {
  const snapshot: Record<string, number> = {};
  for (const table of ALL_SCHEMA_TABLES) {
    snapshot[table] = countTable(db, table);
  }
  return snapshot;
}

describe("reads stay pure across every GET surface (US3 — BACKGROUND-JOBS-SCHEDULER-INV-05)", () => {
  useIsolatedDb();

  it("guard: the app's live GET route set exactly matches GET_ROUTE_TEMPLATES (fails when a new GET route lands without updating this sweep)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const live = parseGetRouteTemplates(app.printRoutes({ commonPrefix: false }));
      expect(live).toEqual(GET_ROUTE_TEMPLATES);
    } finally {
      await app.close();
    }
  });

  it("BACKGROUND-JOBS-SCHEDULER-INV-05: hitting every GET route leaves every table's row count unchanged", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    // A valid key so every route reaches its REAL handler/read path (not just
    // a 401/403 short-circuit at the auth boundary) — the purity guarantee is
    // about what the handler DOES, so the handler must run. `scope='*'`
    // satisfies every route's `requireCapability` check (`scope === '*'`
    // branch), so this key exercises the full surface.
    const sweepKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sweepKeyHash = hashKey(sweepKey);
    const now = Date.now();
    const db = getDb();
    db.prepare("UPDATE plugin_activation_registry SET state = 'active'").run();
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'integration', ?)"
    ).run(`${Date.now()}-integration`, sweepKeyHash, now);
    // Cookie routes use a provisioned device key: `requireFullAccess` routes such as
    // `/api/auth/credentials` admit a cookie only for `kind='device'`.
    const deviceKey = `${sweepKey}-device`;
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${Date.now()}-device`, hashKey(deviceKey), now);

    const app = await buildApp();
    try {
      const before = snapshotAllTables(db);

      for (const template of GET_ROUTE_TEMPLATES) {
        const isPluginCatalog = template === "/api/plugins";
        const res = await app.inject({
          method: "GET",
          url: toRequestUrl(template),
          ...(isPluginCatalog
            ? { headers: { authorization: `Bearer ${sweepKey}` } }
            : { cookies: { mp_device_key: deviceKey } }),
        });
        // Not a contract test — a fake id 404ing or an unfilled optional
        // filter 400ing is expected and fine (REQUIRED_QUERY supplies
        // valid-shaped values for the routes that actually need one, so
        // most of these do reach 200). What must NEVER happen: a 401 (the
        // key not being honored at all), a 403 (rejected by a capability/
        // management-key gate — either way the handler never ran, making the
        // row-count check below vacuous for that route), or a 5xx (an
        // unhandled crash). Past those three floors, the handler provably ran
        // its real read path.
        expect(res.statusCode).not.toBe(401);
        expect(res.statusCode).not.toBe(403);
        expect(res.statusCode).toBeLessThan(500);
      }

      const after = snapshotAllTables(db);

      expect(after).toEqual(before);
    } finally {
      await app.close();
    }
  });
});

describe("plugin-owned scheduler contributions", () => {
  useIsolatedDb();

  it("blocks every declared job while its owner is inactive and admits it only while active", async () => {
    const db = getDb();
    const runtimeModule = await import("../../src/server/plugins/runtime");
    expect(runtimeModule).toHaveProperty("createServerPluginRuntime");
    const createServerPluginRuntime = Reflect.get(
      runtimeModule,
      "createServerPluginRuntime"
    ) as (options: {
      readonly store: SqlitePluginLifecycleStore;
      readonly now: () => string;
      readonly operationId: (pluginId: PluginId) => string;
      readonly drainDeadline: (pluginId: PluginId) => { readonly expiresAt: string };
    }) => {
      readonly lifecycle: {
        activate(pluginId: PluginId): Promise<unknown>;
        deactivate(pluginId: PluginId): Promise<unknown>;
      };
      isContributionActive(pluginId: PluginId): boolean;
    };
    const runtime = createServerPluginRuntime({
      store: new SqlitePluginLifecycleStore(db),
      now: () => "2026-09-27T10:15:30.000Z",
      operationId: (pluginId) => `scheduler-${pluginId}`,
      drainDeadline: () => ({ expiresAt: "2026-09-27T10:20:30.000Z" }),
    });
    const scheduler = createScheduler({ log: noopLog() });
    const jobOwners: ReadonlyArray<readonly [PluginJobId, PluginId]> = [
      ["daily-briefing.generate-all", "daily-briefing"],
      ["daily-briefing.retry-15", "daily-briefing"],
      ["daily-briefing.retry-30", "daily-briefing"],
      ["daily-briefing.auto-print-sweep", "daily-briefing"],
      ["backups.nightly", "backups"],
      ["network-devices.poll", "network-devices"],
    ];

    for (const [jobId, pluginId] of jobOwners) {
      let calls = 0;
      scheduler.registerJob({
        id: jobId,
        trigger: { kind: "interval", everyMs: 60_000 },
        action: () => {
          calls += 1;
        },
      });

      await expect(scheduler.runJobNow(jobId)).resolves.toEqual({ status: "already_running" });
      expect(calls).toBe(0);

      if (!runtime.isContributionActive(pluginId)) {
        await runtime.lifecycle.activate(pluginId);
      }
      await expect(scheduler.runJobNow(jobId)).resolves.toMatchObject({ status: "completed" });
      expect(calls).toBe(1);

      await runtime.lifecycle.deactivate(pluginId);
      await expect(scheduler.runJobNow(jobId)).resolves.toEqual({ status: "already_running" });
      expect(calls).toBe(1);
    }
  });

  it("drains a plugin job without interrupting its valid in-flight run and expires deterministically", async () => {
    configurePluginJobLifecycleGate(undefined);
    const clock = new FakeClock(Date.parse("2026-09-27T10:15:30.000Z"));
    const scheduler = createScheduler({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      log: noopLog(),
    });
    let releaseRun!: () => void;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    scheduler.registerJob({
      id: "backups.nightly",
      trigger: { kind: "interval", everyMs: 60_000 },
      action: () => runGate,
    });

    const running = scheduler.runJobNow("backups.nightly");
    await clock.flush();
    expect(scheduler).toHaveProperty("drainJobs");
    const drainJobs = Reflect.get(scheduler, "drainJobs") as (
      ids: readonly string[],
      deadline: { readonly expiresAt: string }
    ) => Promise<"drained" | "expired">;
    const drained = drainJobs(["backups.nightly"], {
      expiresAt: "2026-09-27T10:15:31.000Z",
    });
    let settled = false;
    void drained.then(() => {
      settled = true;
    });
    await clock.flush();
    expect(settled).toBe(false);

    releaseRun();
    await expect(running).resolves.toMatchObject({ status: "completed" });
    await expect(drained).resolves.toBe("drained");

    let releaseExpiredRun!: () => void;
    const expiredGate = new Promise<void>((resolve) => {
      releaseExpiredRun = resolve;
    });
    scheduler.registerJob({
      id: "network-devices.poll",
      trigger: { kind: "interval", everyMs: 60_000 },
      action: () => expiredGate,
    });
    const expiredRun = scheduler.runJobNow("network-devices.poll");
    await clock.flush();
    const expiredDrain = drainJobs(["network-devices.poll"], {
      expiresAt: "2026-09-27T10:15:31.000Z",
    });
    await clock.advanceTo(Date.parse("2026-09-27T10:15:31.000Z"));
    await expect(expiredDrain).resolves.toBe("expired");

    releaseExpiredRun();
    await expect(expiredRun).resolves.toMatchObject({ status: "completed" });
  });
});

/** Fixed scheduler guarantee inventory: 13 scheduler invariants/acceptance criteria plus
 * DAILY-BRIEFING-AC-10. Keep this oracle independent from test discovery so removing a
 * traced assertion cannot silently shrink the required contract.
 */
const TRACED_GUARANTEE_IDS = [
  "BACKGROUND-JOBS-SCHEDULER-AC-01",
  "BACKGROUND-JOBS-SCHEDULER-AC-02",
  "BACKGROUND-JOBS-SCHEDULER-AC-03",
  "BACKGROUND-JOBS-SCHEDULER-AC-04",
  "BACKGROUND-JOBS-SCHEDULER-AC-07",
  "BACKGROUND-JOBS-SCHEDULER-INV-01",
  "BACKGROUND-JOBS-SCHEDULER-INV-02",
  "BACKGROUND-JOBS-SCHEDULER-INV-03",
  "BACKGROUND-JOBS-SCHEDULER-INV-04",
  "BACKGROUND-JOBS-SCHEDULER-INV-05",
  "BACKGROUND-JOBS-SCHEDULER-INV-06",
  "BACKGROUND-JOBS-SCHEDULER-INV-07",
  "BACKGROUND-JOBS-SCHEDULER-INV-08",
  "DAILY-BRIEFING-AC-10",
];

function collectTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTestFiles(full));
    } else if (/\.(test|spec)\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Extracts the quoted title string from every direct `it(...)` call, or its
 * `.only` variant, that will ACTUALLY RUN AN ASSERTION.
 * Deliberately `it(...)` ONLY — never `describe(...)`. A `describe` block
 * is pure organization; its title being present proves nothing about
 * whether anything inside it runs or asserts. Counting it was a real,
 * separate hole from the one below: this suite's own schema-snapshot
 * `describe("schema table set (— SC-006 / BACKGROUND-JOBS-SCHEDULER-
 * INV-03)",...)` restates the id in its OWN title, so `it.skip`-ing the
 * lone `it` inside it (see next paragraph) still left the id "covered" via
 * the untouched, always-running `describe` header alone — reproduced,
 * confirmed, and closed by dropping `describe` from this match entirely.
 * Deliberately excludes `.skip`/`.todo`: a skipped/todo test's title is not
 * evidence the guarantee is verified, only that someone once wrote a test
 * for it (proven empirically: `it.skip`-ing the one real INV-03 test
 * previously left this audit green — a title-only match doesn't care
 * whether the test executes).
 * Also excludes comments. An earlier version of this function claimed a
 * comment could never match the call-site pattern — FALSE, disproven: a
 * commented-out `// it("BACKGROUND-...")` line matches a plain `it(` +
 * quote regex exactly as well as a real call, silently counting a dead test
 * as coverage. Guarded two ways: (1) block comments (`/*... *‍/`, including
 * JSDoc) are blanked out (chars -> spaces, newlines preserved) before
 * scanning; (2) since every `it(` call in this codebase is single-line,
 * matching is done PER LINE, and any line whose trimmed start is `//` or
 * `*` (a line comment, or a JSDoc continuation line a block-comment
 * blank-out might not fully neutralize) is skipped outright.
 */
function extractTestTitles(source: string): string[] {
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const titles: string[] = [];
  const re = /\bit(?:\.only)?\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/;

  for (const line of withoutBlockComments.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    const match = re.exec(line);
    if (match) titles.push(match[2]);
  }

  return titles;
}

describe("trace-tag audit (US3 — SC-007)", () => {
  it("SC-007: all 14 traced guarantees (13 BACKGROUND-JOBS-SCHEDULER + DAILY-BRIEFING-AC-10) appear in >=1 RUNNING test name under tests/", () => {
    const testFiles = collectTestFiles(path.resolve(process.cwd(), "tests"));
    const allTitles = testFiles.flatMap((file) =>
      extractTestTitles(fs.readFileSync(file, "utf-8"))
    );

    const missing = TRACED_GUARANTEE_IDS.filter(
      (id) => !allTitles.some((title) => title.includes(id))
    );

    expect(missing).toEqual([]);
  });
});
