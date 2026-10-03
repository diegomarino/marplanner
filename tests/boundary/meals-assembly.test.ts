import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useIsolatedDb } from "../helpers/db";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import type { FastifyInstance } from "fastify";
import type { Recipe, MealEntry, MenuItem } from "../../src/shared";

/** Meals & Recipes assembly smoke (— ADR-059 / Constitution XIII).
 * REAL-PROCESS proof, not `app.inject`: boots the app with a real listening
 * socket (`app.listen({ port: 0 })`) and drives Quickstart Scenario A over
 * actual HTTP against that port, with the device-key cookie set the same way
 * a real client would send it.
 * RED until: /api/recipes, /api/meal-entries, /api/menu don't exist yet.
 */
describe("meals-assembly (real-process smoke, Scenario A)", () => {
  useIsolatedDb();

  let app: FastifyInstance;
  let baseUrl: string;
  let deviceKey: string;

  beforeEach(async () => {
    deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deviceHash = hashKey(deviceKey);
    const now = Date.now();
    const db = getDb();

    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${now}-device`, deviceHash, now);

    const { buildApp } = await import("../../src/server/app.ts");
    app = await buildApp();
    await app.listen({ port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a real TCP address from app.listen({ port: 0 })");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await app.close();
  });

  it("Scenario A: create a recipe, add a one-off entry, read the derived menu over real HTTP", async () => {
    const cookieHeader = `mp_device_key=${deviceKey}`;
    const recipeName = `Lentejas-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // 1. POST /api/recipes {name} -> 201
    const createRecipeRes = await fetch(`${baseUrl}/api/recipes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
      body: JSON.stringify({ name: recipeName }),
    });
    expect(createRecipeRes.status).toBe(201);
    const recipe = (await createRecipeRes.json()) as Recipe;
    expect(recipe.id).toBeTypeOf("string");
    expect(recipe.name).toBe(recipeName);

    // 2. POST /api/meal-entries {kind:"oneoff", date, slot:"lunch", recipeId} -> 201
    const entryDate = "2026-08-17";
    const otherDate = "2026-08-18";
    const createEntryRes = await fetch(`${baseUrl}/api/meal-entries`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
      body: JSON.stringify({
        kind: "oneoff",
        date: entryDate,
        slot: "lunch",
        recipeId: recipe.id,
      }),
    });
    expect(createEntryRes.status).toBe(201);
    const entry = (await createEntryRes.json()) as MealEntry;
    expect(entry.id).toBeTypeOf("string");
    expect(entry.kind).toBe("oneoff");
    expect(entry.date).toBe(entryDate);
    expect(entry.slot).toBe("lunch");
    expect(entry.recipeId).toBe(recipe.id);

    // 3. GET /api/menu?date=<entryDate>&slot=lunch -> 200, contains the entry's item
    const menuRes = await fetch(`${baseUrl}/api/menu?date=${entryDate}&slot=lunch`, {
      headers: { Cookie: cookieHeader },
    });
    expect(menuRes.status).toBe(200);
    const menu = (await menuRes.json()) as MenuItem[];
    expect(menu).toEqual([
      {
        entryId: entry.id,
        slot: "lunch",
        label: recipeName,
        recipeId: recipe.id,
        note: null,
        isTombstone: false,
        source: "oneoff",
      },
    ]);

    // 4. GET /api/menu?date=<otherDate>&slot=lunch -> 200, empty (absence)
    const otherMenuRes = await fetch(`${baseUrl}/api/menu?date=${otherDate}&slot=lunch`, {
      headers: { Cookie: cookieHeader },
    });
    expect(otherMenuRes.status).toBe(200);
    const otherMenu = (await otherMenuRes.json()) as MenuItem[];
    expect(otherMenu).toEqual([]);
  });

  it("a note-content one-off entry stores and returns the note byte-for-byte verbatim (MEALS-RECIPES-INV-13)", async () => {
    const cookieHeader = `mp_device_key=${deviceKey}`;
    const entryDate = "2026-08-19";
    const verbatimNote = "  - indented markdown line  ";

    const createEntryRes = await fetch(`${baseUrl}/api/meal-entries`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
      body: JSON.stringify({
        kind: "oneoff",
        date: entryDate,
        slot: "dinner",
        note: verbatimNote,
      }),
    });
    expect(createEntryRes.status).toBe(201);
    const entry = (await createEntryRes.json()) as MealEntry;
    expect(entry.note).toBe(verbatimNote);

    const menuRes = await fetch(`${baseUrl}/api/menu?date=${entryDate}&slot=dinner`, {
      headers: { Cookie: cookieHeader },
    });
    expect(menuRes.status).toBe(200);
    const menu = (await menuRes.json()) as MenuItem[];
    expect(menu).toEqual([
      {
        entryId: entry.id,
        slot: "dinner",
        label: verbatimNote,
        recipeId: null,
        note: verbatimNote,
        isTombstone: false,
        source: "oneoff",
      },
    ]);
  });
});
