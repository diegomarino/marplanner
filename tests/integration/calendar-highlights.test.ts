import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { getDb } from "../../src/server/db/client";
import { calendarRoutes } from "../../src/server/routes/calendar";
import { useIsolatedDb } from "../helpers/db";

describe("Calendar highlight routes", () => {
  useIsolatedDb();

  it("creates, lists, reorders, toggles and deletes with exact response shapes", async () => {
    const app = Fastify();
    await calendarRoutes(app);
    try {
      const create = (emoji: string, keywords: string[]) =>
        app.inject({
          method: "POST",
          url: "/api/calendar/highlight-rules",
          payload: { emoji, keywords },
        });
      expect((await create(" ", ["word"])).statusCode).toBe(400);
      const first = await create(" ⭐ ", [" Café "]);
      expect(first.statusCode).toBe(201);
      expect(first.json()).toEqual({
        id: expect.any(String),
        emoji: "⭐",
        keywords: ["Café"],
        enabled: true,
        priority: 0,
      });
      const second = await create("🎈", ["party"]);
      expect(second.statusCode).toBe(201);
      const ids = [second.json().id, first.json().id];
      const reorder = await app.inject({
        method: "PUT",
        url: "/api/calendar/highlight-rules/reorder",
        payload: { orderedIds: ids },
      });
      expect(reorder.statusCode).toBe(200);
      expect(
        reorder.json().map(({ id, priority }: { id: string; priority: number }) => [id, priority])
      ).toEqual([
        [ids[0], 0],
        [ids[1], 1],
      ]);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/calendar/highlight-rules/reorder",
            payload: { orderedIds: [ids[0]] },
          })
        ).statusCode
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: `/api/calendar/highlight-rules/${ids[0]}`,
            payload: { enabled: false },
          })
        ).json()
      ).toEqual({ id: ids[0], emoji: "🎈", keywords: ["party"], enabled: false, priority: 0 });
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: `/api/calendar/highlight-rules/${ids[0]}`,
            payload: { enabled: true, emoji: "x" },
          })
        ).statusCode
      ).toBe(400);
      expect(
        (await app.inject({ method: "GET", url: "/api/calendar/highlight-rules" }))
          .json()
          .map(({ id }: { id: string }) => id)
      ).toEqual(ids);
      expect(
        (await app.inject({ method: "DELETE", url: `/api/calendar/highlight-rules/${ids[0]}` }))
          .statusCode
      ).toBe(204);
      expect(
        (await app.inject({ method: "DELETE", url: `/api/calendar/highlight-rules/${ids[0]}` }))
          .statusCode
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: `/api/calendar/highlight-rules/${ids[0]}`,
            payload: { enabled: true },
          })
        ).statusCode
      ).toBe(404);
      expect(
        (await app.inject({ method: "GET", url: "/api/calendar/highlight-rules" })).json()
      ).toMatchObject([{ id: ids[1], priority: 0 }]);
      expect(
        getDb().prepare("SELECT COUNT(*) AS count FROM calendar_highlight_rules").get()
      ).toEqual({ count: 1 });
    } finally {
      await app.close();
    }
  });
});
