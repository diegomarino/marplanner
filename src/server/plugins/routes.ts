import type { FastifyInstance, FastifyReply } from "fastify";
import { requireFullAccess } from "../auth/capability.js";
import { PLUGIN_IDS, type PluginCatalogEntry, type PluginId } from "../../shared/plugins.js";
import { PluginLifecycleBusyError } from "./errors.js";
import type { PluginLifecycle } from "./lifecycle.js";

const PLUGIN_ID_SET: ReadonlySet<string> = new Set(PLUGIN_IDS);
const FAULT_CODES: ReadonlySet<string> = new Set([
  "contribution_render_failed",
  "contribution_start_failed",
]);

function pluginIdFrom(params: unknown): PluginId | null {
  if (params === null || typeof params !== "object") return null;
  const pluginId = (params as { pluginId?: unknown }).pluginId;
  return typeof pluginId === "string" && PLUGIN_ID_SET.has(pluginId)
    ? (pluginId as PluginId)
    : null;
}

function sendPluginNotFound(reply: FastifyReply) {
  return reply.code(404).send({ code: "plugin_not_found", message: "Plugin not found." });
}

function sendCatalogUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    code: "plugin_catalog_unavailable",
    message: "The plugin catalog is temporarily unavailable.",
  });
}

async function snapshotPlugin(
  lifecycle: PluginLifecycle,
  pluginId: PluginId
): Promise<PluginCatalogEntry | null> {
  try {
    return (await lifecycle.listCatalog()).find((plugin) => plugin.id === pluginId) ?? null;
  } catch {
    return null;
  }
}

async function sendLifecycleError(reply: FastifyReply, plugin: PluginCatalogEntry, error: unknown) {
  if (error instanceof PluginLifecycleBusyError) {
    return reply.code(409).send({
      code: "plugin_lifecycle_busy",
      message: "A lifecycle operation is already in progress for this plugin.",
      plugin,
    });
  }
  return reply.code(503).send({
    code: "plugin_lifecycle_failed",
    message: "The plugin could not complete the requested lifecycle change.",
    plugin,
  });
}

function parseFaultBody(body: unknown): { code: "contribution_failed" } | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !FAULT_CODES.has(String(record.code))) return null;
  return { code: "contribution_failed" };
}

export async function pluginRoutes(
  app: FastifyInstance,
  lifecycle: PluginLifecycle
): Promise<void> {
  const preHandler = requireFullAccess();

  app.get("/api/plugins", { preHandler }, async (_request, reply) => {
    try {
      return reply.code(200).send({ plugins: await lifecycle.listCatalog() });
    } catch {
      return sendCatalogUnavailable(reply);
    }
  });

  for (const target of ["activate", "deactivate"] as const) {
    app.post(`/api/plugins/:pluginId/${target}`, { preHandler }, async (request, reply) => {
      const pluginId = pluginIdFrom(request.params);
      if (pluginId === null) return sendPluginNotFound(reply);
      const snapshot = await snapshotPlugin(lifecycle, pluginId);
      if (snapshot === null) return sendCatalogUnavailable(reply);
      try {
        const plugin = await lifecycle[target](pluginId);
        return reply.code(200).send(plugin);
      } catch (error) {
        return sendLifecycleError(
          reply,
          (await snapshotPlugin(lifecycle, pluginId)) ?? snapshot,
          error
        );
      }
    });
  }

  app.post("/api/plugins/:pluginId/fault", { preHandler }, async (request, reply) => {
    const pluginId = pluginIdFrom(request.params);
    if (pluginId === null) return sendPluginNotFound(reply);
    const fault = parseFaultBody(request.body);
    if (fault === null) {
      return reply.code(400).send({
        code: "invalid_plugin_fault",
        message: "The plugin fault report is invalid.",
      });
    }
    const snapshot = await snapshotPlugin(lifecycle, pluginId);
    if (snapshot === null) return sendCatalogUnavailable(reply);
    try {
      await lifecycle.reportFault(pluginId, fault);
      return reply.code(204).send();
    } catch (error) {
      return sendLifecycleError(
        reply,
        (await snapshotPlugin(lifecycle, pluginId)) ?? snapshot,
        error
      );
    }
  });
}
