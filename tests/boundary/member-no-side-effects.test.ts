import { describe, it, expect } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** Member-create no-side-effects test (FR-022 / FR-023).
 * Uses buildApp and Fastify.inject to confirm a successful create writes
 * one member row and no Daily Briefing rows or configuration.
 * Scenario (per User Story 3, acceptance scenario 4):
 * 1. useIsolatedDb sets DATA_DIR, resets DB, runs migrations.
 * 2. Seed a bootstrap key row + a device key into api_keys.
 * 3. POST /api/members with a valid device key and valid body (displayName + role).
 * 4. Assert exactly one members row exists.
 * 5. Assert protected table counts captured before creation remain unchanged.
 */
describe("member-no-side-effects (red-by-design, + turn green)", () => {
  useIsolatedDb();

  it("successful create writes exactly one member row and zero Daily Briefing rows/config (FR-022/023)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    // Seed a bootstrap key row into api_keys (mimicking startup reconciliation).
    const bootstrapKey = `mpg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const bootstrapHash = hashKey(bootstrapKey);
    const now = Date.now();
    const db = getDb();
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'bootstrap', ?)"
    ).run(`${Date.now()}-bootstrap`, bootstrapHash, now);

    // Seed a device key row (mimicking device provisioning).
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deviceHash = hashKey(deviceKey);
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${Date.now()}-device`, deviceHash, now);

    // Build the app before capturing counts to exclude startup reconciliation.
    const app = await buildApp();

    try {
      const protectedTables = [
        "api_keys",
        "settings_objects",
        "admin_config",
        "daily_briefing",
        "daily_briefing_block_cache",
        "daily_briefing_block_order",
        "daily_briefing_member_block_settings",
        "daily_briefing_optin",
        "daily_briefing_settings",
      ];
      const preCounts = Object.fromEntries(
        protectedTables.map((table) => [
          table,
          (db.prepare(`SELECT count(*) as cnt FROM ${table}`).get() as { cnt: number }).cnt,
        ])
      );

      // POST /api/members with a valid device key and valid member body.
      // FR-022/023: A successful member create MUST create only the member profile
      // and have no Daily Briefing side effects / no Daily Briefing configuration.
      //
      // A successful create returns 201 and writes exactly one member row.
      const res = await app.inject({
        method: "POST",
        url: "/api/members",
        cookies: { mp_device_key: deviceKey },
        payload: {
          displayName: "Ada",
          role: "parent",
        },
      });

      // POST /api/members returns 201 with Member (openapi.yaml).
      expect(res.statusCode).toBe(201);

      const body = JSON.parse(res.body);

      // Member schema: { id, displayName, role, lifecycle, createdAt } (openapi.yaml).
      expect(body).toHaveProperty("id");
      expect(body).toHaveProperty("displayName");
      expect(body).toHaveProperty("role");
      expect(body).toHaveProperty("lifecycle");
      expect(body).toHaveProperty("createdAt");

      // lifecycle MUST be 'active' (clarification).
      expect(body.lifecycle).toBe("active");

      // --- ASSERTION: exactly one members row exists ---
      const membersCount = db.prepare("SELECT count(*) as cnt FROM members").get() as {
        cnt: number;
      };
      expect(membersCount.cnt).toBe(1);

      // Member creation must leave the current protected tables unchanged.
      for (const table of protectedTables) {
        const postCount = db.prepare(`SELECT count(*) as cnt FROM ${table}`).get() as {
          cnt: number;
        };
        expect(postCount.cnt).toBe(preCounts[table]);
      }
    } finally {
      await app.close();
    }
  });
});
