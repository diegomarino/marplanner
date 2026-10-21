// Code-first OpenAPI: route schemas for the telemetry HTTP surface.
// These zod schemas are the single source of truth for docs/api/openapi.json
// (npm run generate:openapi). They document the HTTP contract; validation stays in
// src/server/modules/* so error envelopes remain byte-compatible.
import { z } from "zod";
import { component, defineRouteSchemas } from "./zod";
import { ValidationError, authenticationBackoffResponse } from "./common";

export const BuildInfo = component(
  "BuildInfo",
  z.strictObject({
    sha: z.string().nullable(),
    subject: z.string().nullable().meta({ description: "First line of the commit message." }),
    builtAt: z.string().nullable().meta({
      format: "date-time",
      description: "Build time; null for a server running from source.",
    }),
  }),
  { description: "The commit a server or client bundle was built from; unknown parts are null." }
);

export const ClientLogBatch = component(
  "ClientLogBatch",
  z.strictObject({
    entries: z.array(
      z.unknown().meta({
        description:
          "Each raw entry is validated independently; invalid entries and entries beyond the first 100 are dropped and counted. ClientLogEntryInput describes an admissible entry.",
      })
    ),
  })
);

export const ClientLogLevel = component(
  "ClientLogLevel",
  z.enum(["debug", "info", "warn", "error"])
);

export const ClientLogEntryInput = component(
  "ClientLogEntryInput",
  z.strictObject({
    level: ClientLogLevel,
    component: z.string().min(1).max(64),
    message: z.string().min(1).max(256),
    data: z
      .unknown()
      .meta({
        description: "Arbitrary structured diagnostic values; bounded and redacted at ingest.",
      })
      .optional(),
    eventTime: z
      .int()
      .meta({
        description: "Client-claimed epoch ms; advisory only (received_at is authoritative).",
      })
      .optional(),
  })
);

export const ClientLogIngestResult = component(
  "ClientLogIngestResult",
  z.strictObject({ accepted: z.int(), dropped: z.int() })
);

export const ClientLogRow = component(
  "ClientLogRow",
  z.strictObject({
    id: z.string(),
    eventId: z.string(),
    eventTime: z.int().nullable(),
    receivedAt: z.int(),
    level: ClientLogLevel,
    component: z.string(),
    message: z.string(),
    data: z
      .string()
      .nullable()
      .meta({ description: "Redacted, bounded JSON text exactly as stored, or null." }),
  })
);

export const ClientLogPage = component(
  "ClientLogPage",
  z.strictObject({ rows: z.array(ClientLogRow).max(50), nextCursor: z.string().nullable() })
);

export const SystemStatus = component(
  "SystemStatus",
  z.strictObject({
    status: z.enum(["ok"]),
    checkedAt: z.string().meta({ format: "date-time" }),
    uptimeSeconds: z
      .int()
      .min(0)
      .meta({ description: "Whole seconds since the server process started." }),
    build: BuildInfo,
  })
);

export const telemetrySchemas = defineRouteSchemas({
  /** GET /api/telemetry/client-log */
  readClientLog: {
    operationId: "readClientLog",
    tags: ["telemetry"],
    summary: "Read the client log, filtered and cursor-paged (telemetry:admin)",
    security: [{ deviceKeyCookie: [] }],
    querystring: z.object({
      level: ClientLogLevel.optional(),
      component: z.string().optional(),
      from: z
        .int()
        .meta({ description: "Inclusive lower bound on received_at (epoch ms)." })
        .optional(),
      to: z
        .int()
        .meta({ description: "Inclusive upper bound on received_at (epoch ms)." })
        .optional(),
      cursor: z
        .string()
        .meta({ description: "Opaque continuation cursor from a previous page." })
        .optional(),
    }),
    response: {
      200: {
        description: "Newest-first page, server-hard-capped at 50 rows.",
        content: { "application/json": { schema: ClientLogPage } },
      },
      400: {
        description: "Invalid filter or cursor.",
        content: { "application/json": { schema: ValidationError } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** POST /api/telemetry/client-log */
  ingestClientLog: {
    operationId: "ingestClientLog",
    tags: ["telemetry"],
    summary: "Ingest a bounded batch of client log entries (telemetry:write)",
    security: [{ deviceKeyCookie: [] }],
    body: ClientLogBatch,
    response: {
      200: {
        description:
          "Batch processed best-effort. Invalid entries and flood-dropped entries are counted in `dropped`; the response is 200 even when every entry was dropped.\n",
        content: { "application/json": { schema: ClientLogIngestResult } },
      },
      400: {
        description: "Structurally unparseable body (not JSON / not the batch shape).",
        content: { "application/json": { schema: ValidationError } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** GET /api/telemetry/system-status */
  readSystemStatus: {
    operationId: "readSystemStatus",
    tags: ["telemetry"],
    summary:
      "Report the running server's health and the commit it was built from (telemetry:admin)",
    security: [{ deviceKeyCookie: [] }],
    response: {
      200: {
        description: "The server answered; `build` names what is deployed.",
        content: { "application/json": { schema: SystemStatus } },
      },
      429: authenticationBackoffResponse,
    },
  },
});
