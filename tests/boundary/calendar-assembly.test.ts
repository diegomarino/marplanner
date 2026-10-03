import { describe, it, expect } from "vitest";
import { useIsolatedDb } from "../helpers/db";

describe("calendar-assembly (wiring verification)", () => {
  useIsolatedDb();

  it("GET /api/calendar/events is registered", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const app = await buildApp();

    try {
      expect(app.hasRoute({ method: "GET", url: "/api/calendar/events" })).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("POST /api/calendar/events is registered", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const app = await buildApp();

    try {
      expect(app.hasRoute({ method: "POST", url: "/api/calendar/events" })).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("PATCH /api/calendar/events/:id is registered", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const app = await buildApp();

    try {
      expect(app.hasRoute({ method: "PATCH", url: "/api/calendar/events/:id" })).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("DELETE /api/calendar/events/:id is registered", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const app = await buildApp();

    try {
      expect(app.hasRoute({ method: "DELETE", url: "/api/calendar/events/:id" })).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("PUT /api/calendar/events/:id/assignments is registered", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const app = await buildApp();

    try {
      expect(app.hasRoute({ method: "PUT", url: "/api/calendar/events/:id/assignments" })).toBe(
        true
      );
    } finally {
      await app.close();
    }
  });

  it("GET /api/calendar/events requires auth (401 without device cookie)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calendar/events",
      });

      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("POST /api/calendar/events requires auth (401 without device cookie)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/calendar/events",
      });

      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("PATCH /api/calendar/events/:id requires auth (401 without device cookie)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/calendar/events/123",
      });

      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("DELETE /api/calendar/events/:id requires auth (401 without device cookie)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/calendar/events/123",
      });

      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("PUT /api/calendar/events/:id/assignments requires auth (401 without device cookie)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "PUT",
        url: "/api/calendar/events/123/assignments",
      });

      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("No table-exposing routes exist (e.g., /api/calendar/events-table)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const app = await buildApp();

    try {
      expect(app.hasRoute({ method: "GET", url: "/api/calendar/events-table" })).toBe(false);
    } finally {
      await app.close();
    }
  });
});
