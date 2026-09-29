import { describe, it, expect } from "vitest";
import { getDb } from "../../src/server/db/client";
import { reconcileBootstrap } from "../../src/server/auth/reconcile";
import { useIsolatedDb } from "../helpers/db";

/** Regression test — proves the full env-only provisioning flow works
 * end-to-end when `reconcileBootstrap` seeds the row at "boot" instead of
 * manually INSERT-ing a bootstrap row in the test.
 * This is the exact scenario that was broken before startup reconciliation was wired into the
 * boot path: `MP_BOOTSTRAP_KEY` was set but no bootstrap row existed in the
 * database, so `provisionDevice` returned 401 "Bootstrap key not reconciled".
 */
describe("bootstrap-provision — env-only flow via reconciliation (regression #89)", () => {
  useIsolatedDb();

  it("reconcileBootstrap() + POST /api/auth/provision with MP_BOOTSTRAP_KEY only (no manual INSERT) → 200, device cookie set, body has no raw key", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const bootstrapKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    process.env.MP_BOOTSTRAP_KEY = bootstrapKey;

    // Call reconcileBootstrap— this is the seam under test.
    // It replaces the manual INSERT that all existing tests use.
    reconcileBootstrap();

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/provision",
        headers: {
          Authorization: `Bearer ${bootstrapKey}`,
        },
      });

      expect(res.statusCode).toBe(200);

      const setCookie = res.headers["set-cookie"];
      expect(Array.isArray(setCookie)).toBe(true);
      expect((setCookie as string[]).length).toBeGreaterThan(0);

      const deviceCookie = (setCookie as string[]).find((c) => c.startsWith("mp_device_key="));
      expect(deviceCookie).toBeDefined();
      expect(deviceCookie).toMatch(/mp_device_key=mpk-[a-z]+(-[a-z]+)*/);

      expect(deviceCookie).toMatch(/HttpOnly/);
      expect(deviceCookie).toMatch(/Secure/);
      expect(deviceCookie).toMatch(/SameSite=Lax/);

      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("provisioned", true);

      // SC-004: raw bootstrap key must NOT appear in response body.
      expect(res.body).not.toContain(bootstrapKey);

      // Verify exactly one bootstrap row exists in the DB (reconcileBootstrap seeded it).
      const db = getDb();
      const bootstrapRows = db
        .prepare(
          "SELECT id, key_hash, scope, kind FROM api_keys WHERE kind = 'bootstrap' AND revoked_at IS NULL"
        )
        .all() as { id: string; key_hash: string; scope: string; kind: string }[];
      expect(bootstrapRows.length).toBe(1);
    } finally {
      await app.close();
    }
  });
});
