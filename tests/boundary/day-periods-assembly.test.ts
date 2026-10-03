import { describe, it, expect } from "vitest";
import { useIsolatedDb } from "../helpers/db";

/** / — Day Periods assembly boundary test (wiring verification).
 * BLACK-BOX: Uses buildApp + Fastify.inject only.
 * Asserts three things:
 * 1. All new routes are registered:
 * - GET /api/day-periods
 * - PATCH /api/day-periods/:id
 * - GET /api/day-periods/active
 * 2. Each route is auth-boundary-protected (ADR-059):
 * - No device cookie → 401
 * No behaviour is tested — only registration + auth boundary.
 */
describe("day-periods-assembly (wiring verification)", () => {
  useIsolatedDb();

  it("GET /api/day-periods is registered", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const app = await buildApp();

    try {
      expect(app.hasRoute({ method: "GET", url: "/api/day-periods" })).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("PATCH /api/day-periods/:id is registered", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const app = await buildApp();

    try {
      expect(app.hasRoute({ method: "PATCH", url: "/api/day-periods/:id" })).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("GET /api/day-periods/active is registered", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const app = await buildApp();

    try {
      expect(app.hasRoute({ method: "GET", url: "/api/day-periods/active" })).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("GET /api/day-periods requires auth (401 without device cookie)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/day-periods",
      });

      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("PATCH /api/day-periods/:id requires auth (401 without device cookie)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/day-periods/morning",
      });

      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("GET /api/day-periods/active requires auth (401 without device cookie)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/day-periods/active",
      });

      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
