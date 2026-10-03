import { describe, it, expect } from "vitest";
import argon2 from "argon2";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** No-server-session / PIN-agnostic-authz test (FR-014 / FR-015 / FR-017 / FR-018).
 * BLACK-BOX: Uses buildApp + Fastify.inject only.
 * Scenario (per User Story 2, acceptance scenarios 4–5):
 * 1. useIsolatedDb sets DATA_DIR, resets DB, runs migrations.
 * 2. Seed a bootstrap key row + a device key into api_keys.
 * 3. Seed the admin_config row (PIN hashed with argon2id per).
 * 4. Assert: no session/sessions table exists in the SQLite schema.
 * 5. Assert: no session-identifier header is issued by any endpoint.
 * 6. Assert: GET /api/settings with a valid device key succeeds regardless of PIN state.
 * 7. Assert: verify-pin returns { match } and creates no session record.
 * Verifies that the settings and PIN-verification routes require the
 * appropriate key and never create server-side session state.
 */
describe("no-server-session / PIN-agnostic-authz (FR-014/015/017/018)", () => {
  useIsolatedDb();

  it("schema contains NO session/sessions table (FR-015)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    // Seed a device key so the app has auth state to work with.
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deviceHash = hashKey(deviceKey);
    const now = Date.now();
    const db = getDb();
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${Date.now()}-device`, deviceHash, now);

    const app = await buildApp();

    try {
      // Query the SQLite schema: list all tables.
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];

      const tableNames = new Set(tables.map((t) => t.name));

      // FR-015: There MUST be no server-side session table, no session-identifier header,
      // and no server session lifecycle.
      // Assert: neither the ession' nor the essions' exists in the schema.
      expect(tableNames.has("session")).toBe(false);
      expect(tableNames.has("sessions")).toBe(false);

      // Also assert: no table name contains the ession' (defense in depth).
      for (const name of tableNames) {
        expect(name.toLowerCase()).not.toContain("session");
      }
    } finally {
      await app.close();
    }
  });

  it("no session-identifier header is issued by any endpoint (FR-015)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    // Seed a device key.
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deviceHash = hashKey(deviceKey);
    const now = Date.now();
    const db = getDb();
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${Date.now()}-device`, deviceHash, now);

    const app = await buildApp();

    try {
      // Request /health (unauthenticated) — assert no session header.
      const healthRes = await app.inject({
        method: "GET",
        url: "/health",
      });
      expect(healthRes.statusCode).toBe(200);

      // FR-015: no session-identifier header exists in the response.
      const headers = healthRes.headers;
      const sessionHeaders = Object.keys(headers).filter((k) =>
        k.toLowerCase().includes("session")
      );
      expect(sessionHeaders).toHaveLength(0);

      // Request a protected endpoint (which returns 401 for no key) — still no session header.
      const noKeyRes = await app.inject({
        method: "GET",
        url: "/api/settings",
      });
      expect(noKeyRes.statusCode).toBe(401);

      const noKeyHeaders = noKeyRes.headers;
      const noKeySessionHeaders = Object.keys(noKeyHeaders).filter((k) =>
        k.toLowerCase().includes("session")
      );
      expect(noKeySessionHeaders).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("verify-pin creates no session row (FR-014/FR-015/FR-016)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    // Seed a device key + admin_config row.
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deviceHash = hashKey(deviceKey);
    const now = Date.now();
    const db = getDb();
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${Date.now()}-device`, deviceHash, now);

    // Seed the admin_config with an argon2id hash ( pin_hash is
    // 'argon2id/scrypt hash; raw PIN never stored or returned (INV-10)').
    // CRITICAL: Do NOT use hashKey (SHA-256) for the PIN — the contract
    // requires argon2id. See line 79.
    const correctPin = process.env.ADMIN_PIN ?? "0000";
    const pinHash = await argon2.hash(correctPin);
    db.prepare("INSERT INTO admin_config (id, pin_hash, updated_at) VALUES (1, ?, ?)").run(
      pinHash,
      now
    );

    const app = await buildApp();

    try {
      // POST /api/auth/verify-pin with the correct PIN and a valid device key.
      // FR-014: The PIN MUST NOT be evaluated by the backend for any endpoint
      // and MUST remain client-side UI state only.
      // FR-016: verify-pin with the correct PIN returns a match and MUST NOT
      // create a session row anywhere.
      const verifyRes = await app.inject({
        method: "POST",
        url: "/api/auth/verify-pin",
        cookies: { mp_device_key: deviceKey },
        payload: { pin: correctPin },
      });

      // verify-pin is installed; match-only, no session side effects.
      expect(verifyRes.statusCode).toBe(200);

      const body = JSON.parse(verifyRes.body);

      // FR-016: verify-pin with the correct PIN returns { match: true }.
      expect(body).toHaveProperty("match");
      expect(body.match).toBe(true);

      // FR-015: after verify-pin, assert no session/sessions table was created.
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];

      const tableNames = new Set(tables.map((t) => t.name));
      expect(tableNames.has("session")).toBe(false);
      expect(tableNames.has("sessions")).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("GET /api/settings authorized by key alone regardless of PIN state (FR-014/FR-017/FR-018)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    // Seed a device key + admin_config row (PIN verified but never sent to backend).
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deviceHash = hashKey(deviceKey);
    const now = Date.now();
    const db = getDb();
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${Date.now()}-device`, deviceHash, now);

    // Seed the admin_config with an argon2id hash ( pin_hash is
    // 'argon2id/scrypt hash; raw PIN never stored or returned (INV-10)').
    const adminPin = process.env.ADMIN_PIN ?? "0000";
    const pinHash = await argon2.hash(adminPin);
    db.prepare("INSERT INTO admin_config (id, pin_hash, updated_at) VALUES (1, ?, ?)").run(
      pinHash,
      now
    );

    const app = await buildApp();

    try {
      // FR-014: The PIN MUST NOT be evaluated by the backend for any endpoint
      // and MUST remain client-side UI state only.
      // FR-017: An admin route MUST be gated by the client-side admin unlock only,
      // and the backend MUST NOT gate on the PIN.
      // FR-018: Admin content MUST be reachable only after long-press plus PIN,
      // while the backend authorizes by API key regardless of PIN state.
      //
      // Use GET /api/settings (which EXISTS) to prove key-alone authorization:
      // a valid device key returns 200 whether or not any PIN was verified.
      const settingsRes = await app.inject({
        method: "GET",
        url: "/api/settings",
        cookies: { mp_device_key: deviceKey },
      });

      // GET /api/settings with a valid device key returns 200 regardless of PIN state.
      // This proves FR-014/017/018: the backend authorizes by key alone.
      expect(settingsRes.statusCode).toBe(200);

      // FR-015: verify-pin (even though not called here) creates no session row.
      // Assert no session-identifier header in the /api/settings response.
      const sessionHeaders = Object.keys(settingsRes.headers).filter((k) =>
        k.toLowerCase().includes("session")
      );
      expect(sessionHeaders).toHaveLength(0);

      // FR-015: assert no session/sessions table was created.
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];

      const tableNames = new Set(tables.map((t) => t.name));
      expect(tableNames.has("session")).toBe(false);
      expect(tableNames.has("sessions")).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("verifying an incorrect PIN creates no session row and reports no-match (FR-014/FR-015/FR-026)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    // Seed a device key + admin_config row.
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deviceHash = hashKey(deviceKey);
    const now = Date.now();
    const db = getDb();
    const adminPin = process.env.ADMIN_PIN ?? "0000";
    // argon2id hash for admin_config ( pin_hash uses argon2id).
    const pinHash = await argon2.hash(adminPin);
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${Date.now()}-device`, deviceHash, now);
    db.prepare("INSERT INTO admin_config (id, pin_hash, updated_at) VALUES (1, ?, ?)").run(
      pinHash,
      now
    );

    const app = await buildApp();

    try {
      // POST /api/auth/verify-pin with an INCORRECT PIN and a valid device key.
      // FR-026: verify-pin with an incorrect PIN MUST report no-match and MUST
      // NOT create a session row, so the client-side admin unlock is not granted.
      // FR-014: The PIN is never evaluated by the backend.
      const verifyRes = await app.inject({
        method: "POST",
        url: "/api/auth/verify-pin",
        cookies: { mp_device_key: deviceKey },
        payload: { pin: "wrong-pin" },
      });

      // verify-pin is installed; match-only, no session side effects.
      expect(verifyRes.statusCode).toBe(200);

      const body = JSON.parse(verifyRes.body);

      // FR-026: incorrect PIN → { match: false }.
      expect(body).toHaveProperty("match");
      expect(body.match).toBe(false);

      // FR-015: after verify-pin (even with wrong PIN), assert no session/sessions
      // table was created.
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];

      const tableNames = new Set(tables.map((t) => t.name));
      expect(tableNames.has("session")).toBe(false);
      expect(tableNames.has("sessions")).toBe(false);
    } finally {
      await app.close();
    }
  });
});
