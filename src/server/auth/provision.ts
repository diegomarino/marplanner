import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getDb } from "../db/client";
import { apiKeys } from "../db/schema";
import { generateKey, hashKey, verifyKey } from "./credentials";
import { DEVICE_COOKIE, serializeAuthCookie } from "./cookies";
import { resolveAdminPin } from "./default-credentials";
import argon2 from "argon2";

import { authenticationBackoff, sendAuthenticationBackoff } from "./throttle";
import { bootstrapSchemas } from "../openapi/bootstrap";
import { documented } from "../openapi/zod";

const BOOTSTRAP_ENV = "MP_BOOTSTRAP_KEY";

/** Provisioning logic — validate bootstrap key, mint cookie-bound device key.
 * FR-007: On a first connect with a raw `*` key, a `*` device key with no
 * expiry MUST be minted and cookie-bound, and the response body MUST NOT
 * contain the raw key.
 */
export async function provisionDevice(app: FastifyInstance, basePath = ""): Promise<void> {
  const backoff = authenticationBackoff(app);
  app.post(
    "/api/auth/provision",
    documented(bootstrapSchemas.provisionDevice),
    async (request: FastifyRequest, reply: FastifyReply) => {
      const rejectCredential = (message: string) => {
        const seconds = backoff.failure("bootstrap", request.ip);
        if (seconds) return sendAuthenticationBackoff(reply, seconds);
        return reply.code(401).send({ error: "unauthorized", message });
      };
      // Missing deployment configuration is not a credential failure, even without a header.
      const configuredKey = process.env[BOOTSTRAP_ENV];
      if (!configuredKey) {
        return reply
          .code(401)
          .send({ error: "unauthorized", message: "Bootstrap key not configured" });
      }

      // The raw `*` bootstrap key is presented in the Authorization header.
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return rejectCredential("Bootstrap key is required");
      }

      const rawBootstrapKey = authHeader.slice("Bearer ".length);
      if (!rawBootstrapKey) {
        return rejectCredential("Bootstrap key is required");
      }

      // Validate the presented raw key against the configured bootstrap credential
      // using timing-safe comparison.
      if (!verifyKey(rawBootstrapKey, hashKey(configuredKey))) {
        return rejectCredential("Invalid bootstrap key");
      }

      // The bootstrap key is valid — verify an active bootstrap row exists in DB.
      // Startup reconciliation seeds this row at startup; if it's missing or not active, reject.
      const bootstrapHash = hashKey(configuredKey);
      const db = getDb();
      const orm = drizzle(db);

      const bootstrapRows = await orm
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.keyHash, bootstrapHash))
        .limit(1);

      if (bootstrapRows.length === 0) {
        // No bootstrap row in DB — startup reconciliation did not run or the row was deleted.
        return reply.code(401).send({
          error: "unauthorized",
          message: "Bootstrap key not reconciled",
        });
      }

      const bootstrapRecord = bootstrapRows[0];

      // Check active: revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now).
      if (bootstrapRecord.revokedAt !== null) {
        return rejectCredential("Bootstrap key has been revoked");
      }

      const now = Date.now();
      if (bootstrapRecord.expiresAt !== null && bootstrapRecord.expiresAt <= now) {
        return rejectCredential("Bootstrap key has expired");
      }

      // Active bootstrap row confirmed — mint a new device key.
      const deviceKey = generateKey();
      const deviceKeyHash = hashKey(deviceKey);
      const keyId = randomUUID();

      // Persist the device key record: `*`-scoped, kind `'device'`, no expiry.
      // Use raw SQL (avoid vite SSR namespace import issues with drizzle).
      const insertStmt = db.prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at, expires_at, revoked_at) VALUES (?, ?, '*', 'device', ?, NULL, NULL)"
      );
      insertStmt.run(keyId, deviceKeyHash, now);

      // Seed the advisory admin PIN from MP_ADMIN_PIN (or the documented default "0000").
      // Always seed admin_config so verify-pin always has a row to compare against.
      const adminPin = resolveAdminPin();
      const pinHash = await argon2.hash(adminPin);
      db.prepare(
        "INSERT INTO admin_config (id, pin_hash, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET pin_hash=excluded.pin_hash, updated_at=excluded.updated_at"
      ).run(pinHash, now);

      // Set the device key as an HttpOnly, Secure, SameSite=Lax cookie.
      // The raw key is NEVER echoed in the response body (FR-007 / SC-004).
      // Fastify without @fastify/cookie: set the header as an array so
      // inject normalizes it to an array (matching test expectations).
      const cookieValue = serializeAuthCookie(DEVICE_COOKIE, deviceKey, basePath);
      // Companion NON-HttpOnly marker cookie so the client can detect provisioned
      // state from its own credential's presence WITHOUT probing an authenticated
      // endpoint (FR-031 / ADR-059). Carries no secret — just a presence flag.
      const provisionedMarker = `mp_provisioned=1; Secure; SameSite=Lax; Path=${basePath}/`;
      reply.header("Set-Cookie", [cookieValue, provisionedMarker]);

      // Return the provisioned result — body does NOT contain the raw key.
      return { provisioned: true };
    }
  );
}
