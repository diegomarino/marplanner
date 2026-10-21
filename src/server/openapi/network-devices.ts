// Code-first OpenAPI: route schemas for the network-devices HTTP surface.
// These zod schemas are the single source of truth for docs/api/openapi.json
// (npm run generate:openapi). They document the HTTP contract; validation stays in
// src/server/modules/* so error envelopes remain byte-compatible.
import { z } from "zod";
import { component, defineRouteSchemas, noContent } from "./zod";
import { authUnauthorizedResponse, authenticationBackoffResponse } from "./common";

export const ControllerErrorResponse = component(
  "ControllerErrorResponse",
  z.strictObject({
    error: z.string(),
    code: z.string().meta({
      description:
        "machine code identifying which controller-degradation state this 502 represents — `controller_unavailable`, `controller_rejected`, or `controller_unreachable` (the three `NetworkDeviceController*Error` classes in src/server/modules/network-devices/index.ts, mapped via src/server/routes/network-devices.ts). Unlike the shared ErrorResponse, both fields are ALWAYS present on this response — every 502-mapped error class carries its own `code`.",
    }),
  })
);

export const EditDeviceRequest = component(
  "EditDeviceRequest",
  z.strictObject({
    alias: z.string().min(1).max(80).optional(),
    memberId: z.string().nullable().optional(),
  }),
  { description: "The MAC is NOT editable — no property for it exists (INV-02)." }
);

export const LiveCacheState = component(
  "LiveCacheState",
  z.enum(["unconfigured", "cold", "stale", "freshEmpty", "fresh"])
);

export const LiveClient = component(
  "LiveClient",
  z.strictObject({
    mac: z.string().meta({ description: "canonical lowercase colon-separated" }),
    displayName: z.string().nullable(),
    isBlocked: z.boolean(),
  })
);

export const LiveClientsResponse = component(
  "LiveClientsResponse",
  z.strictObject({ state: LiveCacheState, clients: z.array(LiveClient) })
);

export const NetworkDeviceErrorResponse = component(
  "NetworkDeviceErrorResponse",
  z.strictObject({
    error: z.string(),
    code: z
      .string()
      .meta({
        description:
          "machine code; `reselect_required` is the dedicated cache-rotation rejection (AC-03)",
      })
      .optional(),
  })
);

export const RegisteredDevice = component(
  "RegisteredDevice",
  z.strictObject({
    id: z.string(),
    mac: z.string(),
    alias: z.string(),
    memberId: z.string().nullable(),
    memberLabel: z.string().nullable(),
    memberInactive: z.boolean(),
    isBlocked: z.boolean().meta({ description: "the local BELIEF mirror (INV-04)" }),
    beliefDiverged: z.boolean().meta({
      description:
        "true when a mirror write failed after controller success (AC-02); cleared by the converging poll",
    }),
    lastSeenAt: z.int().nullable().meta({ description: "epoch ms, observation-only (INV-10)" }),
    liveStatus: z
      .enum(["online", "notDetected", "unknown"])
      .meta({ description: "derived at read time, never persisted (INV-04)" }),
  })
);

export const NetworkDevicesListResponse = component(
  "NetworkDevicesListResponse",
  z.strictObject({ devices: z.array(RegisteredDevice), cacheState: LiveCacheState })
);

export const RegisterDeviceRequest = component(
  "RegisterDeviceRequest",
  z.strictObject({
    mac: z.string().meta({
      description:
        "must be present in the CURRENT fresh live cache (AC-03) — otherwise 409 reselect",
    }),
    alias: z.string().min(1).max(80),
    memberId: z
      .string()
      .nullable()
      .meta({ description: "must resolve to an ACTIVE member (AC-07)" })
      .optional(),
  })
);

export const networkDevicesSchemas = defineRouteSchemas({
  /** GET /api/network-devices */
  getNetworkDevices: {
    operationId: "getNetworkDevices",
    tags: ["network-devices"],
    summary: "List the curated registry with derived live status (ZERO writes — INV-05)",
    security: [{ deviceKeyCookie: [] }],
    response: {
      200: {
        description: "The curated registry with derived live status.",
        content: { "application/json": { schema: NetworkDevicesListResponse } },
      },
      401: authUnauthorizedResponse,
      403: noContent("unauthenticated, unknown or out-of-scope key rejected (AC-06)"),
      429: authenticationBackoffResponse,
    },
  },
  /** POST /api/network-devices */
  postNetworkDevices: {
    operationId: "postNetworkDevices",
    tags: ["network-devices"],
    summary: "Register a device from the fresh picker cache",
    security: [{ deviceKeyCookie: [] }],
    body: RegisterDeviceRequest,
    response: {
      201: {
        description: "Device registered.",
        content: { "application/json": { schema: RegisteredDevice } },
      },
      400: noContent("validation (alias, inactive member)"),
      401: authUnauthorizedResponse,
      403: noContent("unauthenticated, unknown or out-of-scope key rejected (AC-06)"),
      409: {
        description:
          "MAC not in the current fresh cache (`reselect_required`) or already registered (INV-01)",
        content: { "application/json": { schema: NetworkDeviceErrorResponse } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** GET /api/network-devices/live-clients */
  getNetworkDevicesLiveClients: {
    operationId: "getNetworkDevicesLiveClients",
    tags: ["network-devices"],
    summary: "Picker feed — the controller's current live clients",
    security: [{ deviceKeyCookie: [] }],
    response: {
      200: {
        description: "The live-client picker feed.",
        content: { "application/json": { schema: LiveClientsResponse } },
      },
      401: authUnauthorizedResponse,
      403: noContent("unauthenticated, unknown or out-of-scope key rejected (AC-06)"),
      429: authenticationBackoffResponse,
    },
  },
  /** PATCH /api/network-devices/{id} */
  patchNetworkDevicesById: {
    operationId: "patchNetworkDevicesById",
    tags: ["network-devices"],
    summary: "Edit alias/assignment (local-only; MAC immutable)",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    body: EditDeviceRequest,
    response: {
      200: {
        description: "Device updated.",
        content: { "application/json": { schema: RegisteredDevice } },
      },
      400: noContent("validation (inactive member on NEW assignment)"),
      401: authUnauthorizedResponse,
      403: noContent("unauthenticated, unknown or out-of-scope key rejected (AC-06)"),
      404: noContent("unknown device"),
      429: authenticationBackoffResponse,
    },
  },
  /** DELETE /api/network-devices/{id} */
  deleteNetworkDevicesById: {
    operationId: "deleteNetworkDevicesById",
    tags: ["network-devices"],
    summary: "Delete (local-only — NO controller call ever, AC-04)",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    response: {
      204: noContent("always succeeds locally, blocked devices included"),
      401: authUnauthorizedResponse,
      403: noContent("unauthenticated, unknown or out-of-scope key rejected (AC-06)"),
      404: noContent("unknown device"),
      429: authenticationBackoffResponse,
    },
  },
  /** POST /api/network-devices/{id}/block */
  postNetworkDevicesByIdBlock: {
    operationId: "postNetworkDevicesByIdBlock",
    tags: ["network-devices"],
    summary: "Block internet for the device (intent → controller → mirror)",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    response: {
      200: {
        description:
          "Controller accepted; body reflects the belief (possibly beliefDiverged when the mirror write failed — AC-02).",
        content: { "application/json": { schema: RegisteredDevice } },
      },
      401: authUnauthorizedResponse,
      403: noContent("unauthenticated, unknown or out-of-scope key rejected (AC-06)"),
      404: noContent("unknown device"),
      429: authenticationBackoffResponse,
      502: {
        description: "controller rejected/unreachable — nothing mirrored",
        content: { "application/json": { schema: ControllerErrorResponse } },
      },
    },
  },
  /** POST /api/network-devices/{id}/unblock */
  postNetworkDevicesByIdUnblock: {
    operationId: "postNetworkDevicesByIdUnblock",
    tags: ["network-devices"],
    summary: "Restore internet (symmetric to block)",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    response: {
      200: {
        description: "Device unblocked.",
        content: { "application/json": { schema: RegisteredDevice } },
      },
      401: authUnauthorizedResponse,
      403: noContent("unauthenticated, unknown or out-of-scope key rejected (AC-06)"),
      404: noContent("unknown device"),
      429: authenticationBackoffResponse,
      502: {
        description: "controller rejected/unreachable — nothing mirrored",
        content: { "application/json": { schema: ControllerErrorResponse } },
      },
    },
  },
});
