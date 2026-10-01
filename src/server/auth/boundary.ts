import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getDb } from "../db/client";
import { apiKeys } from "../db/schema";
import { hashKey } from "./credentials";
import { DEVICE_COOKIE } from "./cookies";
import { AUTH_CREDENTIAL_INVALID_CODE } from "../../shared";

import { authenticationBackoff, sendAuthenticationBackoff } from "./throttle";

const PROVISION_PATH = "/api/auth/provision";

function readDeviceCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1 || trimmed.slice(0, eqIdx) !== DEVICE_COOKIE) continue;
    const rawValue = trimmed.slice(eqIdx + 1);
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }
  return undefined;
}

function readBearerKey(authorization: string | undefined): string | undefined {
  if (!authorization?.startsWith("Bearer ")) return undefined;
  const rawKey = authorization.slice("Bearer ".length);
  return rawKey.length > 0 ? rawKey : undefined;
}

/** Single app-wide Fastify preHandler that enforces auth by API key only.
 * FR-001 – API key is the sole backend authorization boundary.
 * FR-002 – Fail-closed: `/health` and `/auth/provision` are the only
 * unauthenticated routes (provision uses Authorization header,
 * not the cookie).
 * FR-003 – No credential → 401/403, deployment stays locked.
 * FR-004 – Per-request active-record lookup (no cache): key must exist,
 * revoked_at IS NULL, and (expires_at IS NULL OR expires_at > now).
 * FR-005 – Credential authority lives in the database; no sessions or cached authority.
 */
export async function authBoundary(app: FastifyInstance): Promise<void> {
  const backoff = authenticationBackoff(app);
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    // FR-002: /health (GET) and /auth/provision (POST) are the only
    // unauthenticated routes — skip auth for these.
    // Strip query string, compare EXACT path (no startsWith — that would match
    // /healthx, /health-admin, /health/anything, which is fail-OPEN).
    const rawPath = (request.url ?? "").split("?")[0];
    let pathname;
    try {
      pathname = decodeURIComponent(rawPath);
    } catch {
      pathname = rawPath;
    }
    // ADR-059 §1/§2: the API-key boundary covers exactly /api/*. Frontend routes, the SPA
    // catch-all, and root /health are NOT subject to it.
    if (!pathname.startsWith("/api/")) {
      return;
    }
    // Within /api/* provision authenticates the submitted raw key with no prior cookie.
    if (pathname === PROVISION_PATH && request.method === "POST") {
      return;
    }

    // The established cookie transport remains valid throughout `/api/*`. The browser management route additionally
    // admits a raw Authorization bearer only on the plugin-management subtree. Exactly one
    // source may be present there: choosing between identities would make authorization depend
    // on transport precedence.
    const isPluginManagementPath =
      pathname === "/api/plugins" || pathname.startsWith("/api/plugins/");
    const cookieKey = readDeviceCookie(request.headers.cookie);
    const bearerKey = isPluginManagementPath
      ? readBearerKey(request.headers.authorization)
      : undefined;
    if (cookieKey && bearerKey) {
      return reply.code(401).send({
        error: "unauthorized",
        message: "Present exactly one API credential",
        code: AUTH_CREDENTIAL_INVALID_CODE,
      });
    }
    const rawKey = cookieKey ?? bearerKey;

    const rejectCredential = (status: number, message: string) => {
      // Unknown routes still fail closed, but are not credential guesses against an installed operation.
      const seconds = request.routeOptions.url?.startsWith("/api/")
        ? backoff.failure("api", request.ip)
        : 0;
      if (seconds) return sendAuthenticationBackoff(reply, seconds);
      return reply.code(status).send({
        error: status === 401 ? "unauthorized" : "forbidden",
        message,
        code: AUTH_CREDENTIAL_INVALID_CODE,
      });
    };

    // FR-003: Missing key → reject immediately.
    if (!rawKey) {
      return rejectCredential(401, "API key is required");
    }

    // FR-004: Per-request active-record lookup — hash the key, then query the
    // database for a matching row that is active (not revoked, not expired).
    const keyHash = hashKey(rawKey);
    const db = getDb();
    const orm = drizzle(db);

    const rows = await orm.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).limit(1);

    // No matching record → unknown/invalid key.
    if (rows.length === 0) {
      return rejectCredential(401, "Invalid API key");
    }

    const keyRecord = rows[0];

    // Check revoked: revoked_at must be NULL.
    if (keyRecord.revokedAt !== null) {
      return rejectCredential(403, "API key has been revoked");
    }

    // Check expired: expires_at must be NULL or in the future.
    const now = Date.now();
    if (keyRecord.expiresAt !== null && keyRecord.expiresAt <= now) {
      return rejectCredential(403, "API key has expired");
    }

    // FR-005: At this point the key is valid — attach it to the request so
    // downstream handlers can reference it. Do NOT store the raw key in any
    // response body (FR-006 / SC-004).
    const authenticatedRequest = request as FastifyRequest & {
      apiKeyId: string;
      apiKeyTransport: "cookie" | "bearer";
    };
    authenticatedRequest.apiKeyId = keyRecord.id;
    authenticatedRequest.apiKeyTransport = bearerKey ? "bearer" : "cookie";
  });
}
