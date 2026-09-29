import { describe, expect, it } from "vitest";

import { getDb } from "../../src/server/db/client.js";
import { PluginLifecycleError } from "../../src/server/plugins/errors.js";
import { createServerPluginRuntime } from "../../src/server/plugins/runtime.js";
import { SqlitePluginLifecycleStore } from "../../src/server/plugins/store.js";
import {
  ackJob,
  claimJob,
  drainPrintingClaims,
  enqueueTestPrint,
  isPrintingPluginActive,
  PrintingPluginInactiveError,
} from "../../src/server/modules/printing/index.js";
import { createScheduler } from "../../src/server/scheduler/index.js";
import { useIsolatedDb } from "../helpers/db.js";
import { FakeClock, noopLog } from "../helpers/fake-clock.js";

const NOW = "2026-09-27T10:15:30.000Z";
const DEADLINE = { expiresAt: "2026-09-27T10:17:30.000Z" } as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("assembled plugin lifecycle drain", () => {
  useIsolatedDb();

  it("keeps canonical active/busy while one Printing lease drains and shares only same-target work", async () => {
    const store = new SqlitePluginLifecycleStore(getDb());
    const printingDrain = deferred<"drained" | "expired">();
    let printingDrainCalls = 0;
    const runtime = createServerPluginRuntime({
      store,
      now: () => NOW,
      operationId: (pluginId) => `drain-${pluginId}`,
      drainDeadline: () => DEADLINE,
      drainScheduledJobs: async () => "drained",
      drainPrintingClaims: () => {
        printingDrainCalls += 1;
        return printingDrain.promise;
      },
    });
    await runtime.lifecycle.activate("printing");

    const first = runtime.lifecycle.deactivate("printing");
    await Promise.resolve();

    expect(printingDrainCalls).toBe(1);
    await expect(runtime.lifecycle.listCatalog()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "printing",
          state: "active",
          operation: { targetState: "inactive", startedAt: NOW },
        }),
      ])
    );
    expect(isPrintingPluginActive()).toBe(false);
    expect(runtime.lifecycle.deactivate("printing")).toBe(first);
    await expect(runtime.lifecycle.activate("printing")).rejects.toMatchObject({
      code: "plugin_lifecycle_busy",
    });

    printingDrain.resolve("drained");
    await expect(first).resolves.toMatchObject({ state: "inactive", operation: null });
    expect(runtime.isContributionActive("printing")).toBe(false);
  });

  it("fails closed to errored/quiesced when a scheduled-job drain expires", async () => {
    const store = new SqlitePluginLifecycleStore(getDb());
    let drainedJobIds: readonly string[] = [];
    const runtime = createServerPluginRuntime({
      store,
      now: () => NOW,
      operationId: (pluginId) => `expired-${pluginId}`,
      drainDeadline: () => DEADLINE,
      drainScheduledJobs: async (jobIds) => {
        drainedJobIds = jobIds;
        return "expired";
      },
      drainPrintingClaims: async () => "drained",
    });
    await runtime.lifecycle.activate("backups");

    const rejection = await runtime.lifecycle.deactivate("backups").catch((error) => error);

    expect(drainedJobIds).toEqual(["backups.nightly"]);
    expect(rejection).toBeInstanceOf(PluginLifecycleError);
    expect(rejection).toMatchObject({ code: "drain_failed" });
    expect(store.getRegistry("backups")).toMatchObject({
      state: "errored",
      error: { code: "drain_failed" },
    });
    expect(store.getOperation("backups")).toBeNull();
    expect(runtime.isContributionActive("backups")).toBe(false);
  });

  it("reconciles a stale-active interrupted deactivation without remounting it", async () => {
    const store = new SqlitePluginLifecycleStore(getDb());
    getDb()
      .prepare(
        "UPDATE plugin_activation_registry SET state = 'active', activated_at = ?, updated_at = ? WHERE plugin_id = 'network-devices'"
      )
      .run(NOW, NOW);
    store.begin("network-devices", "restart-network", "inactive", "draining", NOW);
    let drainCalls = 0;
    const runtime = createServerPluginRuntime({
      store,
      now: () => NOW,
      operationId: (pluginId) => `restart-${pluginId}`,
      drainDeadline: () => DEADLINE,
      drainScheduledJobs: async () => {
        drainCalls += 1;
        return "drained";
      },
      drainPrintingClaims: async () => "drained",
    });

    await runtime.lifecycle.reconcileAll();

    expect(drainCalls).toBe(1);
    expect(store.getRegistry("network-devices").state).toBe("inactive");
    expect(store.getOperation("network-devices")).toBeNull();
    expect(runtime.isContributionActive("network-devices")).toBe(false);
  });

  it("blocks sibling scheduler claims after durable drain starts and lets the valid run finish", async () => {
    const clock = new FakeClock(Date.parse(NOW));
    const scheduler = createScheduler({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      log: noopLog(),
    });
    const store = new SqlitePluginLifecycleStore(getDb());
    const runtime = createServerPluginRuntime({
      store,
      now: () => NOW,
      operationId: (pluginId) => `scheduler-race-${pluginId}`,
      drainDeadline: () => DEADLINE,
      drainScheduledJobs: (jobIds, deadline) => scheduler.drainJobs(jobIds, deadline),
      drainPrintingClaims: async () => "drained",
    });
    const validRun = deferred<void>();
    scheduler.registerJob({
      id: "daily-briefing.generate-all",
      trigger: { kind: "interval", everyMs: 60_000 },
      action: () => validRun.promise,
    });
    scheduler.registerJob({
      id: "daily-briefing.retry-15",
      trigger: { kind: "interval", everyMs: 60_000 },
      action: () => undefined,
    });
    await runtime.lifecycle.activate("daily-briefing");
    const running = scheduler.runJobNow("daily-briefing.generate-all");
    await clock.flush();

    const deactivation = runtime.lifecycle.deactivate("daily-briefing");
    await clock.flush();

    expect(store.getRegistry("daily-briefing").state).toBe("active");
    expect(store.getOperation("daily-briefing")).toMatchObject({
      targetState: "inactive",
      phase: "draining",
    });
    await expect(scheduler.runJobNow("daily-briefing.retry-15")).resolves.toEqual({
      status: "already_running",
    });

    validRun.resolve();
    await expect(running).resolves.toMatchObject({ status: "completed" });
    await expect(deactivation).resolves.toMatchObject({ state: "inactive" });
  });

  it("drains a real Printing lease through deactivation and still accepts its valid ack", async () => {
    const clock = new FakeClock(Date.parse(NOW));
    const store = new SqlitePluginLifecycleStore(getDb());
    const runtime = createServerPluginRuntime({
      store,
      now: () => NOW,
      operationId: (pluginId) => `printing-race-${pluginId}`,
      drainDeadline: () => DEADLINE,
      drainScheduledJobs: async () => "drained",
      drainPrintingClaims: (deadline) =>
        drainPrintingClaims(deadline, {
          now: clock.now,
          setTimeout: clock.setTimeout,
          clearTimeout: clock.clearTimeout,
        }),
    });
    await runtime.lifecycle.activate("printing");
    const trigger = enqueueTestPrint(clock.now());
    const claimed = claimJob(clock.now());
    expect(claimed?.job.id).toBe(trigger.jobId);

    const deactivation = runtime.lifecycle.deactivate("printing");
    await clock.flush();

    expect(() => claimJob(clock.now() + 1)).toThrow(PrintingPluginInactiveError);
    expect(store.getRegistry("printing").state).toBe("active");
    expect(store.getOperation("printing")?.phase).toBe("draining");
    expect(ackJob(claimed!.job.id, claimed!.leaseToken, clock.now() + 2).state).toBe("printed");
    await expect(deactivation).resolves.toMatchObject({ state: "inactive" });
  });

  it("expires a real Printing drain without cancelling the lease, then permits its truthful late ack", async () => {
    const clock = new FakeClock(Date.parse(NOW));
    const store = new SqlitePluginLifecycleStore(getDb());
    const runtime = createServerPluginRuntime({
      store,
      now: () => new Date(clock.now()).toISOString(),
      operationId: (pluginId) => `printing-expiry-${pluginId}`,
      drainDeadline: () => ({ expiresAt: new Date(clock.now() + 1_000).toISOString() }),
      drainScheduledJobs: async () => "drained",
      drainPrintingClaims: (deadline) =>
        drainPrintingClaims(deadline, {
          now: clock.now,
          setTimeout: clock.setTimeout,
          clearTimeout: clock.clearTimeout,
        }),
    });
    await runtime.lifecycle.activate("printing");
    enqueueTestPrint(clock.now());
    const claimed = claimJob(clock.now());
    expect(claimed).not.toBeNull();

    const deactivation = runtime.lifecycle.deactivate("printing");
    await clock.advanceBy(1_000);
    await expect(deactivation).rejects.toMatchObject({ code: "drain_failed" });

    expect(store.getRegistry("printing")).toMatchObject({
      state: "errored",
      error: { code: "drain_failed" },
    });
    expect(store.getOperation("printing")).toBeNull();
    expect(ackJob(claimed!.job.id, claimed!.leaseToken, clock.now()).state).toBe("printed");
  });
});
