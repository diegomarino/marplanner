import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/server/app.ts";
import { getDb } from "../../src/server/db/client.ts";
import { hashKey } from "../../src/server/auth/credentials.ts";
import { useIsolatedDb } from "../helpers/db";

/** Provisioning + no-raw-key-leak boundary test.
 * Realizes: FR-007
 * Black-box: only asserts on HTTP status, Set-Cookie headers, and response body.
 * Does NOT import any server auth internals.
 */
describe("provision — FR-007 (T017)", () => {
  useIsolatedDb();

  /** Seed a bootstrap key row into api_keys (mimicking startup reconciliation).
   * An active bootstrap row before minting a device key.
   */
  function seedBootstrapKey(bootstrapKey: string): void {
    const now = Date.now();
    const db = getDb();
    const bootstrapHash = hashKey(bootstrapKey);
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'bootstrap', ?)"
    ).run(`${now}-bootstrap`, bootstrapHash, now);
  }

  it("POST /api/auth/provision with valid raw * bootstrap key → 200, Set-Cookie sets mp_device_key, body has no raw key", async () => {
    // The bootstrap key is provided out-of-band via env var MP_BOOTSTRAP_KEY.
    const bootstrapKey = "mpg-test-bootstrap-key-for-provisioning";
    process.env.MP_BOOTSTRAP_KEY = bootstrapKey;

    // Seed the bootstrap row (mimicking startup reconciliation).
    seedBootstrapKey(bootstrapKey);

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/provision",
        headers: {
          Authorization: `Bearer ${bootstrapKey}`,
        },
      });

      // FR-007: On successful provision the response MUST be 200
      expect(res.statusCode).toBe(200);

      // FR-007: The response MUST set an HttpOnly+Secure+SameSite=Lax cookie named
      // `mp_device_key` containing a device key that starts with "mpk-".
      const setCookie = res.headers["set-cookie"];
      expect(Array.isArray(setCookie)).toBe(true);
      expect(setCookie!.length).toBeGreaterThan(0);

      // At least one Set-Cookie must contain "mp_device_key="
      const deviceCookie = (setCookie as string[]).find((c) => c.startsWith("mp_device_key="));
      expect(deviceCookie).toBeDefined();
      expect(deviceCookie).toMatch(/mp_device_key=mpk-[a-z]+/);

      // The cookie flags must include HttpOnly, Secure, and SameSite=Lax
      expect(deviceCookie).toMatch(/HttpOnly/);
      expect(deviceCookie).toMatch(/Secure/);
      expect(deviceCookie).toMatch(/SameSite=Lax/);

      // FR-007: The response body MUST NOT contain the raw bootstrap key value.
      // The body should be { provisioned: true } (per openapi.yaml ProvisionResult).
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("provisioned", true);

      // SC-004: The raw key value must NOT appear anywhere in the response body.
      expect(res.body).not.toContain(bootstrapKey);
    } finally {
      await app.close();
    }
  });

  it("POST /api/auth/provision with invalid raw key → 401, body is { error, message }, no raw key leaked", async () => {
    const validBootstrapKey = "mpg-valid-bootstrap-key-value";
    const invalidKey = "mpg-wrong-garbage-key-does-not-match";
    process.env.MP_BOOTSTRAP_KEY = validBootstrapKey;

    // Seed the bootstrap row (mimicking startup reconciliation).
    seedBootstrapKey(validBootstrapKey);

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/provision",
        headers: {
          Authorization: `Bearer ${invalidKey}`,
        },
      });

      // Invalid key → 401 (key does not match the bootstrap row).
      expect(res.statusCode).toBe(401);

      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("error");
      expect(body).toHaveProperty("message");

      // SC-004: The raw key value must NOT appear in the error response body.
      expect(res.body).not.toContain(validBootstrapKey);
      expect(res.body).not.toContain(invalidKey);

      // SC-004: No Set-Cookie should be present on failure (no device key minted).
      expect(res.headers["set-cookie"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("POST /api/auth/provision without Authorization header → 401, no cookie set, no raw key in body", async () => {
    const validBootstrapKey = "mpg-another-valid-bootstrap-key";
    process.env.MP_BOOTSTRAP_KEY = validBootstrapKey;

    // Seed the bootstrap row (mimicking startup reconciliation).
    seedBootstrapKey(validBootstrapKey);

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/provision",
      });

      // Missing Authorization header → 401 (fail-closed, FR-003).
      expect(res.statusCode).toBe(401);

      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("error");
      expect(body).toHaveProperty("message");

      // SC-004: The raw bootstrap key must NOT appear in the response body.
      expect(res.body).not.toContain(validBootstrapKey);

      // No cookie is set on failure.
      expect(res.headers["set-cookie"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("POST /api/auth/provision with valid key but NO active bootstrap row in DB → 401", async () => {
    const bootstrapKey = "mpg-seeded-but-no-db-row";
    process.env.MP_BOOTSTRAP_KEY = bootstrapKey;

    // Do NOT seed a bootstrap row — startup reconciliation did not run.
    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/provision",
        headers: {
          Authorization: `Bearer ${bootstrapKey}`,
        },
      });

      // No active bootstrap row → 401 (provisioning rejected).
      expect(res.statusCode).toBe(401);

      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("error");
      expect(body).toHaveProperty("message");

      // No Set-Cookie on failure.
      expect(res.headers["set-cookie"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
