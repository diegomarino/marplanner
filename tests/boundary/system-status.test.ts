import { describe, expect, it } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

describe("system status route", () => {
  useIsolatedDb();

  function insertDevice(scope = "*"): string {
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, ?, 'device', ?)"
      )
      .run(`${Date.now()}-${scope}-device`, hashKey(deviceKey), scope, Date.now());
    return deviceKey;
  }

  it("tells an admin-capable device what is deployed", async () => {
    const deviceKey = insertDevice();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/telemetry/system-status",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["build", "checkedAt", "status"]);
      expect(body.status).toBe("ok");
      expect(Number.isNaN(Date.parse(String(body.checkedAt)))).toBe(false);
      expect(Object.keys(body.build as object).sort()).toEqual(["builtAt", "sha", "subject"]);
      // A server run from source was never built.
      expect((body.build as { builtAt: unknown }).builtAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("refuses a caller without credentials or without the admin capability", async () => {
    const writeOnly = insertDevice("telemetry:write");
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const anonymous = await app.inject({ method: "GET", url: "/api/telemetry/system-status" });
      expect(anonymous.statusCode).toBe(401);
      const scoped = await app.inject({
        method: "GET",
        url: "/api/telemetry/system-status",
        cookies: { mp_device_key: writeOnly },
      });
      expect(scoped.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("keeps the public health probe free of deploy details", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(JSON.parse(res.body)).toEqual({ status: "ok" });
    } finally {
      await app.close();
    }
  });
});
