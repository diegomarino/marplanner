import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** — US1 informed-cascade recipe delete boundary tests (RED first).
 * BLACK-BOX: buildApp + Fastify.inject only, per the meals-menu /
 * meals-entries suite convention (useIsolatedDb + raw SQL seed helpers).
 * There is no meal-plans route yet so a recurring entry is seeded
 * directly via raw SQL, matching the meals-menu.test.ts precedent.
 * Covers AC-06 (split dependent counts, advisory pre-delete), INV-08 (the
 * cascade delete removes the recipe + every referencing entry atomically,
 * an emptied meal_plan survives — deactivate-only, never hard-deleted), and
 * INV-10 (strict update-by-id: a write against a deleted recipe id -> 404,
 * never recreates). already landed `deleteRecipe`/`getRecipeDependents`
 * in main, so some of this coverage may already be green — see the body
 * for the honest RED story.
 */
describe("meals-cascade boundary tests", () => {
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

  function createOneOffEntry(
    app: FastifyInstance,
    deviceKey: string,
    date: string,
    slot: string,
    recipeId: string
  ) {
    return app.inject({
      method: "POST",
      url: "/api/meal-entries",
      cookies: { mp_device_key: deviceKey },
      payload: { kind: "oneoff", date, slot, recipeId },
    });
  }

  /** Seed an active meal_plan + a recurring meal_entry referencing `recipeId` (no route yet —). */
  function seedRecurringEntry(recipeId: string, weekday: string, slot: string) {
    const db = getDb();
    const planId = `plan-${randomUUID()}`;
    const entryId = `entry-${randomUUID()}`;
    const now = Date.now();
    db.prepare(
      "INSERT INTO meal_plans (id, name, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)"
    ).run(planId, `Plan ${planId}`, now, now);
    db.prepare(
      "INSERT INTO meal_entries (id, meal_plan_id, weekday, entry_date, slot, recipe_id, note, created_at) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?)"
    ).run(entryId, planId, weekday, slot, recipeId, now);
    return { planId, entryId };
  }

  function getMenu(app: FastifyInstance, deviceKey: string, date: string, slot?: string) {
    const url = slot ? `/api/menu?date=${date}&slot=${slot}` : `/api/menu?date=${date}`;
    return app.inject({ method: "GET", url, cookies: { mp_device_key: deviceKey } });
  }

  function getDependents(app: FastifyInstance, deviceKey: string, recipeId: string) {
    return app.inject({
      method: "GET",
      url: `/api/recipes/${recipeId}/dependents`,
      cookies: { mp_device_key: deviceKey },
    });
  }

  function deleteRecipe(app: FastifyInstance, deviceKey: string, recipeId: string) {
    return app.inject({
      method: "DELETE",
      url: `/api/recipes/${recipeId}`,
      cookies: { mp_device_key: deviceKey },
    });
  }

  // ── split dependent counts BEFORE delete (AC-06) ────────────────────────

  it("GET /api/recipes/:id/dependents reports split recurring/one-off counts before delete (AC-06)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const recipe = await createRecipe(app, deviceKey, "Lentejas");

      const oneOffA = await createOneOffEntry(app, deviceKey, "2026-10-01", "lunch", recipe.id);
      const oneOffB = await createOneOffEntry(app, deviceKey, "2026-10-02", "dinner", recipe.id);
      expect(oneOffA.statusCode).toBe(201);
      expect(oneOffB.statusCode).toBe(201);
      seedRecurringEntry(recipe.id, "mon", "breakfast");

      const depRes = await getDependents(app, deviceKey, recipe.id);
      expect(depRes.statusCode).toBe(200);
      const counts = JSON.parse(depRes.body);
      expect(counts).toEqual({ recurringCount: 1, oneOffCount: 2 });

      // The dependents read is advisory — it must not itself delete anything,
      // neither the recipe NOR the entries it counted.
      const stillThereRes = await app.inject({
        method: "GET",
        url: `/api/recipes/${recipe.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(stillThereRes.statusCode).toBe(200);

      const menuA = await getMenu(app, deviceKey, "2026-10-01", "lunch");
      const menuB = await getMenu(app, deviceKey, "2026-10-02", "dinner");
      expect(JSON.parse(menuA.body)).toHaveLength(1);
      expect(JSON.parse(menuB.body)).toHaveLength(1);
      const db = getDb();
      const recurringStillThere = db
        .prepare(
          "SELECT COUNT(*) AS n FROM meal_entries WHERE meal_plan_id IS NOT NULL AND recipe_id = ?"
        )
        .get(recipe.id) as { n: number };
      expect(recurringStillThere.n).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("GET /api/recipes/:id/dependents against an unknown recipe id -> 404", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const depRes = await getDependents(app, deviceKey, "does-not-exist");
      expect(depRes.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // ── atomic cascade (INV-08) ──────────────────────────────────────────────

  it("DELETE /api/recipes/:id atomically removes the recipe + every referencing entry (recurring + one-off, INV-08), and ONLY those (scoped, not a blanket delete)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const recipe = await createRecipe(app, deviceKey, "Arroz");

      const oneOffRes = await createOneOffEntry(app, deviceKey, "2026-10-05", "lunch", recipe.id);
      const oneOffEntry = JSON.parse(oneOffRes.body) as { id: string };
      const { entryId: recurringEntryId } = seedRecurringEntry(recipe.id, "tue", "dinner");

      // An UNRELATED recipe + entry, referencing neither the deleted recipe
      // nor any of its entries. If deleteRecipe ever regressed into a
      // blanket `DELETE FROM meal_entries` this fixture is what would catch
      // it — the scoped-cascade test above (with only referencing entries
      // in the fixture) would pass even under that regression.
      const unrelatedRecipe = await createRecipe(app, deviceKey, "Ensalada");
      const unrelatedRes = await createOneOffEntry(
        app,
        deviceKey,
        "2026-10-05",
        "breakfast",
        unrelatedRecipe.id
      );
      const unrelatedEntry = JSON.parse(unrelatedRes.body) as { id: string };

      const delRes = await deleteRecipe(app, deviceKey, recipe.id);
      expect(delRes.statusCode).toBe(204);

      // Recipe itself is gone.
      const getRes = await app.inject({
        method: "GET",
        url: `/api/recipes/${recipe.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(getRes.statusCode).toBe(404);

      // Every referencing entry — recurring AND one-off — is gone too, in the
      // same atomic operation (no route lists entries directly, so verify
      // via the underlying row count).
      const db = getDb();
      const remaining = db
        .prepare("SELECT COUNT(*) AS n FROM meal_entries WHERE id IN (?, ?)")
        .get(oneOffEntry.id, recurringEntryId) as { n: number };
      expect(remaining.n).toBe(0);

      // The unrelated recipe and its entry are untouched — the cascade is
      // scoped to the deleted recipe, not a blanket delete.
      const unrelatedRecipeRes = await app.inject({
        method: "GET",
        url: `/api/recipes/${unrelatedRecipe.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(unrelatedRecipeRes.statusCode).toBe(200);
      const unrelatedStillThere = db
        .prepare("SELECT COUNT(*) AS n FROM meal_entries WHERE id = ?")
        .get(unrelatedEntry.id) as { n: number };
      expect(unrelatedStillThere.n).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("an emptied meal_plan SURVIVES the cascade delete — plans are deactivate-only, never hard-deleted", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const recipe = await createRecipe(app, deviceKey, "Pasta");
      const { planId } = seedRecurringEntry(recipe.id, "wed", "snack");

      const delRes = await deleteRecipe(app, deviceKey, recipe.id);
      expect(delRes.statusCode).toBe(204);

      const db = getDb();
      const planRow = db.prepare("SELECT id, active FROM meal_plans WHERE id = ?").get(planId) as
        { id: string; active: number } | undefined;
      expect(planRow).toBeDefined();
      expect(planRow?.active).toBe(1);
    } finally {
      await app.close();
    }
  });

  // ── strict update-by-id after cascade (INV-10) ──────────────────────────

  it("a write against the deleted recipe id -> 404, no recreate (INV-10)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const recipe = await createRecipe(app, deviceKey, "Sopa");
      const delRes = await deleteRecipe(app, deviceKey, recipe.id);
      expect(delRes.statusCode).toBe(204);

      // A new one-off entry referencing the deleted recipe -> domain 404,
      // never a raw FK-constraint error, and it must not recreate the recipe.
      const createRes = await createOneOffEntry(app, deviceKey, "2026-10-10", "lunch", recipe.id);
      expect(createRes.statusCode).toBe(404);

      const getRes = await app.inject({
        method: "GET",
        url: `/api/recipes/${recipe.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(getRes.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("a double-delete of the same recipe id -> 404, not a silent no-op 204 (idempotent-by-id, no LWW here)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const recipe = await createRecipe(app, deviceKey, "Gazpacho");
      const first = await deleteRecipe(app, deviceKey, recipe.id);
      expect(first.statusCode).toBe(204);

      const second = await deleteRecipe(app, deviceKey, recipe.id);
      expect(second.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
