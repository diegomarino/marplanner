// Code-first OpenAPI: route schemas for the device-credential admin surface.
// These zod schemas are the single source of truth for docs/api/openapi.json
// (npm run generate:openapi). They document the HTTP contract; validation stays in
// src/server/auth/devices.ts so error envelopes remain byte-compatible.
import { z } from "zod";
import { component, defineRouteSchemas, type RouteResponse } from "./zod";
import {
  authForbiddenResponse,
  authUnauthorizedResponse,
  authenticationBackoffResponse,
} from "./common";

export const DeviceCredential = component(
  "DeviceCredential",
  z.strictObject({
    id: z.string(),
    kind: z.enum(["device", "integration", "bootstrap"]),
    label: z.string().nullable(),
    createdAt: z.number().int().meta({ description: "epoch ms" }),
    expiresAt: z.number().int().nullable().meta({ description: "epoch ms; null = no expiry" }),
    state: z.enum(["active", "revoked", "expired"]),
    current: z.boolean().meta({ description: "the credential this request authenticated with" }),
    configuredBootstrap: z.boolean().meta({
      description:
        "the bootstrap row MP_BOOTSTRAP_KEY names; startup re-activates it, so revoking it is refused",
    }),
  }),
  { description: "An API credential without its key or key hash." }
);

export const DeviceCredentialList = component(
  "DeviceCredentialList",
  z.strictObject({ credentials: z.array(DeviceCredential) })
);

export const DeviceCredentialRevokeResult = component(
  "DeviceCredentialRevokeResult",
  z.strictObject({
    credential: DeviceCredential,
    revoked: z.boolean().meta({ description: "false when it was already revoked" }),
  })
);

export const DeviceCredentialLabelRequest = component(
  "DeviceCredentialLabelRequest",
  z.strictObject({ label: z.string().min(1).max(80) }),
  { description: "Trimmed before storing; 1 to 80 characters after trimming." }
);

export const DeviceCredentialError = component(
  "DeviceCredentialError",
  z.strictObject({
    code: z.enum(["credential_not_found", "invalid_label", "configured_bootstrap"]),
    message: z.string(),
  })
);

const errorResponse = (description: string) =>
  ({
    description,
    content: { "application/json": { schema: DeviceCredentialError } },
  }) satisfies RouteResponse;

const params = z.object({ id: z.string() });
const security = [{ deviceKeyCookie: [] }];

export const deviceCredentialsSchemas = defineRouteSchemas({
  /** GET /api/auth/credentials */
  listDeviceCredentials: {
    operationId: "listDeviceCredentials",
    tags: ["bootstrap"],
    summary: "List every API credential (never its key or hash), oldest first",
    description:
      "Requires a provisioned `*` device cookie (`requireFullAccess`). The Admin PIN is a UI-only gate and is never evaluated here.\n",
    security,
    response: {
      200: {
        description: "Every credential with its derived state",
        content: { "application/json": { schema: DeviceCredentialList } },
      },
      401: authUnauthorizedResponse,
      403: authForbiddenResponse,
      429: authenticationBackoffResponse,
    },
  },
  /** PATCH /api/auth/credentials/{id} */
  labelDeviceCredential: {
    operationId: "labelDeviceCredential",
    tags: ["bootstrap"],
    summary: "Name a credential so a device can be identified later",
    security,
    params,
    body: DeviceCredentialLabelRequest,
    response: {
      200: {
        description: "The relabelled credential",
        content: { "application/json": { schema: DeviceCredential } },
      },
      400: errorResponse("The body is not `{label}` or the label is empty or too long"),
      401: authUnauthorizedResponse,
      403: authForbiddenResponse,
      404: errorResponse("No credential with this id"),
      429: authenticationBackoffResponse,
    },
  },
  /** POST /api/auth/credentials/{id}/revoke */
  revokeDeviceCredential: {
    operationId: "revokeDeviceCredential",
    tags: ["bootstrap"],
    summary: "Idempotently retire a credential; its next request is refused",
    description:
      "Revoking the credential this request uses succeeds; the device is logged out on its next request. The bootstrap key configured in MP_BOOTSTRAP_KEY is refused with 409: change the variable and restart, then revoke the old row.\n",
    security,
    params,
    response: {
      200: {
        description: "The credential after revocation",
        content: { "application/json": { schema: DeviceCredentialRevokeResult } },
      },
      401: authUnauthorizedResponse,
      403: authForbiddenResponse,
      404: errorResponse("No credential with this id"),
      409: errorResponse("The credential is the configured MP_BOOTSTRAP_KEY"),
      429: authenticationBackoffResponse,
    },
  },
});
