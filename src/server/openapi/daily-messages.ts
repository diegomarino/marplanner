// Code-first OpenAPI: route schemas for the daily-messages HTTP surface.
// These zod schemas are the single source of truth for docs/api/openapi.json
// (npm run generate:openapi). They document the HTTP contract; validation stays in
// src/server/modules/* so error envelopes remain byte-compatible.
import { z } from "zod";
import { component, defineRouteSchemas, noContent } from "./zod";
import { ErrorSchema, PluginUnavailable, authenticationBackoffResponse } from "./common";

export const DailyMessage = component(
  "DailyMessage",
  z.strictObject({
    id: z.string(),
    memberId: z.string(),
    date: z.string().meta({ description: "YYYY-MM-DD (household-local)" }),
    text: z.string().min(1).max(500).meta({ description: "stored verbatim." }),
    createdAt: z.int(),
    updatedAt: z.int(),
  })
);

export const DailyMessageUpsert = component(
  "DailyMessageUpsert",
  z.strictObject({
    memberId: z.string().meta({ description: "must reference an active members.id." }),
    date: z.string().meta({ description: "YYYY-MM-DD (household-local)" }),
    text: z.string().min(1).max(500).meta({
      description:
        "stored byte-for-byte verbatim (AC-07). Blank-after-trim / over-500-char rejection (AC-03/FR-005) is enforced on writes.\n",
    }),
  })
);

export const dailyMessagesSchemas = defineRouteSchemas({
  /** GET /api/daily-messages */
  getDailyMessages: {
    operationId: "getDailyMessages",
    tags: ["daily-messages"],
    summary:
      "Window list — date-ascending messages for a member over the half-open window `[from, from+days)`, missing dates absent (INV-08). `days` outside `[1, 60]` -> 400 (AC-05). Tolerant read: gates on member existence not active-status, so an archived member's historical rows stay readable (P2-B); an unknown member -> 404, a valid member with no messages -> 200 empty list (AC-04).\n",
    security: [{ deviceKeyCookie: [] }],
    querystring: z.object({
      memberId: z.string(),
      from: z.string().meta({ description: "YYYY-MM-DD (window start, inclusive)" }),
      days: z.int().min(1).max(60),
    }),
    response: {
      200: {
        description: "date-ascending messages in the window (possibly empty)",
        content: { "application/json": { schema: z.array(DailyMessage) } },
      },
      400: {
        description: "days out of range, or an invalid from date",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: noContent("missing/invalid device key"),
      404: {
        description: "unknown member",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** PUT /api/daily-messages */
  putDailyMessages: {
    operationId: "putDailyMessages",
    tags: ["daily-messages"],
    summary:
      "Create or replace the message for (memberId, date) — upsert on the UNIQUE (member_id, date) pair (INV-01/AC-01). A non-object/array body or an unsupported field rejects with 400 (#397); Text, date and active-member validation are enforced on writes.\n",
    security: [{ deviceKeyCookie: [] }],
    body: DailyMessageUpsert,
    response: {
      200: {
        description: "upserted (created or replaced)",
        content: { "application/json": { schema: DailyMessage } },
      },
      400: {
        description: "non-object/array body, or an unsupported field (#397)",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: noContent("missing/invalid device key"),
      429: authenticationBackoffResponse,
    },
  },
  /** DELETE /api/daily-messages */
  deleteDailyMessages: {
    operationId: "deleteDailyMessages",
    tags: ["daily-messages"],
    summary:
      "Delete the message for (memberId, date) — a SEPARATE idempotent command, never implied by a blank write (AC-03/FR-006). A missing message OR an unknown member is a no-op success (204), never a 404.\n",
    security: [{ deviceKeyCookie: [] }],
    querystring: z.object({
      memberId: z.string(),
      date: z.string().meta({ description: "YYYY-MM-DD" }),
    }),
    response: {
      204: noContent("deleted, or already absent (idempotent no-op)"),
      400: {
        description: "missing/malformed query parameters",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: noContent("missing/invalid device key"),
      429: authenticationBackoffResponse,
    },
  },
  /** GET /api/daily-messages/current */
  getDailyMessagesCurrent: {
    operationId: "getDailyMessagesCurrent",
    tags: ["daily-messages"],
    summary:
      "Outbound single read — the current message for (memberId, date), computed LIVE every call (no stored snapshot). Consumed by Daily Briefing. Tolerant read: gates on member existence not active-status (INV-08/AC-04, P2-B) — an unknown member -> 404, an archived member's historical row stays readable.\n",
    security: [{ deviceKeyCookie: [] }],
    querystring: z.object({
      memberId: z.string(),
      date: z.string().meta({ description: "YYYY-MM-DD" }),
    }),
    response: {
      200: {
        description: "the current message, or null when the member has none that date",
        content: { "application/json": { schema: z.xor([DailyMessage, z.null()]) } },
      },
      400: {
        description: "malformed date (DAILY-MESSAGES-INV-03)",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: noContent("missing/invalid device key"),
      404: {
        description: "unknown member",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
      503: {
        description: "The owning plugin is inactive or unavailable.",
        content: { "application/json": { schema: PluginUnavailable } },
      },
    },
  },
});
