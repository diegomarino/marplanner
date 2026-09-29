import { describe, it, expect } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** Member-create validation test (FR-019 / FR-020 / FR-024 / FR-027).
 * Uses buildApp and Fastify.inject to check valid parent/child roles and
 * invalid admin, blank-name, and missing-name inputs against the API contract.
 * Scenario (per User Story 3, acceptance scenarios 1–3):
 * 1. useIsolatedDb sets DATA_DIR, resets DB, runs migrations.
 * 2. Seed a bootstrap key row + a device key into api_keys.
 * 3. Send POST /api/members with various payloads:
 * - displayName + role='parent' → 201, lifecycle='active'
 * - displayName + role='child' → 201, lifecycle='active'
 * - displayName + role='admin' → 400
 * - blank displayName + role='parent' → 400
 * - absent displayName + role='child' → 400
 * 4. Assert the outcomes match the contract (openapi.yaml /api/members POST).
 */
describe("member-create (T030 — red-by-design, T033+T034 turn green)", () => {
  useIsolatedDb();

  it("role=parent accepted with lifecycle=active (FR-019)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const bootstrapKey = `mpg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const bootstrapHash = hashKey(bootstrapKey);
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deviceHash = hashKey(deviceKey);
    const now = Date.now();
    const db = getDb();

    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'bootstrap', ?)"
    ).run(`${Date.now()}-bootstrap`, bootstrapHash, now);

    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${Date.now()}-device`, deviceHash, now);

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/members",
        cookies: { mp_device_key: deviceKey },
        payload: { displayName: "Abuelita", role: "parent" },
      });

      // POST /api/members returns 201 with the Member schema.
      expect(res.statusCode).toBe(201);

      const body = JSON.parse(res.body);

      // Member: { id, displayName, role, lifecycle, createdAt } (openapi.yaml).
      expect(body).toHaveProperty("id");
      expect(body).toHaveProperty("displayName");
      expect(body).toHaveProperty("role");
      expect(body).toHaveProperty("lifecycle");
      expect(body).toHaveProperty("createdAt");

      // FR-019: role='parent' is valid; lifecycle defaults to 'active'.
      expect(body.role).toBe("parent");
      expect(body.lifecycle).toBe("active");
      expect(body.displayName).toBe("Abuelita");
      expect(typeof body.createdAt).toBe("number");
    } finally {
      await app.close();
    }
  });

  it("role=child accepted with lifecycle=active (FR-019)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const bootstrapKey = `mpg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const bootstrapHash = hashKey(bootstrapKey);
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deviceHash = hashKey(deviceKey);
    const now = Date.now();
    const db = getDb();

    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'bootstrap', ?)"
    ).run(`${Date.now()}-bootstrap`, bootstrapHash, now);

    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${Date.now()}-device`, deviceHash, now);

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/members",
        cookies: { mp_device_key: deviceKey },
        payload: { displayName: "Peque", role: "child" },
      });

      // POST /api/members returns 201 with the Member schema.
      expect(res.statusCode).toBe(201);

      const body = JSON.parse(res.body);

      expect(body).toHaveProperty("id");
      expect(body).toHaveProperty("displayName");
      expect(body).toHaveProperty("role");
      expect(body).toHaveProperty("lifecycle");
      expect(body).toHaveProperty("createdAt");

      // FR-019: role='child' is valid; lifecycle defaults to 'active'.
      expect(body.role).toBe("child");
      expect(body.lifecycle).toBe("active");
      expect(body.displayName).toBe("Peque");
      expect(typeof body.createdAt).toBe("number");
    } finally {
      await app.close();
    }
  });

  it("role=admin rejected with 400 (FR-020/FR-024)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const bootstrapKey = `mpg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const bootstrapHash = hashKey(bootstrapKey);
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deviceHash = hashKey(deviceKey);
    const now = Date.now();
    const db = getDb();

    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'bootstrap', ?)"
    ).run(`${Date.now()}-bootstrap`, bootstrapHash, now);

    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${Date.now()}-device`, deviceHash, now);

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/members",
        cookies: { mp_device_key: deviceKey },
        payload: { displayName: "AdminUser", role: "admin" },
      });

      // FR-020/FR-024: role='admin' MUST be rejected with 400.
      expect(res.statusCode).toBe(400);

      const body = JSON.parse(res.body);

      // Error: { error, message } (openapi.yaml).
      expect(body).toHaveProperty("error");
    } finally {
      await app.close();
    }
  });

  it("blank display name rejected with 400 (FR-027)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const bootstrapKey = `mpg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const bootstrapHash = hashKey(bootstrapKey);
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deviceHash = hashKey(deviceKey);
    const now = Date.now();
    const db = getDb();

    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'bootstrap', ?)"
    ).run(`${Date.now()}-bootstrap`, bootstrapHash, now);

    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${Date.now()}-device`, deviceHash, now);

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/members",
        cookies: { mp_device_key: deviceKey },
        payload: { displayName: "", role: "parent" },
      });

      // FR-027: blank display name MUST be rejected with 400.
      expect(res.statusCode).toBe(400);

      const body = JSON.parse(res.body);

      // Error: { error, message } (openapi.yaml).
      expect(body).toHaveProperty("error");
    } finally {
      await app.close();
    }
  });

  it("absent display name rejected with 400 (FR-027)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const bootstrapKey = `mpg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const bootstrapHash = hashKey(bootstrapKey);
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deviceHash = hashKey(deviceKey);
    const now = Date.now();
    const db = getDb();

    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'bootstrap', ?)"
    ).run(`${Date.now()}-bootstrap`, bootstrapHash, now);

    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${Date.now()}-device`, deviceHash, now);

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/members",
        cookies: { mp_device_key: deviceKey },
        payload: { role: "child" },
      });

      // FR-027: absent display name MUST be rejected with 400.
      expect(res.statusCode).toBe(400);

      const body = JSON.parse(res.body);

      // Error: { error, message } (openapi.yaml).
      expect(body).toHaveProperty("error");
    } finally {
      await app.close();
    }
  });

  it("valid device key alone authorizes the write (no PIN required) (FR-027)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const bootstrapKey = `mpg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const bootstrapHash = hashKey(bootstrapKey);
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deviceHash = hashKey(deviceKey);
    const now = Date.now();
    const db = getDb();

    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'bootstrap', ?)"
    ).run(`${Date.now()}-bootstrap`, bootstrapHash, now);

    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${Date.now()}-device`, deviceHash, now);

    const app = await buildApp();

    try {
      // No PIN is sent or verified — authorization is by device key alone.
      // FR-014/FR-008: the backend never evaluates PIN for any endpoint.
      const res = await app.inject({
        method: "POST",
        url: "/api/members",
        cookies: { mp_device_key: deviceKey },
        payload: { displayName: "Nono", role: "child" },
      });

      // POST /api/members returns 201 — a device key alone authorizes.
      expect(res.statusCode).toBe(201);

      const body = JSON.parse(res.body);

      expect(body).toHaveProperty("id");
      expect(body).toHaveProperty("displayName");
      expect(body).toHaveProperty("role");
      expect(body).toHaveProperty("lifecycle");

      // The write succeeded with only a device key — no PIN involvement.
      expect(body.role).toBe("child");
      expect(body.lifecycle).toBe("active");
    } finally {
      await app.close();
    }
  });
});
