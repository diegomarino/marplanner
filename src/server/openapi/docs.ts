// Code-first OpenAPI: the documentation surface itself.
import { z } from "zod";
import { AuthForbidden, ErrorSchema, authenticationBackoffResponse } from "./common";
import { defineRouteSchemas } from "./zod";

export const docsSchemas = defineRouteSchemas({
  /** GET /api/openapi.json */
  getOpenApiDocument: {
    operationId: "getOpenApiDocument",
    tags: ["docs"],
    summary: "The OpenAPI 3.1 document for this API.",
    description:
      "Generated at runtime from the same zod route schemas as the committed `docs/api/openapi.json`; `servers` reflects the deployment's BASE_PATH. The interactive reference UI is served at `/api/docs/`.",
    security: [{ deviceKeyCookie: [] }],
    response: {
      200: {
        description: "OpenAPI document.",
        content: {
          "application/json": {
            schema: z.looseObject({
              openapi: z.literal("3.1.0"),
              info: z.looseObject({ title: z.string(), version: z.string() }),
              paths: z.record(z.string(), z.looseObject({})),
            }),
          },
        },
      },
      401: {
        description: "No/invalid device key.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      403: {
        description: "Revoked/expired credential.",
        content: { "application/json": { schema: AuthForbidden } },
      },
      429: authenticationBackoffResponse,
    },
  },
});
