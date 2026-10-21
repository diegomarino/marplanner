// Code-first OpenAPI: route schemas for the plugins HTTP surface.
// These zod schemas are the single source of truth for docs/api/openapi.json
// (npm run generate:openapi). They document the HTTP contract; validation stays in
// src/server/modules/* so error envelopes remain byte-compatible.
import { z } from "zod";
import { component, defineRouteSchemas, noContent, type RouteResponse } from "./zod";
import { authenticationBackoffResponse } from "./common";

export const ApiError = component(
  "ApiError",
  z.strictObject({ code: z.string(), message: z.string() })
);

export const ContributionIds = component(
  "ContributionIds",
  z.array(z.string().regex(new RegExp("^[a-z0-9]+(?:-[a-z0-9]+)*$"))),
  { uniqueItems: true }
);

export const ForbiddenError = component(
  "ForbiddenError",
  z.strictObject({ error: z.literal("forbidden"), message: z.string(), code: z.string() })
);

export const PluginId = component(
  "PluginId",
  z.enum([
    "daily-briefing",
    "printing",
    "weather",
    "time-announcements",
    "backups",
    "network-devices",
    "meals-recipes",
    "reminders",
    "daily-messages",
  ])
);

export const PluginContributionSummary = component(
  "PluginContributionSummary",
  z.strictObject({
    routes: ContributionIds,
    admin: ContributionIds,
    settings: ContributionIds,
    widgets: ContributionIds,
    services: ContributionIds,
    jobs: ContributionIds,
  })
);

export const PluginSettingDescriptor = component(
  "PluginSettingDescriptor",
  z.strictObject({
    key: z.string().regex(new RegExp("^[a-z][A-Za-z0-9]*$")),
    label: z.string().min(1),
    valueType: z.enum(["string", "number", "boolean", "enum", "object"]),
    required: z.boolean(),
    sensitive: z.boolean(),
  })
);

export const PluginState = component("PluginState", z.enum(["active", "inactive", "errored"]));

export const PluginOperation = component(
  "PluginOperation",
  z.strictObject({
    targetState: z.enum(["active", "inactive"]),
    startedAt: z.string().meta({ format: "date-time" }),
  })
);

export const PluginPublicErrorCode = component(
  "PluginPublicErrorCode",
  z.enum([
    "settings_initialization_failed",
    "migration_failed",
    "runtime_mount_failed",
    "drain_failed",
    "runtime_unmount_failed",
    "contribution_failed",
    "reconciliation_failed",
  ])
);

export const PluginHealth = component(
  "PluginHealth",
  z.strictObject({
    status: z.enum(["healthy", "attention"]),
    code: z.xor([PluginPublicErrorCode, z.null()]),
  })
);

export const PluginPublicError = component(
  "PluginPublicError",
  z.strictObject({
    code: PluginPublicErrorCode,
    message: z.enum([
      "Plugin settings could not be prepared.",
      "Plugin data could not be prepared.",
      "Plugin services could not be started.",
      "Plugin work could not stop safely.",
      "Plugin services could not be stopped.",
      "A plugin contribution failed.",
      "Plugin recovery requires attention.",
    ]),
  })
);

export const PluginCatalogEntry = component(
  "PluginCatalogEntry",
  z.strictObject({
    id: PluginId,
    label: z.string().min(1),
    description: z.string().min(1),
    trustTier: z.literal("first-party"),
    contributions: PluginContributionSummary,
    requirements: z.array(z.string().min(1)).meta({ uniqueItems: true }),
    settingsSchema: z.array(PluginSettingDescriptor),
    state: PluginState,
    operation: z.xor([PluginOperation, z.null()]),
    health: PluginHealth,
    updatedAt: z.string().meta({ format: "date-time" }),
    error: z.xor([PluginPublicError, z.null()]),
  })
);

export const PluginCatalogUnavailable = component(
  "PluginCatalogUnavailable",
  z.strictObject({
    code: z.literal("plugin_catalog_unavailable"),
    message: z.literal("The plugin catalog is temporarily unavailable."),
  })
);

export const PluginLifecycleFailed = component(
  "PluginLifecycleFailed",
  z.strictObject({
    code: z.literal("plugin_lifecycle_failed"),
    message: z.literal("The plugin could not complete the requested lifecycle change."),
    plugin: PluginCatalogEntry,
  })
);

export const UnauthorizedError = component(
  "UnauthorizedError",
  z.strictObject({ error: z.literal("unauthorized"), message: z.string(), code: z.string() })
);

export const catalogUnavailableResponse = {
  description: "The safe catalog snapshot could not be read",
  content: { "application/json": { schema: PluginCatalogUnavailable } },
} satisfies RouteResponse;

export const fullAccessRequiredResponse = {
  description: "The authenticated credential does not contain the `*` scope",
  content: { "application/json": { schema: ForbiddenError } },
} satisfies RouteResponse;

export const mutationUnavailableResponse = {
  description: "Lifecycle work failed safely or the pre-operation catalog snapshot was unavailable",
  content: {
    "application/json": { schema: z.xor([PluginLifecycleFailed, PluginCatalogUnavailable]) },
  },
} satisfies RouteResponse;

export const pluginBusyResponse = {
  description: "An opposite lifecycle target is already durable for this plugin",
  content: {
    "application/json": {
      schema: z.strictObject({
        code: z.literal("plugin_lifecycle_busy"),
        message: z.literal("A lifecycle operation is already in progress for this plugin."),
        plugin: PluginCatalogEntry,
      }),
    },
  },
} satisfies RouteResponse;

export const pluginNotFoundResponse = {
  description: "The path ID is not in the exact delivered cohort",
  content: { "application/json": { schema: ApiError } },
} satisfies RouteResponse;

export const unauthorizedResponse = {
  description: "No single valid established credential was presented",
  content: { "application/json": { schema: UnauthorizedError } },
} satisfies RouteResponse;

export const pluginsSchemas = defineRouteSchemas({
  /** GET /api/plugins */
  listPlugins: {
    operationId: "listPlugins",
    tags: ["plugins"],
    summary: "List the exact delivered first-party plugin catalog",
    security: [{ deviceKeyCookie: [] }, { integrationKey: [] }],
    response: {
      200: {
        description: "Authenticated catalog in manifest order",
        content: {
          "application/json": {
            schema: z.strictObject({ plugins: z.array(PluginCatalogEntry).min(9).max(9) }),
          },
        },
      },
      401: unauthorizedResponse,
      403: fullAccessRequiredResponse,
      429: authenticationBackoffResponse,
      503: catalogUnavailableResponse,
    },
  },
  /** POST /api/plugins/{pluginId}/activate */
  activatePlugin: {
    operationId: "activatePlugin",
    tags: ["plugins"],
    summary: "Idempotently activate one delivered plugin",
    security: [{ deviceKeyCookie: [] }, { integrationKey: [] }],
    params: z.object({ pluginId: PluginId }),
    response: {
      200: {
        description: "Current terminal plugin representation",
        content: { "application/json": { schema: PluginCatalogEntry } },
      },
      401: unauthorizedResponse,
      403: fullAccessRequiredResponse,
      404: pluginNotFoundResponse,
      409: pluginBusyResponse,
      429: authenticationBackoffResponse,
      503: mutationUnavailableResponse,
    },
  },
  /** POST /api/plugins/{pluginId}/deactivate */
  deactivatePlugin: {
    operationId: "deactivatePlugin",
    tags: ["plugins"],
    summary: "Idempotently deactivate one delivered plugin after bounded drain",
    security: [{ deviceKeyCookie: [] }, { integrationKey: [] }],
    params: z.object({ pluginId: PluginId }),
    response: {
      200: {
        description: "Current terminal plugin representation",
        content: { "application/json": { schema: PluginCatalogEntry } },
      },
      401: unauthorizedResponse,
      403: fullAccessRequiredResponse,
      404: pluginNotFoundResponse,
      409: pluginBusyResponse,
      429: authenticationBackoffResponse,
      503: mutationUnavailableResponse,
    },
  },
  /** POST /api/plugins/{pluginId}/fault */
  reportPluginFault: {
    operationId: "reportPluginFault",
    tags: ["plugins"],
    summary: "Report an allow-listed client contribution fault without raw details",
    security: [{ deviceKeyCookie: [] }, { integrationKey: [] }],
    params: z.object({ pluginId: PluginId }),
    body: z.strictObject({
      code: z.enum(["contribution_render_failed", "contribution_start_failed"]),
    }),
    response: {
      204: noContent("Fault contained or already contained"),
      400: {
        description: "Body contains an unknown field, raw detail, or unsupported code",
        content: { "application/json": { schema: ApiError } },
      },
      401: unauthorizedResponse,
      403: fullAccessRequiredResponse,
      404: pluginNotFoundResponse,
      409: pluginBusyResponse,
      429: authenticationBackoffResponse,
      503: mutationUnavailableResponse,
    },
  },
});
