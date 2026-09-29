import { describe, it, expect } from "vitest";
import { useIsolatedDb } from "../helpers/db";

/** Routines-chores assembly smoke.
 * Asserts each of the 17 routes is registered (app.hasRoute(...), NOT via
 * HTTP response — the access gate returns the gate-form for all non-/api
 * paths) AND is auth-protected (no device cookie → 401).
 * Wiring only — behavior lands in later tasks (–).
 */

const ROUTES = [
  // Routines CRUD (5)
  { method: "GET", url: "/api/routines" },
  { method: "POST", url: "/api/routines" },
  { method: "GET", url: "/api/routines/:id" },
  { method: "PATCH", url: "/api/routines/:id" },
  { method: "DELETE", url: "/api/routines/:id" },
  // Chores CRUD (6)
  { method: "GET", url: "/api/routines/:id/chores" },
  { method: "POST", url: "/api/routines/:id/chores" },
  { method: "PUT", url: "/api/routines/:id/chores/order" },
  { method: "GET", url: "/api/chores/:id" },
  { method: "PATCH", url: "/api/chores/:id" },
  { method: "DELETE", url: "/api/chores/:id" },
  // Assignments (3)
  { method: "GET", url: "/api/routines/:id/assignments" },
  { method: "PUT", url: "/api/routines/:id/assignments/:memberId" },
  { method: "DELETE", url: "/api/routines/:id/assignments/:memberId" },
  // Board (1)
  { method: "GET", url: "/api/chores/board" },
  // Completions (2)
  { method: "POST", url: "/api/chores/:id/completions" },
  { method: "DELETE", url: "/api/chores/:id/completions" },
] as const;

describe("routines-chores assembly (T003 — wiring verification)", () => {
  useIsolatedDb();

  // Route-registration tests (one per route)
  for (const { method, url } of ROUTES) {
    it(`${method} ${url} is registered (T003)`, async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const app = await buildApp();
      try {
        expect(app.hasRoute({ method, url })).toBe(true);
      } finally {
        await app.close();
      }
    });
  }

  // Auth-protection tests (one per route)
  for (const { method, url } of ROUTES) {
    it(`${method} ${url} requires auth (401 without device cookie, T003)`, async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const app = await buildApp();
      try {
        const res = await app.inject({ method, url });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });
  }

  it("No table-exposing routes exist (e.g., /api/routines/transactions)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      expect(app.hasRoute({ method: "GET", url: "/api/routines/transactions" })).toBe(false);
    } finally {
      await app.close();
    }
  });
});
