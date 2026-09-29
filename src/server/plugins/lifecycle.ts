import type {
  PluginCatalogEntry,
  PluginId,
  PluginState,
  PluginTargetState,
} from "../../shared/plugins.js";
import { projectManifestContributions } from "./manifest.js";
import { PluginLifecycleBusyError, PluginLifecycleError, SAFE_LIFECYCLE_ERRORS } from "./errors.js";
import type { PluginDrainDeadline, PluginRuntimeAdapter } from "./runtime.js";
import type {
  PluginLifecycleOperation,
  PluginLifecyclePhase,
  SqlitePluginLifecycleStore,
} from "./store.js";

export interface PluginFault {
  readonly code: "contribution_failed";
}

export interface PluginReconcileReport {
  readonly results: readonly { readonly pluginId: PluginId; readonly state: PluginState }[];
}

export interface PluginLifecycle {
  listCatalog(): Promise<readonly PluginCatalogEntry[]>;
  activate(pluginId: PluginId): Promise<PluginCatalogEntry>;
  deactivate(pluginId: PluginId): Promise<PluginCatalogEntry>;
  reportFault(pluginId: PluginId, fault: PluginFault): Promise<void>;
  reconcileAll(): Promise<PluginReconcileReport>;
  isActive(pluginId: PluginId): boolean;
  canClaimWork(pluginId: PluginId): boolean;
}

export interface PluginLifecycleOptions {
  readonly store: SqlitePluginLifecycleStore;
  readonly adapters: readonly PluginRuntimeAdapter[];
  readonly now: () => string;
  readonly operationId: (pluginId: PluginId) => string;
  readonly drainDeadline: (pluginId: PluginId) => PluginDrainDeadline;
}

class PluginPersistenceError extends PluginLifecycleError {
  constructor() {
    super("reconciliation_failed");
  }
}

export function createPluginLifecycle(_options: PluginLifecycleOptions): PluginLifecycle {
  const { store, now, operationId, drainDeadline } = _options;
  const adapters = new Map(_options.adapters.map((adapter) => [adapter.manifest.id, adapter]));
  const inFlight = new Map<
    PluginId,
    { readonly targetState: PluginTargetState; readonly promise: Promise<PluginCatalogEntry> }
  >();

  const persist = <T>(action: () => T): T => {
    try {
      return action();
    } catch {
      throw new PluginPersistenceError();
    }
  };

  const adapterFor = (pluginId: PluginId): PluginRuntimeAdapter => {
    const adapter = adapters.get(pluginId);
    if (!adapter) throw new Error(`Plugin runtime adapter is missing for ${pluginId}.`);
    return adapter;
  };

  const catalogEntry = (pluginId: PluginId): PluginCatalogEntry => {
    const adapter = adapterFor(pluginId);
    const registry = persist(() => store.getRegistry(pluginId));
    const operation = persist(() => store.getOperation(pluginId));
    return {
      id: pluginId,
      label: adapter.manifest.labelKey,
      description: adapter.manifest.descriptionKey,
      trustTier: adapter.manifest.trustTier,
      contributions: projectManifestContributions(adapter.manifest.contributions),
      requirements: adapter.manifest.requirements,
      settingsSchema: adapter.manifest.settingsSchema,
      state: registry.state,
      operation:
        operation === null
          ? null
          : { targetState: operation.targetState, startedAt: operation.startedAt },
      health: {
        status: registry.error === null ? "healthy" : "attention",
        code: registry.error?.code ?? null,
      },
      updatedAt: registry.updatedAt,
      error: registry.error,
    };
  };

  const quiesce = async (adapter: PluginRuntimeAdapter): Promise<void> => {
    try {
      adapter.blockNewClaims();
    } catch {
      // Best-effort containment continues through every quiescence stage.
    }
    try {
      await adapter.unmount();
    } catch {
      // The durable errored state remains the public truth even if teardown also fails.
    }
  };

  const errorCodeForPhase = (phase: PluginLifecyclePhase) => {
    switch (phase) {
      case "preparing-settings":
        return "settings_initialization_failed" as const;
      case "running-migrations":
        return "migration_failed" as const;
      case "mounting":
        return "runtime_mount_failed" as const;
      case "blocking-claims":
      case "draining":
        return "drain_failed" as const;
      case "unmounting":
        return "runtime_unmount_failed" as const;
      case "committing-active":
      case "committing-inactive":
        return "reconciliation_failed" as const;
    }
  };

  const fail = async (
    pluginId: PluginId,
    adapter: PluginRuntimeAdapter,
    phase: PluginLifecyclePhase
  ): Promise<never> => {
    const code = errorCodeForPhase(phase);
    await quiesce(adapter);
    try {
      persist(() => store.fail(pluginId, SAFE_LIFECYCLE_ERRORS[code], now()));
    } catch (error) {
      if (error instanceof PluginPersistenceError) {
        throw new PluginLifecycleError("reconciliation_failed");
      }
      throw error;
    }
    throw new PluginLifecycleError(code);
  };

  const containPersistenceFailure = async (
    pluginId: PluginId,
    adapter: PluginRuntimeAdapter
  ): Promise<never> => {
    await quiesce(adapter);
    try {
      store.fail(pluginId, SAFE_LIFECYCLE_ERRORS.reconciliation_failed, now());
    } catch {
      // Keep the prior durable cursor when SQLite cannot settle the failure.
    }
    throw new PluginLifecycleError("reconciliation_failed");
  };

  const runActivation = async (
    operation: PluginLifecycleOperation,
    adapter: PluginRuntimeAdapter
  ): Promise<PluginCatalogEntry> => {
    let phase = operation.phase;
    try {
      switch (phase) {
        case "preparing-settings":
          await adapter.ensureSettingsDefaults();
          phase = "running-migrations";
          persist(() => store.setPhase(operation.pluginId, phase, now()));
        // Fall through: each persisted phase records the next idempotent action.
        case "running-migrations":
          await adapter.runPendingMigrations();
          phase = "mounting";
          persist(() => store.setPhase(operation.pluginId, phase, now()));
        // Fall through.
        case "mounting":
          await adapter.mount();
          phase = "committing-active";
          persist(() => store.setPhase(operation.pluginId, phase, now()));
        // Fall through.
        case "committing-active":
          persist(() => store.complete(operation.pluginId, "active", now()));
          return catalogEntry(operation.pluginId);
        default:
          return fail(operation.pluginId, adapter, phase);
      }
    } catch (error) {
      if (error instanceof PluginPersistenceError) {
        return containPersistenceFailure(operation.pluginId, adapter);
      }
      if (error instanceof PluginLifecycleError) throw error;
      return fail(operation.pluginId, adapter, phase);
    }
  };

  const runDeactivation = async (
    operation: PluginLifecycleOperation,
    adapter: PluginRuntimeAdapter
  ): Promise<PluginCatalogEntry> => {
    let phase = operation.phase;
    try {
      adapter.blockNewClaims();
      switch (phase) {
        case "blocking-claims":
          phase = "draining";
          persist(() => store.setPhase(operation.pluginId, phase, now()));
        // Fall through: claim blocking is deliberately re-established after every restart.
        case "draining": {
          const result = await adapter.drain(drainDeadline(operation.pluginId));
          if (result === "expired") throw new PluginLifecycleError("drain_failed");
          phase = "unmounting";
          persist(() => store.setPhase(operation.pluginId, phase, now()));
        }
        // Fall through.
        case "unmounting":
          await adapter.unmount();
          phase = "committing-inactive";
          persist(() => store.setPhase(operation.pluginId, phase, now()));
        // Fall through.
        case "committing-inactive":
          persist(() => store.complete(operation.pluginId, "inactive", now()));
          return catalogEntry(operation.pluginId);
        default:
          return fail(operation.pluginId, adapter, phase);
      }
    } catch (error) {
      if (error instanceof PluginPersistenceError) {
        return containPersistenceFailure(operation.pluginId, adapter);
      }
      if (error instanceof PluginLifecycleError && error.code !== "drain_failed") throw error;
      return fail(operation.pluginId, adapter, phase);
    }
  };

  const settleInterruptedActivation = async (
    operation: PluginLifecycleOperation,
    adapter: PluginRuntimeAdapter
  ): Promise<PluginCatalogEntry> => {
    await quiesce(adapter);
    persist(() =>
      store.fail(operation.pluginId, SAFE_LIFECYCLE_ERRORS.reconciliation_failed, now())
    );
    return catalogEntry(operation.pluginId);
  };

  const settleContributionFault = async (
    operation: PluginLifecycleOperation,
    adapter: PluginRuntimeAdapter
  ): Promise<PluginCatalogEntry> => {
    await quiesce(adapter);
    persist(() => store.fail(operation.pluginId, SAFE_LIFECYCLE_ERRORS.contribution_failed, now()));
    return catalogEntry(operation.pluginId);
  };

  const resume = (
    operation: PluginLifecycleOperation,
    adapter: PluginRuntimeAdapter
  ): Promise<PluginCatalogEntry> => {
    if (operation.targetState === "active") return runActivation(operation, adapter);
    const registry = persist(() => store.getRegistry(operation.pluginId));
    return registry.error?.code === "contribution_failed"
      ? settleContributionFault(operation, adapter)
      : runDeactivation(operation, adapter);
  };

  const transition = (
    pluginId: PluginId,
    targetState: PluginTargetState
  ): Promise<PluginCatalogEntry> => {
    const current = inFlight.get(pluginId);
    if (current) {
      return current.targetState === targetState
        ? current.promise
        : Promise.reject(new PluginLifecycleBusyError());
    }

    try {
      const durable = persist(() => store.getOperation(pluginId));
      if (durable && durable.targetState !== targetState) {
        return Promise.reject(new PluginLifecycleBusyError());
      }
      if (!durable && persist(() => store.getRegistry(pluginId)).state === targetState) {
        return Promise.resolve(catalogEntry(pluginId));
      }

      const adapter = adapterFor(pluginId);
      const operation =
        durable ??
        persist(() =>
          store.begin(
            pluginId,
            operationId(pluginId),
            targetState,
            targetState === "active" ? "preparing-settings" : "blocking-claims",
            now()
          )
        );
      const promise = resume(operation, adapter);
      inFlight.set(pluginId, { targetState, promise });
      void promise.then(
        () => inFlight.delete(pluginId),
        () => inFlight.delete(pluginId)
      );
      return promise;
    } catch (error) {
      return Promise.reject(error);
    }
  };

  return {
    listCatalog: async () => _options.adapters.map(({ manifest }) => catalogEntry(manifest.id)),
    activate: (pluginId) => transition(pluginId, "active"),
    deactivate: (pluginId) => transition(pluginId, "inactive"),
    reportFault: async (pluginId, fault) => {
      if (inFlight.has(pluginId) || persist(() => store.getOperation(pluginId)) !== null) {
        throw new PluginLifecycleBusyError();
      }
      const adapter = adapterFor(pluginId);
      persist(() => store.beginFault(pluginId, operationId(pluginId), now()));
      await quiesce(adapter);
      persist(() => store.fail(pluginId, SAFE_LIFECYCLE_ERRORS[fault.code], now()));
    },
    reconcileAll: async () => {
      const results: Array<{ pluginId: PluginId; state: PluginState }> = [];
      let persistenceFailure: PluginLifecycleError | null = null;
      for (const operation of persist(() => store.listOperations())) {
        const adapter = adapterFor(operation.pluginId);
        try {
          await (operation.targetState === "active"
            ? settleInterruptedActivation(operation, adapter)
            : resume(operation, adapter));
        } catch (error) {
          // The failing operation has already been settled to a safe canonical error.
          if (error instanceof PluginLifecycleError && error.code === "reconciliation_failed") {
            persistenceFailure ??= error;
          }
        }
        results.push({
          pluginId: operation.pluginId,
          state: persist(() => store.getRegistry(operation.pluginId)).state,
        });
      }
      if (persistenceFailure) throw persistenceFailure;
      return { results };
    },
    isActive: (pluginId) => persist(() => store.getRegistry(pluginId)).state === "active",
    canClaimWork: (pluginId) =>
      persist(() => store.getRegistry(pluginId)).state === "active" &&
      persist(() => store.getOperation(pluginId)) === null,
  };
}
