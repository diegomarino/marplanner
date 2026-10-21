import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
  preHandlerAsyncHookHandler,
  RouteHandlerMethod,
} from "fastify";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getDb } from "../db/client";
import { apiKeys } from "../db/schema";
import { AUTH_CREDENTIAL_INVALID_CODE, AUTH_SCOPE_DENIED_CODE } from "../../shared";
import { documented, type RouteSchema } from "../openapi/zod";

/** Capability seam (ADR-030) — declared per-route, fail-closed.
 * `authBoundary` (src/server/auth/boundary.ts) already proved the API key is LIVE (not
 * revoked/expired) and attached `request.apiKeyId`. This preHandler adds a SECOND check: does
 * the key's `scope` satisfy the declared capability? `'*'` satisfies everything (all keys are
 * full-access today, FR-007/AC-05); a space-separated scoped list must include the exact
 * capability string. The client PIN is NEVER read here or anywhere in this module — the PIN
 * gates only the admin UI, never a server capability check (INV-10).
 * Every 403 this module sends carries `code: AUTH_SCOPE_DENIED_CODE` — the key is
 * live, this specific request is merely out of scope, and `authFetch`
 * (src/client/lib/credential.ts) must NOT treat that as credential loss and de-provision the
 * kiosk. The one exception is the two defensive "no/unknown apiKeyId" branches below (a race
 * or a request that reached this preHandler without `authBoundary` running first) — those DO
 * mean the credential itself is no longer valid, so they carry `AUTH_CREDENTIAL_INVALID_CODE`
 * instead, same as `boundary.ts`.
 */
export function requireCapability(capability: string): preHandlerAsyncHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKeyId = (request as FastifyRequest & { apiKeyId?: string }).apiKeyId;
    if (!apiKeyId) {
      return reply.code(403).send({
        error: "forbidden",
        message: "No authenticated API key",
        code: AUTH_CREDENTIAL_INVALID_CODE,
      });
    }

    const db = getDb();
    const orm = drizzle(db);
    const rows = await orm.select().from(apiKeys).where(eq(apiKeys.id, apiKeyId)).limit(1);
    const keyRecord = rows[0];
    if (!keyRecord) {
      return reply.code(403).send({
        error: "forbidden",
        message: "Unknown API key",
        code: AUTH_CREDENTIAL_INVALID_CODE,
      });
    }

    const scope = keyRecord.scope;
    const satisfied = scope === "*" || scope.split(/\s+/).filter(Boolean).includes(capability);
    if (!satisfied) {
      return reply.code(403).send({
        error: "forbidden",
        message: `Capability "${capability}" not granted`,
        code: AUTH_SCOPE_DENIED_CODE,
      });
    }
  };
}

/** Require the household's established full-access capability. The scope must be exactly `*`, and
 * the authenticated transport must match an allow-listed kind: a provisioned `device` cookie or
 * a raw-header `integration` bearer. Bootstrap credentials and crossed transport/kind pairs are
 * denied here. The Admin PIN is presentation-only and is neither accepted nor evaluated here.
 */
export function requireFullAccess(): preHandlerAsyncHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const authenticatedRequest = request as FastifyRequest & {
      apiKeyId?: string;
      apiKeyTransport?: "cookie" | "bearer";
    };
    if (!authenticatedRequest.apiKeyId) {
      return reply.code(403).send({
        error: "forbidden",
        message: "No authenticated API key",
        code: AUTH_CREDENTIAL_INVALID_CODE,
      });
    }

    const db = getDb();
    const orm = drizzle(db);
    const rows = await orm
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, authenticatedRequest.apiKeyId))
      .limit(1);
    const keyRecord = rows[0];
    if (!keyRecord) {
      return reply.code(403).send({
        error: "forbidden",
        message: "Unknown API key",
        code: AUTH_CREDENTIAL_INVALID_CODE,
      });
    }

    const allowedKindAndTransport =
      (keyRecord.kind === "device" && authenticatedRequest.apiKeyTransport === "cookie") ||
      (keyRecord.kind === "integration" && authenticatedRequest.apiKeyTransport === "bearer");
    if (keyRecord.scope !== "*" || !allowedKindAndTransport) {
      return reply.code(403).send({
        error: "forbidden",
        message: 'Full-access capability "*" not granted',
        code: AUTH_SCOPE_DENIED_CODE,
      });
    }
  };
}

type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export interface CapabilityRoute {
  method: HttpMethod;
  path: string;
  /** REQUIRED — omitting this (or passing an empty string) throws at registration (fail-closed). */
  capability: string | undefined;
  /** Code-first OpenAPI route schema (documentation only; see src/server/openapi). */
  schema?: RouteSchema;
  handler: RouteHandlerMethod;
}

/** Register a batch of routes, each REQUIRED to declare a capability. Any route with a
 * missing/empty capability THROWS at registration time (loudest possible failure.
 * rather than silently serving an unprotected endpoint.
 */
export function registerRoutesWithCapabilities(
  app: FastifyInstance,
  routes: CapabilityRoute[]
): void {
  for (const route of routes) {
    if (!route.capability) {
      throw new Error(
        `Capability seam violation: ${route.method.toUpperCase()} ${route.path} was registered ` +
          "without a declared capability. Every telemetry route MUST declare one (fail-closed)."
      );
    }
    app[route.method](
      route.path,
      {
        preHandler: requireCapability(route.capability),
        ...(route.schema && documented(route.schema)),
      },
      route.handler
    );
  }
}
