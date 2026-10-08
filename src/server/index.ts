import { fileURLToPath } from "node:url";

import fs from "node:fs";
import type { Scheduler } from "./scheduler/index";

export function assertDataDirWritable(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.accessSync(dir, fs.constants.W_OK);
}

const SMOKE_JOB_ID = "scheduler.smoke";

/** Initialize the scheduler after HTTP startup and register all installed jobs. With
 * SCHEDULER_DISABLED=1, manual execution remains available but timers and catch-up stay off.
 * Publish the scheduler before awaiting start so shutdown can drain in-flight catch-up work.
 * Smoke-job options exercise delayed two-step writes and signal-driven draining in tests.
 */
async function startScheduler(publish: (scheduler: Scheduler) => void): Promise<Scheduler | null> {
  const disabled = process.env.SCHEDULER_DISABLED === "1";
  if (disabled) {
    console.log("scheduler disabled");
  }

  const { initScheduler } = await import("./scheduler/index");
  const scheduler = initScheduler();

  let jobCount = 0;

  // The daily-briefing scheduled
  // generation job, registered through the daily-briefing module's own
  // host-api-barrel-only registration function — never wired directly
  // against `./scheduler/index` here (that would bypass Rule B for the
  // module and, worse, couple this core entrypoint to a plugin's action).
  const { registerDailyBriefingJob } = await import("./modules/daily-briefing/job");
  registerDailyBriefingJob();
  jobCount += 1;

  //: the telemetry retention-prune job, registered through the
  // telemetry module's own host-api-barrel-only registration function (mirrors the
  // daily-briefing wiring immediately above) — a registration that exists but is
  // never called here leaves the deployed process never pruning `client_log`.
  const { registerTelemetryPruneJob } = await import("./telemetry/job");
  registerTelemetryPruneJob();
  jobCount += 1;

  //: the nightly backup snapshot job, registered through the
  // backups module's own host-api-barrel-only registration function (mirrors the daily-briefing
  // and telemetry wirings immediately above). Unlike those two jobs' catch-up predicates — both
  // vacuously false on a brand-new install — a fresh DATA_DIR has zero backup files, so this
  // job's `isMissed` is genuinely TRUE on first boot: by design, a kiosk that has never backed
  // up (or was off through last night's 03:30 window) gets an immediate catch-up snapshot as
  // part of this very `scheduler.start` call, before "scheduler started (N jobs)" logs.
  const { registerBackupsJob } = await import("./backups/job");
  registerBackupsJob();
  jobCount += 1;

  //: the network-devices live-client poller, registered
  // through the module's own host-api-barrel-only registration function (mirrors the
  // daily-briefing/telemetry/backups wirings immediately above). Also wires the real
  // in-process cache as `modules/network-devices/index.ts`'s production `LiveCacheAccessor`
  // (`registerNetworkDevicesPollerJob`'s own doc comment) — without this call, production
  // would run with the module's conservative `unconfigured`-only seam default forever, never
  // the real controller-backed cache.
  const { registerNetworkDevicesPollerJob } = await import("./modules/network-devices/poll");
  registerNetworkDevicesPollerJob();
  jobCount += 1;

  const { registerCalendarFeedJob } = await import("./modules/calendar/job");
  registerCalendarFeedJob();
  jobCount += 1;

  if (process.env.SCHEDULER_SMOKE_JOB === "1") {
    const slowMs = Number(process.env.SCHEDULER_SMOKE_SLOW_MS ?? 0);
    const writePath = process.env.SCHEDULER_SMOKE_WRITE_PATH;
    scheduler.registerJob({
      id: SMOKE_JOB_ID,
      trigger: { kind: "interval", everyMs: 60_000 },
      action: async () => {
        console.log("smoke job started");
        if (slowMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, slowMs));
        }
        // (INV-06): a genuinely TWO-STEP durable effect — two
        // sequential writes, each completing here, strictly before "smoke
        // job fired" logs. `stop` awaits this whole run rather than
        // interrupting it (src/server/scheduler/index.ts), so a test
        // reading BOTH files back after the process exits proves the
        // multi-step action completed as a recoverable unit — a SIGINT
        // arriving mid-run never leaves only the first step's effect
        // behind.
        if (writePath) {
          fs.writeFileSync(writePath, "smoke job write complete\n");
          fs.writeFileSync(`${writePath}.second`, "smoke job second write complete\n");
        }
        console.log("smoke job fired");
      },
    });
    jobCount += 1;
  }

  // Publish BEFORE start : every job above is
  // registered by this point, so the published instance is exactly the one `start` is about
  // to arm/catch-up.
  publish(scheduler);

  //: under the kill-switch, every job is registered (manual `runJobNow` calls keep
  // working) but `start` itself is skipped — no timers ever get armed (registerJob only
  // arms when lifecycle === "started", see scheduler/index.ts) and no startup catch-up runs.
  // No "scheduler started (N jobs)" log here — that log line stays the sole, honest signal that
  // timers are actually armed.
  if (disabled) {
    return scheduler;
  }

  await scheduler.start();
  console.log(`scheduler started (${jobCount} jobs)`);
  return scheduler;
}

export async function main(): Promise<void> {
  try {
    const DATA_DIR = process.env.DATA_DIR ?? process.cwd();
    assertDataDirWritable(DATA_DIR);

    const { acquireStorageOwnership } = await import("./db/runtime-storage");
    const { resolveDbPath } = await import("./db/client");
    acquireStorageOwnership(resolveDbPath());

    const { runMigrations } = await import("./db/migrate");
    runMigrations();
    const { assertWeekdayIntegrity } = await import("./db/weekday-integrity");
    assertWeekdayIntegrity();

    const { reconcileBootstrap, reconcileManagement } = await import("./auth/reconcile");
    reconcileBootstrap();
    // (maintainer decision 2026-09-04): seed the env-configured management
    // key the same way — kind='integration', the only kind requireManagementKey admits
    // that any deployment can actually configure today (nothing mints 'integration' via any
    // HTTP path yet). No-op when MP_MANAGEMENT_KEY is unset (fail-closed default).
    reconcileManagement();

    // : remove any `.tmp-*` snapshot temp file
    // orphaned by a hard kill of a PRIOR process (SIGKILL/power loss between backup starting
    // and the rename landing). Unconditional — runs regardless of SCHEDULER_DISABLED, since a
    // stray temp file is a filesystem-hygiene concern independent of whether the scheduler runs.
    //
    //: wrapped in its OWN
    // try/catch — this used to sit unguarded in main's outer try, so a bad `BACKUPS_ROOT`
    // override (`resolveBackupsRoot`'s `mkdirSync` throwing, e.g. EACCES/ENOTDIR/ENOSPC) would
    // fall through to the outer catch below and `process.exit(1)` the WHOLE app before it ever
    // started listening. This is a best-effort filesystem-hygiene sweep, not a startup
    // precondition — a failure here must be loud but never fatal.
    try {
      const { sweepOrphanedBackupTempFiles } = await import("./backups/storage");
      sweepOrphanedBackupTempFiles();
    } catch (err) {
      console.error("Backups: boot-time orphaned temp-file sweep failed (continuing):", err);
    }

    //: install the real live-client cache
    // as `modules/network-devices/index.ts`'s production `LiveCacheAccessor` UNCONDITIONALLY —
    // runs regardless of SCHEDULER_DISABLED, mirroring `sweepOrphanedBackupTempFiles` immediately
    // above. Playwright's default e2e webServer sets SCHEDULER_DISABLED=1, so without this call
    // living here, e2e would see the module's conservative `unconfigured`-only seam default
    // forever (the picker would report `reselect_required`/`unconfigured` no matter what).
    // Installing the accessor starts no timer by itself — it only lets `list`/`register`
    // read a REAL (if perpetually `cold`, since nothing polls it in that mode) cache instead of
    // the seam default. Only the actual POLLING JOB stays gated inside `startScheduler` below.
    const { wireNetworkDevicesCache } = await import("./modules/network-devices/cache");
    wireNetworkDevicesCache();

    const { buildApp } = await import("./app");
    const app = await buildApp();

    // Registered BEFORE `app.listen`/`startScheduler` so a signal that
    // arrives during listen or during scheduler catch-up is always caught
    // by OUR handler, never by Node's default (hard-exit, no drain)
    // handler. `scheduler` starts `null` and the shutdown closure already
    // guards on it, so a signal before `startScheduler` finishes simply
    // degrades to `app.close` + exit 0 — nothing to drain yet.
    let scheduler: Scheduler | null = null;
    let shuttingDown = false;

    const shutdown = async (): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      if (process.env.MP_LOCAL_READINESS === "1") console.log('MP_LOCAL_READY {"type":"stopping"}');

      // A hung `app.close`/`scheduler.stop` must not wedge the process
      // forever — force-exit after a few seconds. `unref`d so it never
      // keeps the event loop alive on its own (a clean shutdown that beats
      // the timer just lets it be garbage-collected).
      const forceExitTimer = setTimeout(() => {
        console.error("Shutdown timed out — forcing exit");
        process.exit(1);
      }, 5_000);
      forceExitTimer.unref();

      try {
        if (scheduler) {
          await scheduler.stop();
          console.log("scheduler drained");
        }
        await app.close();
        process.exit(0);
      } catch (err) {
        console.error("Error during shutdown:", err);
        process.exit(1);
      }
    };
    // `process.on`, NOT `process.once` (rework: 622 —
    // confirmed via reproduction, see tests/integration/entrypoint.test.ts's
    // doc comment). When this process is launched through `tsx` (the
    // integration test's entrypoint harness), `tsx`'s own CLI wrapper races
    // a short window waiting for THIS process to self-report (via its
    // `--require`d preflight shim) that it received the relayed signal; if
    // that self-report doesn't land in time — plausible under CI's tighter
    // CPU/IPC scheduling — the wrapper explicitly RE-SENDS the same signal.
    // A `once` listener has already self-removed after the first delivery,
    // so that second delivery would find zero *real* listeners left; the
    // preflight shim's own hidden handler force-`process.exit`s the
    // instant that count hits zero, killing us mid-drain with no chance to
    // finish `scheduler.stop`. `process.on` + the `shuttingDown` guard
    // above keeps a real listener registered for the process's whole life,
    // so a redelivered signal is always a safe no-op instead of a kill.
    process.on("SIGTERM", () => void shutdown());
    process.on("SIGINT", () => void shutdown());

    await app.listen({
      port: Number(process.env.PORT ?? 3000),
      host: process.env.HOST ?? "0.0.0.0",
    });

    if (process.env.MP_LOCAL_READINESS === "1") {
      const address = app.server.address();
      if (address && typeof address !== "string") {
        console.log(`MP_LOCAL_READY ${JSON.stringify({ type: "ready", port: address.port })}`);
      }
    }

    // `publish` closes the C3 race directly: it fires before `startScheduler`'s internal
    // `await scheduler.start` (which can itself await a real, slow catch-up write), so
    // `shutdown` above can see and drain the real instance even if a signal lands mid-catch-up
    // — never only once this whole call has fully returned.
    await startScheduler((s) => {
      scheduler = s;
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
