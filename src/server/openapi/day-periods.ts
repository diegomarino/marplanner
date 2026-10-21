// Code-first OpenAPI: route schemas for the day-periods HTTP surface.
// These zod schemas are the single source of truth for docs/api/openapi.json
// (npm run generate:openapi). They document the HTTP contract; validation stays in
// src/server/modules/* so error envelopes remain byte-compatible.
import { z } from "zod";
import { component, defineRouteSchemas } from "./zod";
import { ErrorSchema, authenticationBackoffResponse } from "./common";

export const PeriodId = component(
  "PeriodId",
  z.enum(["morning", "afternoon", "evening", "night"]),
  { description: "Stable slug of one of the four fixed periods." }
);

export const ActivePeriodResult = component(
  "ActivePeriodResult",
  z.strictObject({ activeId: PeriodId })
);

export const DayPeriod = component(
  "DayPeriod",
  z.strictObject({
    id: PeriodId,
    labelKey: z.string().meta({
      description: "i18n translation key (INV-04); never user-editable free text.",
      example: "dayPeriod.morning",
    }),
    start: z.string().regex(new RegExp("^([01][0-9]|2[0-3]):[0-5][0-9]$")).meta({
      description: "Local start boundary HH:MM (the only stored boundary; end is derived).",
      example: "05:00",
    }),
    sortOrder: z
      .int()
      .min(0)
      .max(3)
      .meta({ description: "Canonical cycle position (morning=0 … night=3)." }),
  })
);

export const EditStartRequest = component(
  "EditStartRequest",
  z.strictObject({
    start: z
      .string()
      .regex(new RegExp("^([01][0-9]|2[0-3]):[0-5][0-9]$"))
      .meta({ example: "11:30" }),
  })
);

export const dayPeriodsSchemas = defineRouteSchemas({
  /** GET /api/day-periods */
  listDayPeriods: {
    operationId: "listDayPeriods",
    tags: ["day-periods"],
    summary: "List the four day periods (ordered by start). Public vocabulary — no PIN required.",
    security: [{ deviceKeyCookie: [] }],
    response: {
      200: {
        description:
          "Exactly four periods in ascending start order. Exposes no add/delete/reorder.",
        content: { "application/json": { schema: z.array(DayPeriod).min(4).max(4) } },
      },
      401: {
        description: "Missing/invalid device key.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** GET /api/day-periods/active */
  getActiveDayPeriod: {
    operationId: "getActiveDayPeriod",
    tags: ["day-periods"],
    summary: "The active period now, in the household timezone (server-authoritative, Option C).",
    security: [{ deviceKeyCookie: [] }],
    response: {
      200: {
        description:
          "The latest period whose start <= now; before the first start, the wrapping night.",
        content: { "application/json": { schema: ActivePeriodResult } },
      },
      401: {
        description: "Missing/invalid device key.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** PATCH /api/day-periods/{id} */
  editDayPeriodStart: {
    operationId: "editDayPeriodStart",
    tags: ["day-periods"],
    summary: "Edit one period's start boundary (validated strict order + uniqueness).",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: PeriodId }),
    body: EditStartRequest,
    response: {
      200: {
        description: "The updated period. Neighbours' derived ends follow (re-read via GET).",
        content: { "application/json": { schema: DayPeriod } },
      },
      400: {
        description: "Strict-order or uniqueness violation — nothing persisted.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: {
        description: "Missing/invalid device key.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: {
        description: "Unknown period id.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
      500: {
        description:
          "Unexpected storage failure — nothing persisted. Opaque `internal_error` envelope; details go to the server log only.",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  },
});
