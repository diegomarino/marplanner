import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** — US1 tombstone rendering boundary tests (RED first).
 * BLACK-BOX: buildApp + Fastify.inject only, per the meals-menu /
 * meals-cascade suite convention (useIsolatedDb + raw SQL seed helpers).
 * The dangling `meal_entries.recipe_id` reference this covers is ONLY
 * reachable via a FK-disabled raw seed: the create/delete
 * TOCTOU is unreachable over HTTP because better-sqlite3 is synchronous, so
 * a `Promise.all([create, delete])` race would be vacuous — it is
 * deliberately NOT written here. Instead: seed the entry, then
 * `PRAGMA foreign_keys = OFF` (outside any transaction — the PRAGMA is a
 * no-op inside one), raw-DELETE the recipe row (with FK enforcement
 * off, `ON DELETE CASCADE` does not fire and the dangling ref survives),
 * then restore `PRAGMA foreign_keys = ON` before continuing. Covers
 * INV-09/FR-006/FR-007: GET /api/menu must render the item with
 * `isTombstone: true`, never a read error or a silent drop. already
 * landed the tombstone branch of `getMenu` in main, so some of this
 * coverage may already be green — see the body for the honest RED
 * story.
 */
describe("meals-tombstone boundary tests (T008/T009)", () => {
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

  function getMenu(app: FastifyInstance, deviceKey: string, date: string, slot?: string) {
    const url = slot ? `/api/menu?date=${date}&slot=${slot}` : `/api/menu?date=${date}`;
    return app.inject({ method: "GET", url, cookies: { mp_device_key: deviceKey } });
  }

  /** Detach `recipeId` from FK enforcement, delete it via raw SQL so the
   * `meal_entries` row referencing it survives as a dangling ref, then
   * restore enforcement. MUST run outside a transaction (`PRAGMA
   * foreign_keys` is a no-op inside one).
   */
  function rawDeleteRecipeWithFkDisabled(recipeId: string) {
    const db = getDb();
    db.pragma("foreign_keys = OFF");
    try {
      db.prepare("DELETE FROM recipes WHERE id = ?").run(recipeId);
    } finally {
      db.pragma("foreign_keys = ON");
    }
  }

  // ── dangling-ref rendering (INV-09, FR-006/007) ─────────────────────────

  it("GET /api/menu renders a dangling recipe_id as isTombstone:true, never a read error (INV-09)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const recipe = await createRecipe(app, deviceKey, "Lentejas");
      const date = "2026-10-15";
      const entryRes = await createOneOffEntry(app, deviceKey, date, "lunch", recipe.id);
      expect(entryRes.statusCode).toBe(201);
      const entry = JSON.parse(entryRes.body) as { id: string };

      // Sanity: FK enforcement is really back ON before the read, else this
      // test would prove nothing about the tombstone branch specifically.
      rawDeleteRecipeWithFkDisabled(recipe.id);
      const db = getDb();
      const fkStatus = db.pragma("foreign_keys", { simple: true });
      expect(fkStatus).toBe(1);
      const danglingRow = db
        .prepare("SELECT recipe_id FROM meal_entries WHERE id = ?")
        .get(entry.id) as { recipe_id: string | null };
      expect(danglingRow.recipe_id).toBe(recipe.id);

      const menuRes = await getMenu(app, deviceKey, date, "lunch");
      expect(menuRes.statusCode).toBe(200);
      const menu = JSON.parse(menuRes.body);
      expect(menu).toHaveLength(1);
      // Assert the actual placeholder label too — not just the isTombstone
      // marker — so a regression that leaked the deleted recipe's name (or
      // emitted an empty label) would fail here. Client-side localization
      // of this placeholder is tracked separately; this regression-
      // locks the current backend literal, verbatim.
      expect(menu[0]).toMatchObject({
        entryId: entry.id,
        isTombstone: true,
        label: "Deleted recipe",
      });
    } finally {
      await app.close();
    }
  });

  it("a tombstoned item never silently drops out of the menu union (no slot filter)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const recipe = await createRecipe(app, deviceKey, "Arroz");
      const date = "2026-10-16";
      const entryRes = await createOneOffEntry(app, deviceKey, date, "dinner", recipe.id);
      const entry = JSON.parse(entryRes.body) as { id: string };

      rawDeleteRecipeWithFkDisabled(recipe.id);

      const menuRes = await getMenu(app, deviceKey, date);
      expect(menuRes.statusCode).toBe(200);
      const menu = JSON.parse(menuRes.body);
      expect(menu).toHaveLength(1);
      expect(menu[0].entryId).toBe(entry.id);
      expect(menu[0].isTombstone).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("a tombstoned entry sits alongside a live one — the tombstone never breaks the rest of the read", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const doomed = await createRecipe(app, deviceKey, "Pasta");
      const alive = await createRecipe(app, deviceKey, "Sopa");
      const date = "2026-10-17";

      const doomedEntryRes = await createOneOffEntry(app, deviceKey, date, "lunch", doomed.id);
      const aliveEntryRes = await createOneOffEntry(app, deviceKey, date, "lunch", alive.id);
      const doomedEntry = JSON.parse(doomedEntryRes.body) as { id: string };
      const aliveEntry = JSON.parse(aliveEntryRes.body) as { id: string };

      rawDeleteRecipeWithFkDisabled(doomed.id);

      const menuRes = await getMenu(app, deviceKey, date, "lunch");
      expect(menuRes.statusCode).toBe(200);
      const menu = JSON.parse(menuRes.body) as Array<{
        entryId: string;
        isTombstone: boolean;
        label: string;
      }>;
      expect(menu).toHaveLength(2);

      const doomedItem = menu.find((item) => item.entryId === doomedEntry.id);
      const aliveItem = menu.find((item) => item.entryId === aliveEntry.id);
      expect(doomedItem?.isTombstone).toBe(true);
      expect(aliveItem?.isTombstone).toBe(false);
      expect(aliveItem?.label).toBe("Sopa");
    } finally {
      await app.close();
    }
  });

  it("a note-only entry (no recipe_id at all) is never mistaken for a tombstone", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const date = "2026-10-18";
      const entryRes = await app.inject({
        method: "POST",
        url: "/api/meal-entries",
        cookies: { mp_device_key: deviceKey },
        payload: { kind: "oneoff", date, slot: "snack", note: "manzana" },
      });
      expect(entryRes.statusCode).toBe(201);

      const menuRes = await getMenu(app, deviceKey, date, "snack");
      const menu = JSON.parse(menuRes.body);
      expect(menu).toHaveLength(1);
      expect(menu[0].isTombstone).toBe(false);
      expect(menu[0].label).toBe("manzana");
    } finally {
      await app.close();
    }
  });
});
