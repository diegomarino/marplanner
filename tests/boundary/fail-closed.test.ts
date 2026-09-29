import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/server/app";
import { useIsolatedDb } from "../helpers/db";

useIsolatedDb();

/** fail-closed boundary acceptance test — FR-002 / FR-003
 * Black-box: builds the app via buildApp, exercises it with Fastify
 *.inject, asserts on HTTP status/headers/body ONLY.
 * Confirms unauthenticated requests can reach only the health endpoint and
 * that protected routes reject requests without valid credentials.
 */
describe("fail-closed (FR-002 / FR-003) — black-box", () => {
  describe("FR-002: fail-closed enforcement — /health is the only reachable route", () => {
    it("GET /health returns 200 with no credential (FR-002)", async () => {
      const app = await buildApp();

      const res = await app.inject({ method: "GET", url: "/health" });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({ status: "ok" });

      await app.close();
    });
  });

  describe("FR-003: missing credential → 401/403 on non-health routes", () => {
    it("GET /api/settings with no cookie returns 401 (FR-003)", async () => {
      const app = await buildApp();

      const res = await app.inject({ method: "GET", url: "/api/settings" });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("error", "unauthorized");
      expect(body).toHaveProperty("message");

      await app.close();
    });

    it("POST /api/auth/provision with no Authorization header returns 401 (FR-003)", async () => {
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/provision",
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("error", "unauthorized");

      await app.close();
    });

    it("POST /api/auth/verify-pin with no cookie returns 401 (FR-003)", async () => {
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/verify-pin",
        body: JSON.stringify({ pin: "0000" }),
        headers: { "content-type": "application/json" },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("error", "unauthorized");

      await app.close();
    });

    it("POST /api/members with no cookie returns 401 (FR-003)", async () => {
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/api/members",
        body: JSON.stringify({ displayName: "Ada", role: "parent" }),
        headers: { "content-type": "application/json" },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("error", "unauthorized");

      await app.close();
    });
  });

  describe("invalid / undeclared-capability key → 4xx (FR-003)", () => {
    it("GET /api/settings with a syntactically valid but unknown mpk- key returns 401 (FR-003)", async () => {
      const app = await buildApp();

      // Build a fake device key that has the right prefix/shape but was never
      // provisioned — the auth preHandler hashes it, finds no matching row,
      // and rejects with 401.
      const fakeKey = "mpk-abc-def-ghi-jkl-mno-pqr";

      const res = await app.inject({
        method: "GET",
        url: "/api/settings",
        cookies: { mp_device_key: fakeKey },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("error", "unauthorized");

      await app.close();
    });

    it("GET /api/settings with a completely invalid cookie value returns 401 (FR-003)", async () => {
      const app = await buildApp();

      const res = await app.inject({
        method: "GET",
        url: "/api/settings",
        cookies: { mp_device_key: "totally-fake-key-value" },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("error", "unauthorized");

      await app.close();
    });

    it("GET /api/settings with a malformed percent-escape cookie returns 401, not 500 (fail-closed, #109 codex P2)", async () => {
      const app = await buildApp();

      // A bare '%' is an invalid percent-escape: decodeURIComponent throws. The
      // boundary must treat a decode failure as an invalid key (401), never let it
      // bubble to a 500 — a bad credential turning /api/* into a server error is a
      // fail-closed regression. Set the raw Cookie header so '%' reaches the decode
      // unescaped (the cookies shorthand would percent-encode it).
      const res = await app.inject({
        method: "GET",
        url: "/api/settings",
        headers: { cookie: "mp_device_key=%" },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("error", "unauthorized");

      await app.close();
    });
  });

  describe("health endpoint is the sole unauthenticated surface", () => {
    it("POST /health returns 404 — /health defines only GET and is outside the API-key boundary (ADR-059)", async () => {
      const app = await buildApp();

      const res = await app.inject({ method: "POST", url: "/health" });

      // ADR-059 §1/§2: the API-key boundary now covers exactly /api/*, so root /health is not
      // gated by it. Only GET /health is defined, so other methods hit no route → 404 (was 401
      // under the old app-wide hook). POST /health remains a non-surface (no state, no data),
      // preserving the invariant that GET /health is the sole credential-free surface.
      expect(res.statusCode).toBe(404);

      await app.close();
    });
  });
});

describe("percent-encoded /api/ bypass is blocked", () => {
  it("GET /%61pi/settings with no credentials returns 401 (boundary check must decode)", async () => {
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/%61pi/settings" });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("error", "unauthorized");

    await app.close();
  });
});
