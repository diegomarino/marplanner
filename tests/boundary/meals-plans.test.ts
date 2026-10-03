import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { weekdayOf } from "../../src/server/lib/household-date";
import { useIsolatedDb } from "../helpers/db";

/** — US2 meal_plan boundary tests (RED first).
 * BLACK-BOX: buildApp + Fastify.inject only, per the meals-recipes suite convention
 * (useIsolatedDb + raw SQL seed helpers).
 * Covers meal_plan create/rename/activate/deactivate (FR-017), NO hard-delete route
 * (Clarifications — deactivate-only), and deactivation dropping a plan's entries from
 * derived menus WITHOUT deleting the rows, reactivation restoring them (AC-05). RED until
 * wires createMealPlan/renameMealPlan/setMealPlanActive + the /api/meal-plans* routes.
 */
describe("meals-plans boundary tests", () => {
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

  function createMealPlan(app: FastifyInstance, deviceKey: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/meal-plans",
      cookies: { mp_device_key: deviceKey },
      payload: body,
    });
  }

  function listMealPlans(app: FastifyInstance, deviceKey: string) {
    return app.inject({
      method: "GET",
      url: "/api/meal-plans",
      cookies: { mp_device_key: deviceKey },
    });
  }

  function getMealPlan(app: FastifyInstance, deviceKey: string, id: string) {
    return app.inject({
      method: "GET",
      url: `/api/meal-plans/${id}`,
      cookies: { mp_device_key: deviceKey },
    });
  }

  function editMealPlan(
    app: FastifyInstance,
    deviceKey: string,
    id: string,
    patch: Record<string, unknown>
  ) {
    return app.inject({
      method: "PATCH",
      url: `/api/meal-plans/${id}`,
      cookies: { mp_device_key: deviceKey },
      payload: patch,
    });
  }

  function listPlanEntries(app: FastifyInstance, deviceKey: string, id: string) {
    return app.inject({
      method: "GET",
      url: `/api/meal-plans/${id}/entries`,
      cookies: { mp_device_key: deviceKey },
    });
  }

  function createEntry(app: FastifyInstance, deviceKey: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/meal-entries",
      cookies: { mp_device_key: deviceKey },
      payload: body,
    });
  }

  function getMenu(app: FastifyInstance, deviceKey: string, date: string, slot?: string) {
    const url = slot ? `/api/menu?date=${date}&slot=${slot}` : `/api/menu?date=${date}`;
    return app.inject({ method: "GET", url, cookies: { mp_device_key: deviceKey } });
  }

  // ── create ───────────────────────────────────────────────────────────────

  it("POST /api/meal-plans creates an active plan", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await createMealPlan(app, deviceKey, { name: "Semana normal" });
      expect(res.statusCode).toBe(201);
      const plan = JSON.parse(res.body);
      expect(plan.name).toBe("Semana normal");
      expect(plan.active).toBe(true);
      expect(plan.id).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it("POST /api/meal-plans with a blank name -> 400", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await createMealPlan(app, deviceKey, { name: "   " });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("POST /api/meal-plans with a missing name -> 400", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await createMealPlan(app, deviceKey, {});
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("POST /api/meal-plans with an unrecognized body property -> 400", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await createMealPlan(app, deviceKey, { name: "x", unknownField: 1 });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // ── list / get ───────────────────────────────────────────────────────────

  it("GET /api/meal-plans lists created plans", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      await createMealPlan(app, deviceKey, { name: "Semana normal" });
      await createMealPlan(app, deviceKey, { name: "Semana de verano" });

      const res = await listMealPlans(app, deviceKey);
      expect(res.statusCode).toBe(200);
      const plans = JSON.parse(res.body);
      expect(plans).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it("GET /api/meal-plans/:id fetches one plan; unknown id -> 404", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createMealPlan(app, deviceKey, { name: "Semana normal" });
      const plan = JSON.parse(createRes.body);

      const res = await getMealPlan(app, deviceKey, plan.id);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).id).toBe(plan.id);

      const missing = await getMealPlan(app, deviceKey, "does-not-exist");
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // ── rename / activate / deactivate ──────────────────────────────────────

  it("PATCH /api/meal-plans/:id renames the plan", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createMealPlan(app, deviceKey, { name: "Semana normal" });
      const plan = JSON.parse(createRes.body);

      const res = await editMealPlan(app, deviceKey, plan.id, { name: "Semana especial" });
      expect(res.statusCode).toBe(200);
      const edited = JSON.parse(res.body);
      expect(edited.name).toBe("Semana especial");
      expect(edited.id).toBe(plan.id);
      expect(edited.active).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("PATCH /api/meal-plans/:id deactivates then reactivates the plan", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createMealPlan(app, deviceKey, { name: "Semana normal" });
      const plan = JSON.parse(createRes.body);

      const deactivateRes = await editMealPlan(app, deviceKey, plan.id, { active: false });
      expect(deactivateRes.statusCode).toBe(200);
      expect(JSON.parse(deactivateRes.body).active).toBe(false);

      const reactivateRes = await editMealPlan(app, deviceKey, plan.id, { active: true });
      expect(reactivateRes.statusCode).toBe(200);
      expect(JSON.parse(reactivateRes.body).active).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("PATCH /api/meal-plans/:id with an empty body -> 400", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createMealPlan(app, deviceKey, { name: "Semana normal" });
      const plan = JSON.parse(createRes.body);

      const res = await editMealPlan(app, deviceKey, plan.id, {});
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("PATCH /api/meal-plans/:id with an unrecognized body property -> 400 (handler allow-list)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createMealPlan(app, deviceKey, { name: "Semana normal" });
      const plan = JSON.parse(createRes.body);

      const res = await editMealPlan(app, deviceKey, plan.id, { unknownField: 1 });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // ── atomicity: a rejected PATCH must persist nothing ─────────────────────

  it.each([2, "yes"])(
    "PATCH /api/meal-plans/:id with a valid name + an invalid active (%j) is atomic — the rename does NOT persist",
    async (invalidActive) => {
      const { deviceKey } = seedKeys();
      const { buildApp } = await import("../../src/server/app.ts");
      const app = await buildApp();
      try {
        const createRes = await createMealPlan(app, deviceKey, { name: "Semana normal" });
        const plan = JSON.parse(createRes.body);

        const res = await editMealPlan(app, deviceKey, plan.id, {
          name: "Should not persist",
          active: invalidActive,
        });
        expect(res.statusCode).toBe(400);

        const afterRes = await getMealPlan(app, deviceKey, plan.id);
        const after = JSON.parse(afterRes.body);
        expect(after.name).toBe("Semana normal");
        expect(after.active).toBe(true);
      } finally {
        await app.close();
      }
    }
  );

  it("PATCH /api/meal-plans/:id against an unknown id -> 404", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await editMealPlan(app, deviceKey, "does-not-exist", { name: "x" });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // ── NO hard delete (Clarifications: deactivate-only) ────────────────────

  it("has NO DELETE route for meal_plans (deactivate-only, no hard delete)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      expect(app.hasRoute({ method: "DELETE", url: "/api/meal-plans/:id" })).toBe(false);
      expect(app.hasRoute({ method: "DELETE", url: "/api/meal-plans" })).toBe(false);
    } finally {
      await app.close();
    }
  });

  // ── deactivation drops entries from menus WITHOUT deleting rows (AC-05) ──

  it("deactivating a plan drops its entries from the derived menu without deleting rows; reactivating restores them", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const recipe = await createRecipe(app, deviceKey, "Lentejas");
      const planRes = await createMealPlan(app, deviceKey, { name: "Semana normal" });
      const plan = JSON.parse(planRes.body);

      const date = "2026-08-17";
      const weekday = weekdayOf(date, "Europe/Madrid");

      const entryRes = await createEntry(app, deviceKey, {
        kind: "recurring",
        mealPlanId: plan.id,
        weekday,
        slot: "lunch",
        recipeId: recipe.id,
      });
      expect(entryRes.statusCode).toBe(201);

      const beforeMenu = await getMenu(app, deviceKey, date, "lunch");
      expect(JSON.parse(beforeMenu.body)).toHaveLength(1);

      // Deactivate: the entry drops from the derived menu...
      const deactivateRes = await editMealPlan(app, deviceKey, plan.id, { active: false });
      expect(deactivateRes.statusCode).toBe(200);

      const duringMenu = await getMenu(app, deviceKey, date, "lunch");
      expect(JSON.parse(duringMenu.body)).toEqual([]);

      //...but the row survives: the plan-management read still returns it.
      const entriesRes = await listPlanEntries(app, deviceKey, plan.id);
      expect(entriesRes.statusCode).toBe(200);
      expect(JSON.parse(entriesRes.body)).toHaveLength(1);

      // Reactivate: it's back in the derived menu.
      const reactivateRes = await editMealPlan(app, deviceKey, plan.id, { active: true });
      expect(reactivateRes.statusCode).toBe(200);

      const afterMenu = await getMenu(app, deviceKey, date, "lunch");
      expect(JSON.parse(afterMenu.body)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  // ── plan-management read includes an INACTIVE plan's entries ────────────

  it("GET /api/meal-plans/:id/entries returns entries even for an INACTIVE plan", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const planRes = await createMealPlan(app, deviceKey, { name: "Semana de verano" });
      const plan = JSON.parse(planRes.body);

      await createEntry(app, deviceKey, {
        kind: "recurring",
        mealPlanId: plan.id,
        weekday: "wed",
        slot: "dinner",
        note: "Gazpacho",
      });

      await editMealPlan(app, deviceKey, plan.id, { active: false });

      const res = await listPlanEntries(app, deviceKey, plan.id);
      expect(res.statusCode).toBe(200);
      const entries = JSON.parse(res.body);
      expect(entries).toHaveLength(1);
      expect(entries[0].mealPlanId).toBe(plan.id);
    } finally {
      await app.close();
    }
  });

  it("GET /api/meal-plans/:id/entries against an unknown plan id -> 404", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await listPlanEntries(app, deviceKey, "does-not-exist");
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
