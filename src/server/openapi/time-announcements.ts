// Code-first OpenAPI: route schemas for the time-announcements HTTP surface.
// These zod schemas are the single source of truth for docs/api/openapi.json
// (npm run generate:openapi). They document the HTTP contract; validation stays in
// src/server/modules/* so error envelopes remain byte-compatible.
import { z } from "zod";
import { component, defineRouteSchemas, noContent } from "./zod";
import {
  AuthForbidden,
  PluginUnavailable,
  ValidationError,
  authenticationBackoffResponse,
} from "./common";

export const NotFoundError = component(
  "NotFoundError",
  z.strictObject({ error: z.enum(["not_found"]), message: z.string() })
);

export const OverlapError = component(
  "OverlapError",
  z.strictObject({
    error: z.enum(["active_overlap"]),
    message: z.string().meta({
      description: "Names the conflicting rule; plain rejection, no resolution UI (deferred).",
    }),
  })
);

export const TimeAnnouncementRule = component(
  "TimeAnnouncementRule",
  z.strictObject({
    id: z.string(),
    time: z
      .string()
      .regex(new RegExp("^([01][0-9]|2[0-3]):[0-5][0-9]$"))
      .meta({ description: "Strict 24h HH:MM, stored exactly as written (never normalized)." }),
    weekDays: z
      .array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]))
      .min(1)
      .meta({
        uniqueItems: true,
        description: "Non-empty canonical set, no duplicates, canonical order on read.",
      }),
    isActive: z.boolean(),
    createdAt: z.int().meta({ description: "epoch ms" }),
    updatedAt: z.int().meta({ description: "epoch ms" }),
  })
);

export const TimeAnnouncementRuleCreate = component(
  "TimeAnnouncementRuleCreate",
  z.strictObject({
    time: z.string().regex(new RegExp("^([01][0-9]|2[0-3]):[0-5][0-9]$")),
    weekDays: z
      .array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]))
      .min(1)
      .meta({ uniqueItems: true }),
    isActive: z.boolean().meta({ default: true }).optional(),
  })
);

export const TimeAnnouncementRulePatch = component(
  "TimeAnnouncementRulePatch",
  z.strictObject({
    time: z.string().regex(new RegExp("^([01][0-9]|2[0-3]):[0-5][0-9]$")).optional(),
    weekDays: z
      .array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]))
      .min(1)
      .meta({ uniqueItems: true })
      .optional(),
    isActive: z.boolean().optional(),
  }),
  { minProperties: 1 }
);

export const timeAnnouncementsSchemas = defineRouteSchemas({
  /** GET /api/time-announcements */
  getTimeAnnouncements: {
    operationId: "getTimeAnnouncements",
    tags: ["time-announcements"],
    summary: "List all rules (inactive included), ordered by time — kiosk-visible",
    security: [{ deviceKeyCookie: [] }],
    response: {
      200: {
        description: "All rules ordered by time (ties by id).",
        content: { "application/json": { schema: z.array(TimeAnnouncementRule) } },
      },
      429: authenticationBackoffResponse,
      503: {
        description: "The owning plugin is inactive or unavailable.",
        content: { "application/json": { schema: PluginUnavailable } },
      },
    },
  },
  /** POST /api/time-announcements */
  postTimeAnnouncements: {
    operationId: "postTimeAnnouncements",
    tags: ["time-announcements"],
    summary: "Create a rule (admin write capability)",
    security: [{ deviceKeyCookie: [] }],
    body: TimeAnnouncementRuleCreate,
    response: {
      201: {
        description: "Created.",
        content: { "application/json": { schema: TimeAnnouncementRule } },
      },
      400: {
        description:
          "Malformed time / empty or non-canonical weekdays / unknown keys — no row created.",
        content: { "application/json": { schema: ValidationError } },
      },
      403: {
        description:
          "Revoked/expired credential or denied capability; code distinguishes credential loss from scope denial.",
        content: { "application/json": { schema: AuthForbidden } },
      },
      409: {
        description: "Active rule overlaps another active rule (same time + shared weekday).",
        content: { "application/json": { schema: OverlapError } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** PATCH /api/time-announcements/{id} */
  patchTimeAnnouncementsById: {
    operationId: "patchTimeAnnouncementsById",
    tags: ["time-announcements"],
    summary:
      "Partial edit / toggle active (admin write capability; overlap re-checked when result is active)",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    body: TimeAnnouncementRulePatch,
    response: {
      200: {
        description: "Updated (LWW by id against latest persisted rows).",
        content: { "application/json": { schema: TimeAnnouncementRule } },
      },
      400: {
        description: "Malformed fields / unknown keys / empty patch.",
        content: { "application/json": { schema: ValidationError } },
      },
      403: {
        description:
          "Revoked/expired credential or denied capability; code distinguishes credential loss from scope denial.",
        content: { "application/json": { schema: AuthForbidden } },
      },
      404: {
        description: "Unknown rule id.",
        content: { "application/json": { schema: NotFoundError } },
      },
      409: {
        description: "Patch would leave an active rule overlapping another active rule.",
        content: { "application/json": { schema: OverlapError } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** DELETE /api/time-announcements/{id} */
  deleteTimeAnnouncementsById: {
    operationId: "deleteTimeAnnouncementsById",
    tags: ["time-announcements"],
    summary: "Permanent delete, no archive tier (admin write capability)",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    response: {
      204: noContent("Deleted permanently."),
      403: {
        description:
          "Revoked/expired credential or denied capability; code distinguishes credential loss from scope denial.",
        content: { "application/json": { schema: AuthForbidden } },
      },
      404: {
        description: "Unknown rule id.",
        content: { "application/json": { schema: NotFoundError } },
      },
      429: authenticationBackoffResponse,
    },
  },
});
