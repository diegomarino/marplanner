import type { PluginId, PluginJobId, PluginManifest } from "../../shared/plugins.js";
import { ensurePluginSettingsDefaults } from "../modules/settings/index.js";
import {
  configurePrintingPluginLifecycleGate,
  drainPrintingClaims,
} from "../modules/printing/index.js";
import { configureDailyBriefingContentSourceLifecycleGate } from "../modules/daily-briefing/index.js";
import { configurePluginJobLifecycleGate, drainScheduledJobs } from "../scheduler/index.js";
import { createPluginLifecycle, type PluginLifecycle } from "./lifecycle.js";
import { PLUGIN_MANIFESTS } from "./manifest.js";
import type { SqlitePluginLifecycleStore } from "./store.js";

export interface PluginDrainDeadline {
  readonly expiresAt: string;
}

export interface PluginRuntimeAdapter {
  readonly manifest: PluginManifest;
  ensureSettingsDefaults(): Promise<void>;
  runPendingMigrations(): Promise<void>;
  mount(): Promise<void>;
  blockNewClaims(): void;
  drain(deadline: PluginDrainDeadline): Promise<"drained" | "expired">;
  unmount(): Promise<void>;
}

export interface PluginMigration {
  readonly id: string;
  readonly apply: () => undefined;
}

export interface PluginRuntimeAdapterOptions {
  readonly manifest: PluginManifest;
  readonly store: SqlitePluginLifecycleStore;
  readonly now: () => string;
  readonly ensureSettingsDefaults?: () => void | Promise<void>;
  readonly migrations?: readonly PluginMigration[];
  readonly mount: () => void | Promise<void>;
  readonly blockNewClaims: () => void;
  readonly drain: (deadline: PluginDrainDeadline) => Promise<"drained" | "expired">;
  readonly unmount: () => void | Promise<void>;
}

export function createPluginRuntimeAdapter(
  options: PluginRuntimeAdapterOptions
): PluginRuntimeAdapter {
  return {
    manifest: options.manifest,
    ensureSettingsDefaults: async () => {
      await options.ensureSettingsDefaults?.();
    },
    runPendingMigrations: async () => {
      for (const migration of options.migrations ?? []) {
        options.store.applyPluginMigration(
          options.manifest.id,
          migration.id,
          options.now(),
          migration.apply
        );
      }
    },
    mount: async () => {
      await options.mount();
    },
    blockNewClaims: options.blockNewClaims,
    drain: options.drain,
    unmount: async () => {
      await options.unmount();
    },
  };
}

const JOB_OWNERS = Object.freeze({
  "daily-briefing.generate-all": "daily-briefing",
  "daily-briefing.retry-15": "daily-briefing",
  "daily-briefing.retry-30": "daily-briefing",
  "daily-briefing.auto-print-sweep": "daily-briefing",
  "backups.nightly": "backups",
  "network-devices.poll": "network-devices",
} as const satisfies Record<PluginJobId, PluginId>);

export interface ServerPluginRuntimeOptions {
  readonly store: SqlitePluginLifecycleStore;
  readonly now: () => string;
  readonly operationId: (pluginId: PluginId) => string;
  readonly drainDeadline: (pluginId: PluginId) => PluginDrainDeadline;
  readonly drainScheduledJobs?: (
    jobIds: readonly PluginJobId[],
    deadline: PluginDrainDeadline
  ) => Promise<"drained" | "expired">;
  readonly drainPrintingClaims?: (deadline: PluginDrainDeadline) => Promise<"drained" | "expired">;
}

export interface ServerPluginRuntime {
  readonly adapters: readonly PluginRuntimeAdapter[];
  readonly lifecycle: PluginLifecycle;
  isContributionActive(pluginId: PluginId): boolean;
}

/** Core-owned assembly of the closed first-party manifest cohort. Feature modules remain ordinary
 * in-tree modules; this assembly only controls whether their existing entry points are published.
 * No manifest is discovered dynamically and no feature body is replaced.
 */
export function createServerPluginRuntime(
  options: ServerPluginRuntimeOptions
): ServerPluginRuntime {
  const mounted = new Set<PluginId>();
  const claimsBlocked = new Set<PluginId>();

  const isCanonicalActive = (pluginId: PluginId): boolean =>
    options.store.getRegistry(pluginId).state === "active";
  const isContributionActive = (pluginId: PluginId): boolean =>
    mounted.has(pluginId) && isCanonicalActive(pluginId);
  const canClaimWork = (pluginId: PluginId): boolean =>
    isContributionActive(pluginId) &&
    !claimsBlocked.has(pluginId) &&
    options.store.getOperation(pluginId) === null;
  const drainJobs = options.drainScheduledJobs ?? drainScheduledJobs;
  const drainPrinting = options.drainPrintingClaims ?? drainPrintingClaims;

  const adapters = PLUGIN_MANIFESTS.map((manifest) =>
    createPluginRuntimeAdapter({
      manifest,
      store: options.store,
      now: options.now,
      ensureSettingsDefaults: () =>
        ensurePluginSettingsDefaults(manifest.id, undefined, Date.parse(options.now())),
      mount: () => {
        claimsBlocked.delete(manifest.id);
        mounted.add(manifest.id);
      },
      blockNewClaims: () => {
        claimsBlocked.add(manifest.id);
      },
      drain: async (deadline) => {
        const drains: Array<Promise<"drained" | "expired">> = [];
        if (manifest.contributions.jobs.length > 0) {
          drains.push(drainJobs(manifest.contributions.jobs, deadline));
        }
        if (manifest.id === "printing") drains.push(drainPrinting(deadline));
        const results = await Promise.all(drains);
        return results.includes("expired") ? "expired" : "drained";
      },
      unmount: () => {
        claimsBlocked.add(manifest.id);
        mounted.delete(manifest.id);
      },
    })
  );
  const adaptersById = new Map(adapters.map((adapter) => [adapter.manifest.id, adapter]));

  configurePrintingPluginLifecycleGate(() => canClaimWork("printing"));
  configureDailyBriefingContentSourceLifecycleGate(isContributionActive);
  configurePluginJobLifecycleGate((jobId) => {
    const owner = JOB_OWNERS[jobId as PluginJobId];
    return owner === undefined || canClaimWork(owner);
  });

  const coreLifecycle = createPluginLifecycle({
    store: options.store,
    adapters,
    now: options.now,
    operationId: options.operationId,
    drainDeadline: options.drainDeadline,
  });

  const mountCanonicalContributions = async (): Promise<void> => {
    for (const adapter of adapters) {
      if (isCanonicalActive(adapter.manifest.id)) {
        await adapter.mount();
      } else {
        await adapter.unmount();
      }
    }
  };

  const lifecycle: PluginLifecycle = {
    listCatalog: coreLifecycle.listCatalog,
    activate: async (pluginId) => {
      const entry = await coreLifecycle.activate(pluginId);
      if (entry.state === "active" && !mounted.has(pluginId)) {
        await adaptersById.get(pluginId)?.mount();
      }
      return entry;
    },
    deactivate: coreLifecycle.deactivate,
    reportFault: coreLifecycle.reportFault,
    reconcileAll: async () => {
      const report = await coreLifecycle.reconcileAll();
      await mountCanonicalContributions();
      return report;
    },
    isActive: isContributionActive,
    canClaimWork,
  };

  return { adapters, lifecycle, isContributionActive };
}
