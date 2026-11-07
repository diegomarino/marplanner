import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/server/app";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** Admin HTTP surface over device credentials (issue #95): `/api/auth/credentials*`. */
describe("device credential admin routes", () => {
  useIsolatedDb();

  const CREATED = Date.parse("2026-10-21T12:00:00Z");
  const ADMIN_KEY = "mpk-admin-tablet-device-key";
  const KITCHEN_KEY = "mpk-kitchen-device-key";
  const BOOTSTRAP_KEY = "mpk-current-bootstrap-key";
  let app: FastifyInstance;
  let savedBootstrap: string | undefined;

  function insertKey(
    id: string,
    key: string,
    kind = "device",
    extra: { expiresAt?: number; revokedAt?: number; label?: string } = {}
  ) {
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, label, created_at, expires_at, revoked_at) VALUES (?, ?, '*', ?, ?, ?, ?, ?)"
      )
      .run(
        id,
        hashKey(key),
        kind,
        extra.label ?? null,
        CREATED,
        extra.expiresAt ?? null,
        extra.revokedAt ?? null
      );
  }

  function call(method: "GET" | "PATCH" | "POST", url: string, key?: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      ...(key ? { cookies: { mp_device_key: key } } : {}),
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  }

  beforeEach(async () => {
    savedBootstrap = process.env.MP_BOOTSTRAP_KEY;
    // Unset during buildApp so startup reconciliation inserts no row of its own.
    delete process.env.MP_BOOTSTRAP_KEY;
    insertKey("admin", ADMIN_KEY, "device", { label: "Admin tablet" });
    insertKey("kitchen", KITCHEN_KEY);
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    if (savedBootstrap === undefined) delete process.env.MP_BOOTSTRAP_KEY;
    else process.env.MP_BOOTSTRAP_KEY = savedBootstrap;
  });

  it("requires an authenticated full-access device credential", async () => {
    expect((await call("GET", "/api/auth/credentials")).statusCode).toBe(401);
    expect((await call("POST", "/api/auth/credentials/kitchen/revoke")).statusCode).toBe(401);
    expect(
      (await call("PATCH", "/api/auth/credentials/kitchen", undefined, { label: "x" })).statusCode
    ).toBe(401);

    // A bootstrap key used as a cookie authenticates at the boundary but is not full access.
    insertKey("boot", BOOTSTRAP_KEY, "bootstrap");
    const denied = await call("GET", "/api/auth/credentials", BOOTSTRAP_KEY);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "scope_denied" });
  });

  it("lists every credential with its state and never leaks key material", async () => {
    const NOW = Date.now();
    insertKey("old", "mpk-old-device-key", "device", { revokedAt: CREATED + 1 });
    insertKey("temp", "mpk-temporary-device-key", "device", { expiresAt: NOW - 1000 });
    insertKey("later", "mpk-later-device-key", "device", { expiresAt: NOW + 86_400_000 });

    const response = await call("GET", "/api/auth/credentials", ADMIN_KEY);
    expect(response.statusCode).toBe(200);
    const { credentials } = response.json() as { credentials: Array<Record<string, unknown>> };
    expect(credentials.map((c) => [c.id, c.state, c.current])).toEqual([
      ["admin", "active", true],
      ["kitchen", "active", false],
      ["later", "active", false],
      ["old", "revoked", false],
      ["temp", "expired", false],
    ]);
    expect(credentials[0]).toEqual({
      id: "admin",
      kind: "device",
      label: "Admin tablet",
      createdAt: CREATED,
      expiresAt: null,
      state: "active",
      current: true,
      configuredBootstrap: false,
    });
    for (const key of [ADMIN_KEY, KITCHEN_KEY, "mpk-old-device-key"]) {
      expect(response.body).not.toContain(key);
      expect(response.body).not.toContain(hashKey(key));
    }
    expect(response.body).not.toMatch(/mpk-|key_?hash/i);
  });

  it("revokes idempotently, and the revoked device is refused on its next request", async () => {
    const first = await call("POST", "/api/auth/credentials/kitchen/revoke", ADMIN_KEY);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      revoked: true,
      credential: { id: "kitchen", state: "revoked", current: false },
    });
    const revokedAt = getDb().prepare("SELECT revoked_at FROM api_keys WHERE id = 'kitchen'").get();

    const again = await call("POST", "/api/auth/credentials/kitchen/revoke", ADMIN_KEY);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ revoked: false, credential: { state: "revoked" } });
    expect(getDb().prepare("SELECT revoked_at FROM api_keys WHERE id = 'kitchen'").get()).toEqual(
      revokedAt
    );

    expect((await call("GET", "/api/members", KITCHEN_KEY)).statusCode).toBe(403);
    expect((await call("GET", "/api/members", ADMIN_KEY)).statusCode).toBe(200);
    expect((await call("POST", "/api/auth/credentials/missing/revoke", ADMIN_KEY)).json()).toEqual({
      code: "credential_not_found",
      message: "No credential with id missing",
    });
  });

  it("lets the admin revoke the device it is using, which logs it out", async () => {
    const response = await call("POST", "/api/auth/credentials/admin/revoke", ADMIN_KEY);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ revoked: true, credential: { current: true } });
    const next = await call("GET", "/api/auth/credentials", ADMIN_KEY);
    expect(next.statusCode).toBe(403);
    expect(next.json()).toMatchObject({ code: "credential_invalid" });
  });

  it("refuses the configured bootstrap key but retires a stale one", async () => {
    insertKey("boot-current", BOOTSTRAP_KEY, "bootstrap");
    insertKey("boot-old", "mpk-old-bootstrap-key", "bootstrap");
    process.env.MP_BOOTSTRAP_KEY = BOOTSTRAP_KEY;

    const listed = (await call("GET", "/api/auth/credentials", ADMIN_KEY)).json() as {
      credentials: Array<{ id: string; configuredBootstrap: boolean }>;
    };
    expect(listed.credentials.filter((c) => c.configuredBootstrap).map((c) => c.id)).toEqual([
      "boot-current",
    ]);

    const refused = await call("POST", "/api/auth/credentials/boot-current/revoke", ADMIN_KEY);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({
      code: "configured_bootstrap",
      message: expect.stringMatching(/change the variable and restart/),
    });
    expect(refused.body).not.toContain(BOOTSTRAP_KEY);
    expect(
      getDb().prepare("SELECT revoked_at FROM api_keys WHERE id = 'boot-current'").get()
    ).toEqual({ revoked_at: null });

    const stale = await call("POST", "/api/auth/credentials/boot-old/revoke", ADMIN_KEY);
    expect(stale.statusCode).toBe(200);
    expect(stale.json()).toMatchObject({ revoked: true, credential: { state: "revoked" } });

    // With no MP_BOOTSTRAP_KEY configured, no bootstrap row is protected.
    delete process.env.MP_BOOTSTRAP_KEY;
    expect(
      (await call("POST", "/api/auth/credentials/boot-current/revoke", ADMIN_KEY)).statusCode
    ).toBe(200);
  });

  it("labels a credential and rejects invalid labels or bodies", async () => {
    const renamed = await call("PATCH", "/api/auth/credentials/kitchen", ADMIN_KEY, {
      label: "  Kitchen tablet ",
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ id: "kitchen", label: "Kitchen tablet" });

    for (const payload of [{ label: "   " }, { label: "x".repeat(81) }]) {
      const response = await call("PATCH", "/api/auth/credentials/kitchen", ADMIN_KEY, payload);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_label" });
    }
    for (const payload of [{ label: 3 }, { label: "ok", kind: "bootstrap" }, ["label"]]) {
      expect(
        (await call("PATCH", "/api/auth/credentials/kitchen", ADMIN_KEY, payload)).statusCode
      ).toBe(400);
    }
    const missing = await call("PATCH", "/api/auth/credentials/missing", ADMIN_KEY, {
      label: "Ghost",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "credential_not_found" });
    expect(getDb().prepare("SELECT label FROM api_keys WHERE id = 'kitchen'").get()).toEqual({
      label: "Kitchen tablet",
    });
  });
});
