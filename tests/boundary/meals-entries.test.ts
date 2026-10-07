import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** / — US1 one-off entry boundary tests, / — US2 recurring
 * entry boundary tests (RED first).
 * BLACK-BOX: buildApp + Fastify.inject only, per the reminders-crud /
 * meals-recipes suite convention (useIsolatedDb + raw SQL seed helpers).
 * Covers FR-008/009 (additive N-per-slot, AC-01), FR-010/011 (content
 * discriminant, AC-02), (kind discriminant), FR-028 (recipe
 * existence at write — domain error, never a raw FK violation), strict
 * YYYY-MM-DD (FR-019/020), content-only edit (Clarifications), move =
 * delete + re-add, and FR-021 concurrency LWW. Recurring half (
 * FR-015/016): recurring entry create (mealPlanId+weekday, no date), kind
 * discriminant on the recurring side, weekday validation, and mealPlanId
 * existence at write (a domain error, never a raw FK violation — same
 * FR-028 rationale as recipeId).
 */
describe("meals-entries boundary tests", () => {
  useIsolatedDb();

  // ── helpers ──────────────────────────────────────────────────────────────

  function seedKeys() {
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    const db = getDb();
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${now}-device`, hashKey(deviceKey), now);
    return { deviceKey };
  }

  async function createRecipe(app: FastifyInstance, deviceKey: string, name: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/recipes",
      cookies: { mp_device_key: deviceKey },
      payload: { name },
    });
    return JSON.parse(res.body) as { id: string; name: string };
  }

  async function createMealPlan(app: FastifyInstance, deviceKey: string, name: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/meal-plans",
      cookies: { mp_device_key: deviceKey },
      payload: { name },
    });
    return JSON.parse(res.body) as { id: string; name: string };
  }

  function createEntry(app: FastifyInstance, deviceKey: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/meal-entries",
      cookies: { mp_device_key: deviceKey },
      payload: body,
    });
  }

  function editEntry(
    app: FastifyInstance,
    deviceKey: string,
    id: string,
    body: Record<string, unknown>
  ) {
    return app.inject({
      method: "PATCH",
      url: `/api/meal-entries/${id}`,
      cookies: { mp_device_key: deviceKey },
      payload: body,
    });
  }

  function deleteEntry(app: FastifyInstance, deviceKey: string, id: string) {
    return app.inject({
      method: "DELETE",
      url: `/api/meal-entries/${id}`,
      cookies: { mp_device_key: deviceKey },
    });
  }

  function getMenu(app: FastifyInstance, deviceKey: string, date: string, slot?: string) {
    const url = slot ? `/api/menu?date=${date}&slot=${slot}` : `/api/menu?date=${date}`;
    return app.inject({ method: "GET", url, cookies: { mp_device_key: deviceKey } });
  }

  // ── additive N-per-slot (FR-008/009, AC-01) ─────────────────────────────

  it("adding three entries to the same (date,slot) never displaces a sibling (AC-01)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const recipe = await createRecipe(app, deviceKey, "Lentejas");
      const date = "2026-09-01";

      const first = await createEntry(app, deviceKey, {
        kind: "oneoff",
        date,
        slot: "lunch",
        recipeId: recipe.id,
      });
      const second = await createEntry(app, deviceKey, {
        kind: "oneoff",
        date,
        slot: "lunch",
        note: "sobras",
      });
      const third = await createEntry(app, deviceKey, {
        kind: "oneoff",
        date,
        slot: "lunch",
        note: "pizza",
      });
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(third.statusCode).toBe(201);

      const menuRes = await getMenu(app, deviceKey, date, "lunch");
      expect(menuRes.statusCode).toBe(200);
      expect(JSON.parse(menuRes.body)).toHaveLength(3);
    } finally {
      await app.close();
    }
  });

  // ── content discriminant (FR-010/011, AC-02) ────────────────────────────

  it("POST /api/meal-entries with BOTH recipeId and note -> 400, nothing persisted", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const recipe = await createRecipe(app, deviceKey, "Lentejas");
      const date = "2026-09-02";

      const res = await createEntry(app, deviceKey, {
        kind: "oneoff",
        date,
        slot: "lunch",
        recipeId: recipe.id,
        note: "sobras",
      });
      expect(res.statusCode).toBe(400);

      const menuRes = await getMenu(app, deviceKey, date, "lunch");
      expect(JSON.parse(menuRes.body)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("POST /api/meal-entries with NEITHER recipeId nor note -> 400, nothing persisted", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const date = "2026-09-03";

      const res = await createEntry(app, deviceKey, { kind: "oneoff", date, slot: "lunch" });
      expect(res.statusCode).toBe(400);

      const menuRes = await getMenu(app, deviceKey, date, "lunch");
      expect(JSON.parse(menuRes.body)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  // ── kind discriminant ─────────────────────────────────────

  it("POST /api/meal-entries with BOTH {mealPlanId,weekday} and date -> 400 (kind discriminant)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const recipe = await createRecipe(app, deviceKey, "Lentejas");

      const res = await createEntry(app, deviceKey, {
        kind: "oneoff",
        date: "2026-09-04",
        weekday: "mon",
        mealPlanId: "does-not-matter",
        slot: "lunch",
        recipeId: recipe.id,
      });
      expect(res.statusCode).toBe(400);

      const menuRes = await getMenu(app, deviceKey, "2026-09-04", "lunch");
      expect(JSON.parse(menuRes.body)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("POST /api/meal-entries with NEITHER {mealPlanId,weekday} nor date -> 400 (kind discriminant)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const recipe = await createRecipe(app, deviceKey, "Lentejas");

      const res = await createEntry(app, deviceKey, {
        kind: "oneoff",
        slot: "lunch",
        recipeId: recipe.id,
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // ── FR-028: recipe-existence-at-write, domain error not a raw FK error ──

  it("POST /api/meal-entries with an unknown recipeId -> domain 400/404, never a raw FK error (FR-028)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await createEntry(app, deviceKey, {
        kind: "oneoff",
        date: "2026-09-05",
        slot: "lunch",
        recipeId: "does-not-exist",
      });
      expect([400, 404]).toContain(res.statusCode);
      const body = JSON.parse(res.body);
      // A raw better-sqlite3 FK error would surface as a 500 with a SQLite
      // message (e.g. "FOREIGN KEY constraint failed") — assert a domain
      // error shape instead.
      expect(res.statusCode).not.toBe(500);
      expect(body).toHaveProperty("error");
      expect(String(body.message ?? "")).not.toMatch(/FOREIGN KEY/i);
    } finally {
      await app.close();
    }
  });

  it("PATCH /api/meal-entries/:id with an unknown recipeId -> domain 400/404, never a raw FK error (FR-028)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createEntry(app, deviceKey, {
        kind: "oneoff",
        date: "2026-09-06",
        slot: "dinner",
        note: "sobras",
      });
      const entry = JSON.parse(createRes.body);

      const res = await editEntry(app, deviceKey, entry.id, { recipeId: "does-not-exist" });
      expect([400, 404]).toContain(res.statusCode);
      expect(res.statusCode).not.toBe(500);
    } finally {
      await app.close();
    }
  });

  // ── strict YYYY-MM-DD (FR-019/020) ──────────────────────────────────────

  it.each(["2026-9-1", "08-19-2026", "not-a-date", "2026-13-01", "2026-02-30"])(
    "POST /api/meal-entries with an invalid date %s -> 400",
    async (badDate: string) => {
      const { deviceKey } = seedKeys();
      const { buildApp } = await import("../../src/server/app.ts");
      const app = await buildApp();
      try {
        const res = await createEntry(app, deviceKey, {
          kind: "oneoff",
          date: badDate,
          slot: "lunch",
          note: "sobras",
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    }
  );

  // ── content-only edit (Clarifications) ──────────────────────────────────

  it("PATCH /api/meal-entries/:id swaps content (note -> recipeId) -> 200", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const recipe = await createRecipe(app, deviceKey, "Tortilla");
      const createRes = await createEntry(app, deviceKey, {
        kind: "oneoff",
        date: "2026-09-07",
        slot: "dinner",
        note: "sobras",
      });
      const entry = JSON.parse(createRes.body);

      const editRes = await editEntry(app, deviceKey, entry.id, { recipeId: recipe.id });
      expect(editRes.statusCode).toBe(200);
      const edited = JSON.parse(editRes.body);
      expect(edited.recipeId).toBe(recipe.id);
      expect(edited.note).toBeNull();
      expect(edited.id).toBe(entry.id);
      expect(edited.date).toBe(entry.date);
      expect(edited.slot).toBe(entry.slot);
    } finally {
      await app.close();
    }
  });

  it("PATCH /api/meal-entries/:id carrying date/weekday/slot/unknown keys -> 400 (content-only allow-list)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createEntry(app, deviceKey, {
        kind: "oneoff",
        date: "2026-09-08",
        slot: "dinner",
        note: "sobras",
      });
      const entry = JSON.parse(createRes.body);

      const dateRes = await editEntry(app, deviceKey, entry.id, { date: "2026-09-09" });
      expect(dateRes.statusCode).toBe(400);

      const weekdayRes = await editEntry(app, deviceKey, entry.id, { weekday: "mon" });
      expect(weekdayRes.statusCode).toBe(400);

      const slotRes = await editEntry(app, deviceKey, entry.id, { slot: "breakfast" });
      expect(slotRes.statusCode).toBe(400);

      const unknownRes = await editEntry(app, deviceKey, entry.id, { unknownField: "x" });
      expect(unknownRes.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("PATCH /api/meal-entries/:id with both recipeId and note -> 400", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const recipe = await createRecipe(app, deviceKey, "Tortilla");
      const createRes = await createEntry(app, deviceKey, {
        kind: "oneoff",
        date: "2026-09-10",
        slot: "dinner",
        note: "sobras",
      });
      const entry = JSON.parse(createRes.body);

      const res = await editEntry(app, deviceKey, entry.id, { recipeId: recipe.id, note: "pizza" });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("PATCH /api/meal-entries/:id with an empty body -> 400", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createEntry(app, deviceKey, {
        kind: "oneoff",
        date: "2026-09-11",
        slot: "dinner",
        note: "sobras",
      });
      const entry = JSON.parse(createRes.body);

      const res = await editEntry(app, deviceKey, entry.id, {});
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("PATCH /api/meal-entries/:id against a deleted entry id -> 404, never recreates (FR-005)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createEntry(app, deviceKey, {
        kind: "oneoff",
        date: "2026-09-12",
        slot: "dinner",
        note: "sobras",
      });
      const entry = JSON.parse(createRes.body);

      const deleteRes = await deleteEntry(app, deviceKey, entry.id);
      expect(deleteRes.statusCode).toBe(204);

      const editRes = await editEntry(app, deviceKey, entry.id, { note: "resurrected" });
      expect(editRes.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // ── delete + move = delete + re-add ─────────────────────────────────────

  it("DELETE /api/meal-entries/:id removes the entry from the derived menu", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const date = "2026-09-13";
      const createRes = await createEntry(app, deviceKey, {
        kind: "oneoff",
        date,
        slot: "breakfast",
        note: "cafe",
      });
      const entry = JSON.parse(createRes.body);

      const deleteRes = await deleteEntry(app, deviceKey, entry.id);
      expect(deleteRes.statusCode).toBe(204);

      const menuRes = await getMenu(app, deviceKey, date, "breakfast");
      expect(JSON.parse(menuRes.body)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("double-delete of an entry is a no-op/not-found (FR-021 LWW)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createEntry(app, deviceKey, {
        kind: "oneoff",
        date: "2026-09-14",
        slot: "breakfast",
        note: "cafe",
      });
      const entry = JSON.parse(createRes.body);

      const first = await deleteEntry(app, deviceKey, entry.id);
      expect(first.statusCode).toBe(204);

      const second = await deleteEntry(app, deviceKey, entry.id);
      expect(second.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("moving an entry is delete + re-add (a PATCH cannot change the date/slot)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const originalDate = "2026-09-15";
      const newDate = "2026-09-16";
      const createRes = await createEntry(app, deviceKey, {
        kind: "oneoff",
        date: originalDate,
        slot: "dinner",
        note: "sobras",
      });
      const entry = JSON.parse(createRes.body);

      // Move: delete the original, re-add at the new date.
      const deleteRes = await deleteEntry(app, deviceKey, entry.id);
      expect(deleteRes.statusCode).toBe(204);

      const recreateRes = await createEntry(app, deviceKey, {
        kind: "oneoff",
        date: newDate,
        slot: "dinner",
        note: "sobras",
      });
      expect(recreateRes.statusCode).toBe(201);

      const oldMenu = await getMenu(app, deviceKey, originalDate, "dinner");
      expect(JSON.parse(oldMenu.body)).toEqual([]);

      const newMenu = await getMenu(app, deviceKey, newDate, "dinner");
      expect(JSON.parse(newMenu.body)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  // ── FR-021 concurrency LWW: concurrent adds both succeed ────────────────

  it("two adds to the same (date,slot) both succeed (FR-021 LWW, no etag/version)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const date = "2026-09-17";
      const [first, second] = await Promise.all([
        createEntry(app, deviceKey, { kind: "oneoff", date, slot: "snack", note: "manzana" }),
        createEntry(app, deviceKey, { kind: "oneoff", date, slot: "snack", note: "platano" }),
      ]);
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);

      const menuRes = await getMenu(app, deviceKey, date, "snack");
      expect(JSON.parse(menuRes.body)).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  // ── / — recurring entry create (FR-015/016) ─────────────────────

  it("POST /api/meal-entries creates a recurring entry (mealPlanId+weekday, no date)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const recipe = await createRecipe(app, deviceKey, "Lentejas");
      const plan = await createMealPlan(app, deviceKey, "Semana normal");

      const res = await createEntry(app, deviceKey, {
        kind: "recurring",
        mealPlanId: plan.id,
        weekday: "mon",
        slot: "lunch",
        recipeId: recipe.id,
      });
      expect(res.statusCode).toBe(201);
      const entry = JSON.parse(res.body);
      expect(entry.kind).toBe("recurring");
      expect(entry.mealPlanId).toBe(plan.id);
      expect(entry.weekday).toBe("mon");
      expect(entry.date).toBeNull();
      expect(entry.recipeId).toBe(recipe.id);
    } finally {
      await app.close();
    }
  });

  it("POST /api/meal-entries recurring entry accepts a note (content xor recipeId)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const plan = await createMealPlan(app, deviceKey, "Semana normal");

      const res = await createEntry(app, deviceKey, {
        kind: "recurring",
        mealPlanId: plan.id,
        weekday: "fri",
        slot: "dinner",
        note: "Pizza",
      });
      expect(res.statusCode).toBe(201);
      const entry = JSON.parse(res.body);
      expect(entry.note).toBe("Pizza");
      expect(entry.recipeId).toBeNull();
    } finally {
      await app.close();
    }
  });

  // ── kind discriminant, recurring side ──────────────────────

  it("POST /api/meal-entries kind:recurring WITH a date -> 400 (kind discriminant)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const plan = await createMealPlan(app, deviceKey, "Semana normal");

      const res = await createEntry(app, deviceKey, {
        kind: "recurring",
        mealPlanId: plan.id,
        weekday: "mon",
        date: "2026-09-04",
        slot: "lunch",
        note: "sobras",
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("POST /api/meal-entries kind:recurring missing mealPlanId/weekday -> 400", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await createEntry(app, deviceKey, {
        kind: "recurring",
        slot: "lunch",
        note: "sobras",
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("POST /api/meal-entries kind:recurring with an invalid weekday -> 400", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const plan = await createMealPlan(app, deviceKey, "Semana normal");

      const res = await createEntry(app, deviceKey, {
        kind: "recurring",
        mealPlanId: plan.id,
        weekday: "someday",
        slot: "lunch",
        note: "sobras",
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("POST /api/meal-entries kind:recurring with an unknown mealPlanId -> domain 400/404, never a raw FK error", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await createEntry(app, deviceKey, {
        kind: "recurring",
        mealPlanId: "does-not-exist",
        weekday: "mon",
        slot: "lunch",
        note: "sobras",
      });
      expect([400, 404]).toContain(res.statusCode);
      expect(res.statusCode).not.toBe(500);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("error");
      expect(String(body.message ?? "")).not.toMatch(/FOREIGN KEY/i);
    } finally {
      await app.close();
    }
  });
});
