import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/server/app.js";
import { authBoundary } from "../../src/server/auth/boundary.js";
import { requireFullAccess } from "../../src/server/auth/capability.js";
import { hashKey } from "../../src/server/auth/credentials.js";
import { getDb } from "../../src/server/db/client.js";
import { useIsolatedDb } from "../helpers/db.js";

type KeyKind = "bootstrap" | "device" | "integration";

function seedKey(options: {
  raw: string;
  scope?: string;
  kind?: KeyKind;
  revokedAt?: number | null;
  expiresAt?: number | null;
}): void {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO api_keys
         (id, key_hash, scope, kind, created_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      `key-${options.raw}`,
      hashKey(options.raw),
      options.scope ?? "*",
      options.kind ?? "device",
      now,
      options.expiresAt ?? null,
      options.revokedAt ?? null
    );
}

async function buildProbe() {
  const app = Fastify();
  let fullAccessDisclosures = 0;
  await authBoundary(app);
  app.get("/api/plugins/full-access-probe", { preHandler: requireFullAccess() }, async () => {
    fullAccessDisclosures += 1;
    return { secretCatalog: true };
  });
  return {
    app,
    fullAccessDisclosures: () => fullAccessDisclosures,
  };
}

describe("full-access authentication boundary", () => {
  useIsolatedDb();

  it("authorizes a live provisioned-device cookie with scope '*'", async () => {
    seedKey({ raw: "device-full" });
    const { app } = await buildProbe();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/plugins/full-access-probe",
        cookies: { mp_device_key: "device-full" },
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("authorizes a live raw bearer integration key with scope '*'", async () => {
    seedKey({ raw: "integration-full", kind: "integration" });
    const { app } = await buildProbe();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/plugins/full-access-probe",
        headers: { authorization: "Bearer integration-full" },
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("does not widen an existing unscoped API route to raw bearer authentication", async () => {
    seedKey({ raw: "integration-full", kind: "integration" });
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/settings",
        headers: { authorization: "Bearer integration-full" },
      });
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain("locale");
    } finally {
      await app.close();
    }
  });

  it("preserves bootstrap-cookie compatibility on an existing unscoped API route", async () => {
    seedKey({ raw: "bootstrap-cookie", kind: "bootstrap" });
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/settings",
        cookies: { mp_device_key: "bootstrap-cookie" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveProperty("locale");
    } finally {
      await app.close();
    }
  });

  it.each([
    {
      name: "device key over bearer transport",
      raw: "device-as-bearer",
      kind: "device" as const,
      request: { headers: { authorization: "Bearer device-as-bearer" } },
    },
    {
      name: "integration key over cookie transport",
      raw: "integration-as-cookie",
      kind: "integration" as const,
      request: { cookies: { mp_device_key: "integration-as-cookie" } },
    },
    {
      name: "bootstrap key over cookie transport",
      raw: "bootstrap-as-cookie",
      kind: "bootstrap" as const,
      request: { cookies: { mp_device_key: "bootstrap-as-cookie" } },
    },
  ])("denies $name at the plugin capability layer", async (probe) => {
    seedKey({ raw: probe.raw, kind: probe.kind });
    const { app, fullAccessDisclosures } = await buildProbe();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/plugins/full-access-probe",
        ...probe.request,
      });
      expect(response.statusCode).toBe(403);
      expect(Object.keys(response.json()).sort()).toEqual(["code", "error", "message"]);
      expect(fullAccessDisclosures()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("requires exact scope '*' rather than a scope set containing '*'", async () => {
    seedKey({ raw: "device-mixed-scope", scope: "plugins:read *" });
    const { app, fullAccessDisclosures } = await buildProbe();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/plugins/full-access-probe",
        cookies: { mp_device_key: "device-mixed-scope" },
      });
      expect(response.statusCode).toBe(403);
      expect(fullAccessDisclosures()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it.each([
    {
      name: "missing",
      prepare: () => undefined,
      request: {},
      status: 401,
    },
    {
      name: "scoped",
      prepare: () => seedKey({ raw: "device-scoped", scope: "plugins:read" }),
      request: { cookies: { mp_device_key: "device-scoped" } },
      status: 403,
    },
    {
      name: "revoked",
      prepare: () => seedKey({ raw: "device-revoked", revokedAt: Date.now() - 1 }),
      request: { cookies: { mp_device_key: "device-revoked" } },
      status: 403,
    },
    {
      name: "expired",
      prepare: () => seedKey({ raw: "device-expired", expiresAt: Date.now() - 1 }),
      request: { cookies: { mp_device_key: "device-expired" } },
      status: 403,
    },
    {
      name: "scoped integration bearer",
      prepare: () =>
        seedKey({ raw: "integration-scoped", kind: "integration", scope: "plugins:read" }),
      request: { headers: { authorization: "Bearer integration-scoped" } },
      status: 403,
    },
    {
      name: "revoked integration bearer",
      prepare: () =>
        seedKey({
          raw: "integration-revoked",
          kind: "integration",
          revokedAt: Date.now() - 1,
        }),
      request: { headers: { authorization: "Bearer integration-revoked" } },
      status: 403,
    },
    {
      name: "expired integration bearer",
      prepare: () =>
        seedKey({
          raw: "integration-expired",
          kind: "integration",
          expiresAt: Date.now() - 1,
        }),
      request: { headers: { authorization: "Bearer integration-expired" } },
      status: 403,
    },
  ])("denies a $name credential before the protected handler can disclose", async (probe) => {
    probe.prepare();
    const { app, fullAccessDisclosures } = await buildProbe();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/plugins/full-access-probe",
        ...probe.request,
      });
      expect(response.statusCode).toBe(probe.status);
      expect(fullAccessDisclosures()).toBe(0);
      expect(response.body).not.toContain("secretCatalog");
    } finally {
      await app.close();
    }
  });

  it("fails closed before disclosure when cookie and bearer credentials conflict", async () => {
    seedKey({ raw: "device-full" });
    seedKey({ raw: "integration-full", kind: "integration" });
    const { app, fullAccessDisclosures } = await buildProbe();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/plugins/full-access-probe",
        cookies: { mp_device_key: "device-full" },
        headers: { authorization: "Bearer integration-full" },
      });
      expect(response.statusCode).toBe(401);
      expect(fullAccessDisclosures()).toBe(0);
      expect(response.body).not.toContain("secretCatalog");
    } finally {
      await app.close();
    }
  });

  it("does not accept an Admin PIN as backend authorization", async () => {
    const { app, fullAccessDisclosures } = await buildProbe();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/plugins/full-access-probe",
        headers: { "x-admin-pin": "1234" },
      });
      expect(response.statusCode).toBe(401);
      expect(fullAccessDisclosures()).toBe(0);
    } finally {
      await app.close();
    }
  });
});
