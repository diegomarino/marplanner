import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PluginId } from "../../shared/plugins.js";
import { getDb } from "../db/client.js";
import type { PluginLifecycle } from "./lifecycle.js";
import { createServerPluginRuntime } from "./runtime.js";
import { SqlitePluginLifecycleStore } from "./store.js";

export type PluginRouteRegistrar = (app: FastifyInstance) => Promise<void>;

export const PLUGIN_UNAVAILABLE_RESPONSE = Object.freeze({
  code: "plugin_unavailable" as const,
  message: "This plugin is unavailable." as const,
});

const UNMIGRATED_PLUGIN_LIFECYCLE: PluginLifecycle = {
  listCatalog: async () => Promise.reject(new Error("Plugin lifecycle is not initialized")),
  activate: async () => Promise.reject(new Error("Plugin lifecycle is not initialized")),
  deactivate: async () => Promise.reject(new Error("Plugin lifecycle is not initialized")),
  reportFault: async () => Promise.reject(new Error("Plugin lifecycle is not initialized")),
  reconcileAll: async () => ({ results: [] }),
  isActive: () => false,
  canClaimWork: () => false,
};

/** Build the complete lifecycle, or remain unavailable before schema initialization. */
export function createServerPluginLifecycle(): PluginLifecycle {
  const lifecycleSchemaExists = getDb()
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'plugin_activation_registry'"
    )
    .get();
  // `buildApp` is also used for hermetic route-table introspection without migrations. That
  // environment remains fail-closed while production's entrypoint always migrates first.
  if (!lifecycleSchemaExists) return UNMIGRATED_PLUGIN_LIFECYCLE;

  return createServerPluginRuntime({
    store: new SqlitePluginLifecycleStore(() => getDb()),
    now: () => new Date().toISOString(),
    operationId: (pluginId) => `${pluginId}:${randomUUID()}`,
    drainDeadline: () => ({ expiresAt: new Date(Date.now() + 30_000).toISOString() }),
  }).lifecycle;
}

/** Registers plugin routes once and keeps their Fastify route table stable. Lifecycle changes only
 * affect this core-owned dispatch gate; routes are never added, removed, or re-registered at
 * runtime.
 */
export async function registerPluginHttp(
  app: FastifyInstance,
  lifecycle: PluginLifecycle,
  pluginId: PluginId,
  registerRoutes: PluginRouteRegistrar
): Promise<void> {
  await app.register(async (pluginScope) => {
    pluginScope.addHook(
      "onRequest",
      async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
        if (lifecycle.isActive(pluginId)) return;
        await reply.code(503).send(PLUGIN_UNAVAILABLE_RESPONSE);
      }
    );
    await registerRoutes(pluginScope);
  });
}
