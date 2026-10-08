import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { weekdayOf } from "../../src/server/lib/household-date";
import { useIsolatedDb } from "../helpers/db";

/** / — US1 derived day-menu boundary tests, / — US2 recurring
 * union + week-view boundary tests (RED first).
 * BLACK-BOX: buildApp + Fastify.inject only. Covers FR-012/013/014
 * (one-off derived union, empty = absence, canonical order) and
 * (the total order terminating in the unique entry `id`), plus FR-021
 * concurrency LWW. Recurring half ( FR-015/016/017/019): a
 * recurring entry emits only on its matching weekday (AC scenario 1); a
 * multi-plan union in the FULL D2 total order (recurring before one-off ->
 * plan-name ASC -> meal_plan_id ASC (duplicate-plan-name tiebreak) ->
 * created_at ASC -> id ASC); deactivate-drops + reactivate-restores without
 * deleting rows (AC-05); editing/deactivating changes EVERY matching
 * weekday, no per-date skip (AC-04); and the week view over 7 local dates
 * from `weekStartDay` + tz (FR-019).
 */
describe("meals-menu boundary tests", () => {
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

  async function createMealPlan(app: FastifyInstance, deviceKey: string, name: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/meal-plans",
      cookies: { mp_device_key: deviceKey },
      payload: { name },
    });
    return JSON.parse(res.body) as { id: string; name: string };
  }

  function editMealPlan(
    app: FastifyInstance,
    deviceKey: string,
    id: string,
    body: Record<string, unknown>
  ) {
    return app.inject({
      method: "PATCH",
      url: `/api/meal-plans/${id}`,
      cookies: { mp_device_key: deviceKey },
      payload: body,
    });
  }

  function getWeekMenu(app: FastifyInstance, deviceKey: string, date: string) {
    return app.inject({
      method: "GET",
      url: `/api/menu/week?date=${date}`,
      cookies: { mp_device_key: deviceKey },
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

  it("rejects invalid dates on both menu HTTP reads without writes", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      await app.ready();
      const before = getDb().prepare("SELECT total_changes() AS changes").get();
      for (const url of ["/api/menu?date=not-a-date", "/api/menu/week?date=not-a-date"]) {
        const response = await app.inject({
          method: "GET",
          url,
          cookies: { mp_device_key: deviceKey },
        });
        expect(response.statusCode, url).toBe(400);
        expect(response.json()).toMatchObject({
          error: "validation_error",
          message: expect.any(String),
        });
      }
      expect(getDb().prepare("SELECT total_changes() AS changes").get()).toEqual(before);
    } finally {
      await app.close();
    }
  });

  // ── one-off derived union ───────────────────────────────────────────────

  it("GET /api/menu?date= (no slot) unions every slot's one-off entries for that date", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const recipe = await createRecipe(app, deviceKey, "Tortilla");
      const date = "2026-09-20";
      await createEntry(app, deviceKey, {
        kind: "oneoff",
        date,
        slot: "breakfast",
        recipeId: recipe.id,
      });
      await createEntry(app, deviceKey, { kind: "oneoff", date, slot: "lunch", note: "sobras" });
      await createEntry(app, deviceKey, { kind: "oneoff", date, slot: "dinner", note: "pizza" });

      const menuRes = await getMenu(app, deviceKey, date);
      expect(menuRes.statusCode).toBe(200);
      const menu = JSON.parse(menuRes.body);
      expect(menu).toHaveLength(3);
      expect(menu.map((item: { slot: string }) => item.slot).sort()).toEqual([
        "breakfast",
        "dinner",
        "lunch",
      ]);
    } finally {
      await app.close();
    }
  });

  // ── empty = absence (FR-012) ────────────────────────────────────────────

  it("GET /api/menu for a (date,slot) with no entries -> [] (absence, not a placeholder)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const menuRes = await getMenu(app, deviceKey, "2026-09-21", "lunch");
      expect(menuRes.statusCode).toBe(200);
      expect(JSON.parse(menuRes.body)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("GET /api/menu for a date with no entries at all -> [] across every slot", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const menuRes = await getMenu(app, deviceKey, "2026-09-22");
      expect(menuRes.statusCode).toBe(200);
      expect(JSON.parse(menuRes.body)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  // ── canonical TOTAL order ─────────────────────────────────

  it("orders entries by created_at ASC (one-off tail of the D2 total order)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const date = "2026-09-23";
      const db = getDb();

      // Seed three entries with DISTINCT created_at, out of insertion order,
      // to prove the sort is by created_at, not by raw insertion sequence.
      db.prepare(
        "INSERT INTO meal_entries (id, meal_plan_id, weekday, entry_date, slot, recipe_id, note, created_at) VALUES (?, NULL, NULL, ?, 'lunch', NULL, ?, ?)"
      ).run("entry-c", date, "third", 3000);
      db.prepare(
        "INSERT INTO meal_entries (id, meal_plan_id, weekday, entry_date, slot, recipe_id, note, created_at) VALUES (?, NULL, NULL, ?, 'lunch', NULL, ?, ?)"
      ).run("entry-a", date, "first", 1000);
      db.prepare(
        "INSERT INTO meal_entries (id, meal_plan_id, weekday, entry_date, slot, recipe_id, note, created_at) VALUES (?, NULL, NULL, ?, 'lunch', NULL, ?, ?)"
      ).run("entry-b", date, "second", 2000);

      const menuRes = await getMenu(app, deviceKey, date, "lunch");
      expect(menuRes.statusCode).toBe(200);
      const menu = JSON.parse(menuRes.body);
      expect(menu.map((item: { label: string }) => item.label)).toEqual([
        "first",
        "second",
        "third",
      ]);
    } finally {
      await app.close();
    }
  });

  it("breaks an equal-created_at tie by entry id ASC (D2 terminal tiebreak)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const date = "2026-09-24";
      const db = getDb();
      const sameCreatedAt = 5000;

      // Seed two entries with the SAME created_at (a same-ms insert), ids
      // deliberately out of lexical order, to prove the terminal `id ASC`
      // tiebreak — not vacuous timing luck.
      db.prepare(
        "INSERT INTO meal_entries (id, meal_plan_id, weekday, entry_date, slot, recipe_id, note, created_at) VALUES (?, NULL, NULL, ?, 'dinner', NULL, ?, ?)"
      ).run("zzz-entry", date, "should-be-second", sameCreatedAt);
      db.prepare(
        "INSERT INTO meal_entries (id, meal_plan_id, weekday, entry_date, slot, recipe_id, note, created_at) VALUES (?, NULL, NULL, ?, 'dinner', NULL, ?, ?)"
      ).run("aaa-entry", date, "should-be-first", sameCreatedAt);

      const menuRes = await getMenu(app, deviceKey, date, "dinner");
      expect(menuRes.statusCode).toBe(200);
      const menu = JSON.parse(menuRes.body);
      expect(menu.map((item: { label: string }) => item.label)).toEqual([
        "should-be-first",
        "should-be-second",
      ]);
      expect(menu.map((item: { entryId: string }) => item.entryId)).toEqual([
        "aaa-entry",
        "zzz-entry",
      ]);
    } finally {
      await app.close();
    }
  });

  it("two reads of an unchanged menu are byte-identical (FR-013 reproducibility)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const date = "2026-09-25";
      await createEntry(app, deviceKey, { kind: "oneoff", date, slot: "lunch", note: "sobras" });
      await createEntry(app, deviceKey, { kind: "oneoff", date, slot: "lunch", note: "pizza" });

      const first = await getMenu(app, deviceKey, date, "lunch");
      const second = await getMenu(app, deviceKey, date, "lunch");
      expect(JSON.parse(first.body)).toEqual(JSON.parse(second.body));
    } finally {
      await app.close();
    }
  });

  // ── FR-024: one MenuItem per entry, incl. exact duplicate labels ───────

  it("does not collapse duplicate note labels — one MenuItem per entry (FR-024)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const date = "2026-09-26";
      await createEntry(app, deviceKey, { kind: "oneoff", date, slot: "snack", note: "manzana" });
      await createEntry(app, deviceKey, { kind: "oneoff", date, slot: "snack", note: "manzana" });

      const menuRes = await getMenu(app, deviceKey, date, "snack");
      const menu = JSON.parse(menuRes.body);
      expect(menu).toHaveLength(2);
      expect(menu[0].label).toBe("manzana");
      expect(menu[1].label).toBe("manzana");
      expect(menu[0].entryId).not.toBe(menu[1].entryId);
    } finally {
      await app.close();
    }
  });

  // ── concurrency LWW (FR-021) ─────────────────────────────────────────────

  it("two concurrent adds to the same (date,slot) both succeed, no etag/version (FR-021)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const date = "2026-09-27";
      const [a, b] = await Promise.all([
        createEntry(app, deviceKey, { kind: "oneoff", date, slot: "breakfast", note: "cafe" }),
        createEntry(app, deviceKey, { kind: "oneoff", date, slot: "breakfast", note: "te" }),
      ]);
      expect(a.statusCode).toBe(201);
      expect(b.statusCode).toBe(201);

      const menuRes = await getMenu(app, deviceKey, date, "breakfast");
      expect(JSON.parse(menuRes.body)).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it("a double-delete of the same entry is a no-op/not-found, not a 500 (FR-021 LWW)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createEntry(app, deviceKey, {
        kind: "oneoff",
        date: "2026-09-28",
        slot: "snack",
        note: "manzana",
      });
      const entry = JSON.parse(createRes.body);

      const first = await deleteEntry(app, deviceKey, entry.id);
      expect(first.statusCode).toBe(204);
      const second = await deleteEntry(app, deviceKey, entry.id);
      expect([404]).toContain(second.statusCode);
    } finally {
      await app.close();
    }
  });

  // ── / — recurring union (US2, FR-015/016/017) ────────────────────

  it("a recurring entry emits only on its matching weekday (AC scenario 1)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const recipe = await createRecipe(app, deviceKey, "Lentejas");
      const plan = await createMealPlan(app, deviceKey, "Semana normal");

      const matchingDate = "2026-08-17";
      const weekday = weekdayOf(matchingDate, "Europe/Madrid");
      const nonMatchingDate = "2026-08-18"; // the next calendar day -> a different weekday

      await createEntry(app, deviceKey, {
        kind: "recurring",
        mealPlanId: plan.id,
        weekday,
        slot: "lunch",
        recipeId: recipe.id,
      });

      const matching = await getMenu(app, deviceKey, matchingDate, "lunch");
      expect(JSON.parse(matching.body)).toHaveLength(1);

      const nonMatching = await getMenu(app, deviceKey, nonMatchingDate, "lunch");
      expect(JSON.parse(nonMatching.body)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it(
    "unions TWO active plans' matching-weekday entries + a one-off in the FULL D2 total order, " +
      "incl. duplicate-plan-name tiebreak by meal_plan_id",
    async () => {
      const { deviceKey } = seedKeys();
      const { buildApp } = await import("../../src/server/app.ts");
      const app = await buildApp();
      try {
        // Two ACTIVE plans sharing the SAME name -> the D2 tiebreak (plan_name ASC is a tie,
        // broken by meal_plan_id ASC) is genuinely exercised, not vacuous.
        const planA = await createMealPlan(app, deviceKey, "Semana");
        const planB = await createMealPlan(app, deviceKey, "Semana");
        const [firstPlan, secondPlan] = [planA, planB].sort((a, b) => (a.id < b.id ? -1 : 1));

        const date = "2026-08-17";
        const weekday = weekdayOf(date, "Europe/Madrid");

        await createEntry(app, deviceKey, {
          kind: "recurring",
          mealPlanId: secondPlan.id,
          weekday,
          slot: "lunch",
          note: "from-second-plan",
        });
        await createEntry(app, deviceKey, {
          kind: "recurring",
          mealPlanId: firstPlan.id,
          weekday,
          slot: "lunch",
          note: "from-first-plan",
        });
        await createEntry(app, deviceKey, {
          kind: "oneoff",
          date,
          slot: "lunch",
          note: "one-off-sobras",
        });

        const menuRes = await getMenu(app, deviceKey, date, "lunch");
        expect(menuRes.statusCode).toBe(200);
        const menu = JSON.parse(menuRes.body);
        expect(menu).toHaveLength(3);
        // recurring (tiebroken by meal_plan_id ASC) BEFORE one-off.
        expect(menu.map((item: { label: string }) => item.label)).toEqual([
          "from-first-plan",
          "from-second-plan",
          "one-off-sobras",
        ]);
        expect(menu.map((item: { source: string }) => item.source)).toEqual([
          "recurring",
          "recurring",
          "oneoff",
        ]);
        expect(menu).toEqual([
          expect.objectContaining({
            source: "recurring",
            recipeId: null,
            note: "from-first-plan",
          }),
          expect.objectContaining({
            source: "recurring",
            recipeId: null,
            note: "from-second-plan",
          }),
          expect.objectContaining({
            source: "oneoff",
            recipeId: null,
            note: "one-off-sobras",
          }),
        ]);

        const weekRes = await getWeekMenu(app, deviceKey, date);
        expect(weekRes.statusCode).toBe(200);
        expect(JSON.parse(weekRes.body)[date].lunch).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ note: "from-first-plan", recipeId: null }),
            expect.objectContaining({ note: "from-second-plan", recipeId: null }),
          ])
        );
      } finally {
        await app.close();
      }
    }
  );

  it("deactivating one of two active plans drops only its contribution; reactivating restores it (AC-05)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const planA = await createMealPlan(app, deviceKey, "Plan A");
      const planB = await createMealPlan(app, deviceKey, "Plan B");

      const date = "2026-08-17";
      const weekday = weekdayOf(date, "Europe/Madrid");

      await createEntry(app, deviceKey, {
        kind: "recurring",
        mealPlanId: planA.id,
        weekday,
        slot: "dinner",
        note: "plan-a-entry",
      });
      await createEntry(app, deviceKey, {
        kind: "recurring",
        mealPlanId: planB.id,
        weekday,
        slot: "dinner",
        note: "plan-b-entry",
      });

      const before = await getMenu(app, deviceKey, date, "dinner");
      expect(JSON.parse(before.body)).toHaveLength(2);

      await editMealPlan(app, deviceKey, planA.id, { active: false });

      const during = await getMenu(app, deviceKey, date, "dinner");
      const duringMenu = JSON.parse(during.body);
      expect(duringMenu).toHaveLength(1);
      expect(duringMenu[0].label).toBe("plan-b-entry");

      await editMealPlan(app, deviceKey, planA.id, { active: true });

      const after = await getMenu(app, deviceKey, date, "dinner");
      expect(JSON.parse(after.body)).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  // ── no per-date skip (AC-04) ──────────────────────────────────────────────

  it("editing a recurring entry's content changes EVERY matching weekday — no per-date skip (AC-04)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const plan = await createMealPlan(app, deviceKey, "Semana normal");

      // Exactly 7 days apart -> guaranteed the same weekday.
      const firstOccurrence = "2026-08-17";
      const secondOccurrence = "2026-08-24";
      const weekday = weekdayOf(firstOccurrence, "Europe/Madrid");
      expect(weekdayOf(secondOccurrence, "Europe/Madrid")).toBe(weekday);

      const createRes = await createEntry(app, deviceKey, {
        kind: "recurring",
        mealPlanId: plan.id,
        weekday,
        slot: "lunch",
        note: "Lentejas",
      });
      const entry = JSON.parse(createRes.body);

      const beforeFirst = await getMenu(app, deviceKey, firstOccurrence, "lunch");
      expect(JSON.parse(beforeFirst.body)[0].label).toBe("Lentejas");
      const beforeSecond = await getMenu(app, deviceKey, secondOccurrence, "lunch");
      expect(JSON.parse(beforeSecond.body)[0].label).toBe("Lentejas");

      const editRes = await editEntry(app, deviceKey, entry.id, { note: "Pizza" });
      expect(editRes.statusCode).toBe(200);

      const afterFirst = await getMenu(app, deviceKey, firstOccurrence, "lunch");
      expect(JSON.parse(afterFirst.body)[0].label).toBe("Pizza");
      const afterSecond = await getMenu(app, deviceKey, secondOccurrence, "lunch");
      expect(JSON.parse(afterSecond.body)[0].label).toBe("Pizza");
    } finally {
      await app.close();
    }
  });

  // ── week view over 7 local dates from weekStartDay + tz (FR-019) ─────────

  it("GET /api/menu/week?date= returns 7 local dates starting at weekStartDay, each grouped by slot", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const plan = await createMealPlan(app, deviceKey, "Semana normal");
      const refDate = "2026-08-19"; // a Wednesday, mid-week
      const weekday = weekdayOf(refDate, "Europe/Madrid");
      await createEntry(app, deviceKey, {
        kind: "recurring",
        mealPlanId: plan.id,
        weekday,
        slot: "lunch",
        note: "Lentejas",
      });

      const res = await getWeekMenu(app, deviceKey, refDate);
      expect(res.statusCode).toBe(200);
      const week = JSON.parse(res.body) as Record<string, Record<string, unknown[]>>;
      const dates = Object.keys(week).sort();
      expect(dates).toHaveLength(7);

      // The default weekStartDay app-setting is 1 (Monday, ADR-028/app-settings-registry.md) —
      // no new setting is added this module.
      expect(weekdayOf(dates[0], "Europe/Madrid")).toBe("mon");
      expect(weekdayOf(dates[6], "Europe/Madrid")).toBe("sun");
      expect(dates).toContain(refDate);

      // Per-slot buckets (date -> slot -> MenuItem[]), matching
      // docs/api/meals/openapi.yaml WeekMenu, not a flat date -> MenuItem[] list.
      expect(week[refDate].lunch).toHaveLength(1);
      expect(week[refDate].breakfast).toEqual([]);
      expect(week[refDate].snack).toEqual([]);
      expect(week[refDate].dinner).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
