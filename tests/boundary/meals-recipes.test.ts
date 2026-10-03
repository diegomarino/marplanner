import { describe, it, expect } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** — US1 recipe-catalogue boundary tests (RED first).
 * BLACK-BOX: buildApp + Fastify.inject only, per the reminders-crud
 * suite convention (useIsolatedDb + raw SQL seed helpers).
 * Covers FR-001/FR-002/FR-005: recipe
 * create/edit(partial)/list/get; name blank-after-trim -> 400; name-only
 * accepted; ingredients normalized one/line + blanks dropped; instructions
 * blank -> absent; absent/empty slots => all pickers; JS-normalized
 * (NFD-diacritic-strip + lowercase substring) search; strict update-by-id
 * (write vs a deleted id -> 404, never recreates). RED until wires
 * editRecipe/listRecipes/getRecipe/searchRecipes + their routes.
 */
describe("meals-recipes boundary tests", () => {
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

  async function createRecipe(
    app: import("fastify").FastifyInstance,
    deviceKey: string,
    body: Record<string, unknown>
  ) {
    return app.inject({
      method: "POST",
      url: "/api/recipes",
      cookies: { mp_device_key: deviceKey },
      payload: body,
    });
  }

  // ── create ───────────────────────────────────────────────────────────────

  it("POST /api/recipes with name-only -> 201, ingredients/instructions/slots null", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await createRecipe(app, deviceKey, { name: "Lentejas" });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.id).toBeTypeOf("string");
      expect(body.name).toBe("Lentejas");
      expect(body.ingredients).toBeNull();
      expect(body.instructions).toBeNull();
      expect(body.slots).toBeNull();
      expect(body.createdAt).toBeTypeOf("number");
      expect(body.updatedAt).toBeTypeOf("number");
    } finally {
      await app.close();
    }
  });

  it("POST /api/recipes with a blank-after-trim name -> 400", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await createRecipe(app, deviceKey, { name: "   " });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("POST /api/recipes stores name TRIMMED, not verbatim (INV-11)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await createRecipe(app, deviceKey, { name: "  Lentejas  " });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.name).toBe("Lentejas");

      const getRes = await app.inject({
        method: "GET",
        url: `/api/recipes/${body.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(JSON.parse(getRes.body).name).toBe("Lentejas");
    } finally {
      await app.close();
    }
  });

  it("PATCH /api/recipes/:id stores an edited name TRIMMED, not verbatim (INV-11)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createRecipe(app, deviceKey, { name: "Lentejas" });
      const created = JSON.parse(createRes.body);

      const editRes = await app.inject({
        method: "PATCH",
        url: `/api/recipes/${created.id}`,
        cookies: { mp_device_key: deviceKey },
        payload: { name: "  Arroz  " },
      });
      expect(editRes.statusCode).toBe(200);
      expect(JSON.parse(editRes.body).name).toBe("Arroz");
    } finally {
      await app.close();
    }
  });

  it("POST /api/recipes normalizes ingredients one-per-line and drops blank lines", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await createRecipe(app, deviceKey, {
        name: "Lentejas",
        ingredients: ["  Lentejas  ", "", "   ", "Cebolla"],
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.ingredients).toEqual(["Lentejas", "Cebolla"]);
    } finally {
      await app.close();
    }
  });

  it("POST /api/recipes with an all-blank ingredients array -> ingredients null", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await createRecipe(app, deviceKey, {
        name: "Lentejas",
        ingredients: ["", "   "],
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.ingredients).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("POST /api/recipes splits ingredient elements with embedded newlines (create/read agree)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await createRecipe(app, deviceKey, {
        name: "Lentejas",
        ingredients: ["salt\npepper", "  ", "oil"],
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.ingredients).toEqual(["salt", "pepper", "oil"]);

      const getRes = await app.inject({
        method: "GET",
        url: `/api/recipes/${body.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(JSON.parse(getRes.body).ingredients).toEqual(body.ingredients);
    } finally {
      await app.close();
    }
  });

  it("POST /api/recipes with blank-after-trim instructions -> instructions absent (null)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await createRecipe(app, deviceKey, {
        name: "Lentejas",
        instructions: "   ",
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.instructions).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("POST /api/recipes with non-blank instructions stores it", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await createRecipe(app, deviceKey, {
        name: "Lentejas",
        instructions: "Cocinar a fuego lento",
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.instructions).toBe("Cocinar a fuego lento");
    } finally {
      await app.close();
    }
  });

  it("POST /api/recipes with absent slots -> slots null (all pickers, FR-002)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await createRecipe(app, deviceKey, { name: "Lentejas" });
      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).slots).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("POST /api/recipes with an empty slots array -> slots null (all pickers, FR-002)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await createRecipe(app, deviceKey, { name: "Lentejas", slots: [] });
      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).slots).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("POST /api/recipes with explicit slots stores the subset", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await createRecipe(app, deviceKey, {
        name: "Lentejas",
        slots: ["lunch", "dinner"],
      });
      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).slots).toEqual(["lunch", "dinner"]);
    } finally {
      await app.close();
    }
  });

  it("POST /api/recipes with an unsupported field -> 400", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await createRecipe(app, deviceKey, { name: "Lentejas", unknownField: "x" });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // ── list + get ───────────────────────────────────────────────────────────

  it("GET /api/recipes lists all created recipes", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      await createRecipe(app, deviceKey, { name: "Lentejas" });
      await createRecipe(app, deviceKey, { name: "Arroz" });

      const listRes = await app.inject({
        method: "GET",
        url: "/api/recipes",
        cookies: { mp_device_key: deviceKey },
      });
      expect(listRes.statusCode).toBe(200);
      const list = JSON.parse(listRes.body);
      expect(Array.isArray(list)).toBe(true);
      expect(list).toHaveLength(2);
      expect(list.map((r: { name: string }) => r.name).sort()).toEqual(["Arroz", "Lentejas"]);
    } finally {
      await app.close();
    }
  });

  it("GET /api/recipes returns [] when no recipes exist", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const listRes = await app.inject({
        method: "GET",
        url: "/api/recipes",
        cookies: { mp_device_key: deviceKey },
      });
      expect(listRes.statusCode).toBe(200);
      expect(JSON.parse(listRes.body)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("GET /api/recipes/:id returns the created recipe", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createRecipe(app, deviceKey, { name: "Lentejas" });
      const created = JSON.parse(createRes.body);

      const getRes = await app.inject({
        method: "GET",
        url: `/api/recipes/${created.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(getRes.statusCode).toBe(200);
      expect(JSON.parse(getRes.body)).toEqual(created);
    } finally {
      await app.close();
    }
  });

  it("GET /api/recipes/:id with an unknown id -> 404", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const getRes = await app.inject({
        method: "GET",
        url: "/api/recipes/does-not-exist",
        cookies: { mp_device_key: deviceKey },
      });
      expect(getRes.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // ── edit (partial PATCH) ────────────────────────────────────────────────

  it("PATCH /api/recipes/:id edits only the given field, leaving others untouched", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createRecipe(app, deviceKey, {
        name: "Lentejas",
        instructions: "Cocinar a fuego lento",
      });
      const created = JSON.parse(createRes.body);

      const editRes = await app.inject({
        method: "PATCH",
        url: `/api/recipes/${created.id}`,
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Lentejas con chorizo" },
      });
      expect(editRes.statusCode).toBe(200);
      const edited = JSON.parse(editRes.body);
      expect(edited.name).toBe("Lentejas con chorizo");
      expect(edited.instructions).toBe("Cocinar a fuego lento");
      expect(edited.id).toBe(created.id);
      expect(edited.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
    } finally {
      await app.close();
    }
  });

  it("PATCH /api/recipes/:id with a blank-after-trim name -> 400", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createRecipe(app, deviceKey, { name: "Lentejas" });
      const created = JSON.parse(createRes.body);

      const editRes = await app.inject({
        method: "PATCH",
        url: `/api/recipes/${created.id}`,
        cookies: { mp_device_key: deviceKey },
        payload: { name: "   " },
      });
      expect(editRes.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("PATCH /api/recipes/:id with ingredients normalizes one-per-line + drops blanks", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createRecipe(app, deviceKey, { name: "Lentejas" });
      const created = JSON.parse(createRes.body);

      const editRes = await app.inject({
        method: "PATCH",
        url: `/api/recipes/${created.id}`,
        cookies: { mp_device_key: deviceKey },
        payload: { ingredients: ["Lentejas", "", "  ", "Zanahoria"] },
      });
      expect(editRes.statusCode).toBe(200);
      expect(JSON.parse(editRes.body).ingredients).toEqual(["Lentejas", "Zanahoria"]);
    } finally {
      await app.close();
    }
  });

  it("PATCH /api/recipes/:id with an unsupported field -> 400", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createRecipe(app, deviceKey, { name: "Lentejas" });
      const created = JSON.parse(createRes.body);

      const editRes = await app.inject({
        method: "PATCH",
        url: `/api/recipes/${created.id}`,
        cookies: { mp_device_key: deviceKey },
        payload: { id: "different-id" },
      });
      expect(editRes.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("PATCH /api/recipes/:id with an empty patch body -> 400", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createRecipe(app, deviceKey, { name: "Lentejas" });
      const created = JSON.parse(createRes.body);

      const editRes = await app.inject({
        method: "PATCH",
        url: `/api/recipes/${created.id}`,
        cookies: { mp_device_key: deviceKey },
        payload: {},
      });
      expect(editRes.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // ── strict update-by-id (FR-005) ────────────────────────────────────────

  it("PATCH /api/recipes/:id against a deleted (tombstone) id -> 404, never recreates", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createRecipe(app, deviceKey, { name: "Lentejas" });
      const created = JSON.parse(createRes.body);

      // Simulate a cascade-delete via raw SQL (no delete route this module).
      getDb().prepare("DELETE FROM recipes WHERE id = ?").run(created.id);

      const editRes = await app.inject({
        method: "PATCH",
        url: `/api/recipes/${created.id}`,
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Resurrected" },
      });
      expect(editRes.statusCode).toBe(404);

      const getRes = await app.inject({
        method: "GET",
        url: `/api/recipes/${created.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(getRes.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // ── search (NFD-diacritic-strip + lowercase substring) ────

  it("GET /api/recipes?search= matches both a plain and a diacritic-marked name (JS-normalized)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const plainRes = await createRecipe(app, deviceKey, { name: "Lentejas" });
      const accentedRes = await createRecipe(app, deviceKey, { name: "Lentéjas" });
      const otherRes = await createRecipe(app, deviceKey, { name: "Arroz" });
      const plain = JSON.parse(plainRes.body);
      const accented = JSON.parse(accentedRes.body);
      JSON.parse(otherRes.body);

      const searchRes = await app.inject({
        method: "GET",
        url: "/api/recipes?search=lentejas",
        cookies: { mp_device_key: deviceKey },
      });
      expect(searchRes.statusCode).toBe(200);
      const results = JSON.parse(searchRes.body);
      const ids = results.map((r: { id: string }) => r.id).sort();
      expect(ids).toEqual([plain.id, accented.id].sort());
    } finally {
      await app.close();
    }
  });

  it("GET /api/recipes?search= preserves verbatim stored names (does not mutate on write)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createRecipe(app, deviceKey, { name: "Lentéjas" });
      const created = JSON.parse(createRes.body);
      expect(created.name).toBe("Lentéjas");

      const searchRes = await app.inject({
        method: "GET",
        url: "/api/recipes?search=LENTEJAS",
        cookies: { mp_device_key: deviceKey },
      });
      expect(searchRes.statusCode).toBe(200);
      const results = JSON.parse(searchRes.body);
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("Lentéjas");
    } finally {
      await app.close();
    }
  });

  it("GET /api/recipes?search= with no match returns []", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      await createRecipe(app, deviceKey, { name: "Lentejas" });

      const searchRes = await app.inject({
        method: "GET",
        url: "/api/recipes?search=pasta",
        cookies: { mp_device_key: deviceKey },
      });
      expect(searchRes.statusCode).toBe(200);
      expect(JSON.parse(searchRes.body)).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
