// Code-first OpenAPI: component schemas and responses shared by several HTTP domains.
// These zod schemas are the single source of truth for docs/api/openapi.json
// (npm run generate:openapi). They document the HTTP contract; validation stays in
// src/server/modules/* so error envelopes remain byte-compatible.
import { z } from "zod";
import { component, type RouteResponse } from "./zod";

export const AuthForbidden = component(
  "AuthForbidden",
  z.strictObject({
    error: z.literal("forbidden"),
    message: z.string(),
    code: z.enum(["credential_invalid", "scope_denied"]),
  })
);

export const AuthUnauthorized = component(
  "AuthUnauthorized",
  z.strictObject({
    error: z.literal("unauthorized"),
    message: z.string(),
    code: z.enum(["credential_invalid"]),
  })
);

export const ErrorSchema = component(
  "Error",
  z.looseObject({
    error: z
      .string()
      .meta({ description: "Stable machine-readable error code or English diagnostic." }),
    message: z.string().meta({ description: "English diagnostic (Constitution X)." }).optional(),
  }),
  {
    description:
      "Generic error envelope. Error bodies never contain `mpk-`/`mpg-` values or raw PINs (SC-004).",
  }
);

export const PluginUnavailable = component(
  "PluginUnavailable",
  z.strictObject({ code: z.literal("plugin_unavailable"), message: z.string() })
);

export const ValidationError = component(
  "ValidationError",
  z.strictObject({ error: z.enum(["validation_error"]), message: z.string() })
);

export const Weekday = component(
  "Weekday",
  z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]),
  { description: "canonical mon..sun (ADR-020); ISO 1..7 rejected." }
);

export const authenticationBackoffResponse = {
  description:
    "Repeated credential failures from this transport source. Valid active credentials remain usable; this is failure-only retry backpressure, not a hard guess or request-volume limit.\n",
  headers: {
    "Retry-After": z.int().min(1).meta({
      description: "Remaining cooldown in seconds, rounded up. Retry manually.",
      "x-mp-required": true,
    }),
    "Cache-Control": z.literal("no-store").meta({ "x-mp-required": true }),
  },
  content: {
    "application/json": {
      schema: z.strictObject({
        error: z.literal("too_many_requests"),
        message: z.literal("Authentication retry required"),
      }),
    },
  },
} satisfies RouteResponse;
