// Code-first OpenAPI: route schemas for the bootstrap HTTP surface.
// These zod schemas are the single source of truth for docs/api/openapi.json
// (npm run generate:openapi). They document the HTTP contract; validation stays in
// src/server/modules/* so error envelopes remain byte-compatible.
import { z } from "zod";
import { component, defineRouteSchemas } from "./zod";
import { ErrorSchema, authenticationBackoffResponse } from "./common";

export const Health = component("Health", z.looseObject({ status: z.literal("ok") }));

export const ProvisionResult = component(
  "ProvisionResult",
  z.looseObject({ provisioned: z.literal(true) }),
  {
    description:
      "Success body carries NO raw key — the minted device key is delivered only via Set-Cookie (FR-007). The raw key never appears here or in any error body (SC-004).\n",
  }
);

export const VerifyPinRequest = component("VerifyPinRequest", z.looseObject({ pin: z.string() }));

export const VerifyPinResult = component("VerifyPinResult", z.looseObject({ match: z.boolean() }), {
  description: "Advisory only — no session is created; grants no backend authority (FR-016/026).",
});

export const bootstrapSchemas = defineRouteSchemas({
  /** POST /api/auth/provision */
  provisionDevice: {
    operationId: "provisionDevice",
    tags: ["bootstrap"],
    summary: "First connect — present the raw `*` bootstrap key, mint a cookie-bound device key.",
    description:
      "Validates the presented raw `*` key against the configured bootstrap credential. On success mints a no-expiry `*` device key, persists only its hash, and returns it via Set-Cookie. Fail-closed: an absent/invalid key yields 401 and the deployment stays locked (FR-003/004/007).\n",
    security: [],
    headers: z.object({
      Authorization: z.string().meta({
        example: "Bearer mpk-cedar-lantern-otter-ridge-velvet-amber",
        description: "The raw `*` bootstrap key. Never logged; never returned.",
      }),
    }),
    response: {
      200: {
        description: "Provisioned. Device key delivered via Set-Cookie; body has no raw key.",
        headers: {
          "Set-Cookie": z
            .string()
            .meta({ example: "mp_device_key=mpk-…; HttpOnly; Secure; SameSite=Lax" }),
        },
        content: { "application/json": { schema: ProvisionResult } },
      },
      401: {
        description: "Missing/invalid bootstrap key — locked, never open.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** POST /api/auth/verify-pin */
  verifyPin: {
    operationId: "verifyPin",
    tags: ["bootstrap"],
    summary: "Advisory client-side-gate helper — compares the PIN, returns match/no-match.",
    description:
      "Authorized by the device key like every endpoint. Compares the submitted PIN to the stored hash and returns `{ match }`. Creates NO session row and grants NO authority; the PIN is never an authorization input (FR-014/015/016/026).\n",
    security: [{ deviceKeyCookie: [] }],
    body: VerifyPinRequest,
    response: {
      200: {
        description: "Correct PIN → match true; incorrect PIN → match false. No state written.",
        content: { "application/json": { schema: VerifyPinResult } },
      },
      401: {
        description: "No/invalid device key (independent of PIN).",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** GET /health */
  getHealth: {
    operationId: "getHealth",
    tags: ["bootstrap"],
    summary: "Liveness — the ONLY unauthenticated route (allowlisted).",
    security: [],
    response: {
      200: {
        description: "Always reachable, even with no credential configured (FR-002).",
        content: { "application/json": { schema: Health } },
      },
    },
  },
});
