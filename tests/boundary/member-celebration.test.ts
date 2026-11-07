/** Member completion celebration (#92): the `celebration` member field over HTTP, the household
 * `celebration` settings object, and the 0002 migration's columns, defaults and CHECKs.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { writeSettingsObject } from "../../src/server/modules/settings";
import { execBaseline } from "../helpers/baseline";
import { useIsolatedDb } from "../helpers/db";

const MIGRATION = "drizzle/0002_member_celebration.sql";

function seedDeviceKey(): string {
  const key = `mpk-${randomUUID()}`;
  getDb()
    .prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    )
    .run(randomUUID(), hashKey(key), Date.now());
  return key;
}

describe("member celebration over HTTP", () => {
  useIsolatedDb();
  let app: FastifyInstance;
  let key: string;

  beforeEach(async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    key = seedDeviceKey();
    app = await buildApp();
  });
  afterEach(async () => {
    await app.close();
  });

  const send = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      cookies: { mp_device_key: key },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  async function createChild(extra: Record<string, unknown> = {}) {
    const res = await send("POST", "/api/members", {
      displayName: `Kid ${randomUUID().slice(0, 4)}`,
      role: "child",
      ...extra,
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body) as { id: string; celebration: unknown };
  }

  it("stores confetti when create omits the celebration", async () => {
    const member = await createChild();
    expect(member.celebration).toEqual({ preset: "confetti" });
    const listed = JSON.parse((await send("GET", "/api/members")).body) as {
      id: string;
      celebration: unknown;
    }[];
    expect(listed.find((m) => m.id === member.id)?.celebration).toEqual({ preset: "confetti" });
  });

  it("stores an explicit preset or custom set on create", async () => {
    expect((await createChild({ celebration: { preset: "soccer" } })).celebration).toEqual({
      preset: "soccer",
    });
    expect(
      (await createChild({ celebration: { preset: "custom", emojis: [" 🦄", "🏰"] } })).celebration
    ).toEqual({ preset: "custom", emojis: ["🦄", "🏰"] });
  });

  it.each(["confetti", "stars", "videogames", "soccer", "fairytale"])(
    "PATCH sets the %s preset",
    async (preset) => {
      const member = await createChild();
      const res = await send("PATCH", `/api/members/${member.id}`, { celebration: { preset } });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).celebration).toEqual({ preset });
    }
  );

  it("PATCH replaces a custom set with a preset, clearing its emojis", async () => {
    const member = await createChild({ celebration: { preset: "custom", emojis: ["⚽"] } });
    await send("PATCH", `/api/members/${member.id}`, { celebration: { preset: "stars" } });
    const row = getDb()
      .prepare("SELECT celebration_preset, celebration_emojis FROM members WHERE id = ?")
      .get(member.id);
    expect(row).toEqual({ celebration_preset: "stars", celebration_emojis: null });
  });

  it("PATCH without the field keeps the celebration, and archive and restore keep it", async () => {
    const custom = { preset: "custom", emojis: ["👾", "🕹️", "🎮"] };
    const member = await createChild({ celebration: custom });
    const renamed = await send("PATCH", `/api/members/${member.id}`, { displayName: "Renamed" });
    expect(JSON.parse(renamed.body).celebration).toEqual(custom);
    const archived = await send("POST", `/api/members/${member.id}/archive`);
    expect(JSON.parse(archived.body).celebration).toEqual(custom);
    const restored = await send("POST", `/api/members/${member.id}/restore`);
    expect(JSON.parse(restored.body).celebration).toEqual(custom);
  });

  it.each([
    ["an unknown preset", { preset: "dragons" }],
    ["custom without emojis", { preset: "custom" }],
    ["custom with an empty list", { preset: "custom", emojis: [] }],
    ["emojis on a non-custom preset", { preset: "stars", emojis: ["⭐"] }],
    [
      "more than six emojis",
      { preset: "custom", emojis: ["⭐", "🌟", "✨", "💫", "👑", "🏰", "🦄"] },
    ],
    ["a repeated emoji", { preset: "custom", emojis: ["⭐", "⭐"] }],
    ["a non-emoji string", { preset: "custom", emojis: ["ok"] }],
    ["two emojis in one item", { preset: "custom", emojis: ["⭐🌟"] }],
    ["a non-string item", { preset: "custom", emojis: [1] }],
    ["an unknown field", { preset: "stars", colour: "red" }],
    ["a non-object", "stars"],
  ])("rejects %s with 400 on create and on PATCH", async (_label, celebration) => {
    const created = await send("POST", "/api/members", {
      displayName: "Kid",
      role: "child",
      celebration,
    });
    expect(created.statusCode).toBe(400);
    expect(JSON.parse(created.body).error).toBe("validation_error");

    const member = await createChild();
    const patched = await send("PATCH", `/api/members/${member.id}`, { celebration });
    expect(patched.statusCode).toBe(400);
    const after = JSON.parse((await send("GET", "/api/members")).body) as {
      id: string;
      celebration: unknown;
    }[];
    expect(after.find((m) => m.id === member.id)?.celebration).toEqual({ preset: "confetti" });
  });

  it("reads a stored value the shared rule no longer accepts as the default", async () => {
    const member = await createChild();
    getDb()
      .prepare(
        "UPDATE members SET celebration_preset = 'custom', celebration_emojis = '[\"x\"]' WHERE id = ?"
      )
      .run(member.id);
    const listed = JSON.parse((await send("GET", "/api/members")).body) as {
      id: string;
      celebration: unknown;
    }[];
    expect(listed.find((m) => m.id === member.id)?.celebration).toEqual({ preset: "confetti" });
  });

  it("documents MemberCelebration on Member, CreateMemberRequest and UpdateMemberRequest", () => {
    const document = JSON.parse(readFileSync("docs/api/openapi.json", "utf8")) as {
      components: { schemas: unknown };
    };
    const schemas = document.components.schemas as Record<
      string,
      { properties?: Record<string, unknown>; required?: string[] }
    >;
    expect(schemas.MemberCelebration).toBeDefined();
    expect(schemas.Member.required).toContain("celebration");
    expect(schemas.CreateMemberRequest.properties).toHaveProperty("celebration");
    expect(schemas.UpdateMemberRequest.properties).toHaveProperty("celebration");
  });

  it("exposes the household sound switch, on by default, and writes it through PUT", async () => {
    expect(JSON.parse((await send("GET", "/api/settings")).body).celebration).toEqual({
      sound: true,
    });
    const put = await send("PUT", "/api/settings", {
      object: "celebration",
      settings: { sound: false },
    });
    expect(put.statusCode).toBe(200);
    expect(JSON.parse(put.body).celebration).toEqual({ sound: false });
    expect(JSON.parse((await send("GET", "/api/settings")).body).celebration).toEqual({
      sound: false,
    });
  });

  it("refuses a non-object sound setting at the settings seam", () => {
    expect(() => writeSettingsObject("celebration", null)).toThrow("invalid_settings");
    expect(() => writeSettingsObject("celebration", [true])).toThrow("invalid_settings");
  });

  it("reads a stored sound setting that no longer validates as the default", async () => {
    getDb()
      .prepare(
        "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('celebration', ?, 0)"
      )
      .run(JSON.stringify({ sound: "loud" }));
    expect(JSON.parse((await send("GET", "/api/settings")).body).celebration).toEqual({
      sound: true,
    });
  });

  it.each([{ sound: "yes" }, {}, { sound: true, volume: 1 }])(
    "rejects the invalid sound settings %j",
    async (settings) => {
      const put = await send("PUT", "/api/settings", { object: "celebration", settings });
      expect(put.statusCode).toBe(400);
    }
  );
});

describe("0002_member_celebration migration", () => {
  function migratedWithMember(): Database.Database {
    const db = new Database(":memory:");
    execBaseline(db);
    db.prepare(
      "INSERT INTO members (id, display_name, role, created_at, updated_at) VALUES ('m1', 'Ari', 'child', 0, 0)"
    ).run();
    db.exec(readFileSync(MIGRATION, "utf8"));
    return db;
  }

  it("adds both columns and gives existing members the confetti default", () => {
    const db = migratedWithMember();
    try {
      expect(
        db.prepare("SELECT celebration_preset, celebration_emojis FROM members").get()
      ).toEqual({ celebration_preset: "confetti", celebration_emojis: null });
    } finally {
      db.close();
    }
  });

  it.each([
    ["an unknown preset", "'dragons'", "NULL"],
    ["custom without emojis", "'custom'", "NULL"],
    ["custom with an empty list", "'custom'", "'[]'"],
    ["custom with seven emojis", "'custom'", `'["1","2","3","4","5","6","7"]'`],
    ["emojis on a preset", "'stars'", `'["⭐"]'`],
  ])("refuses %s", (_label, preset, emojis) => {
    const db = migratedWithMember();
    try {
      expect(() =>
        db.exec(`UPDATE members SET celebration_preset = ${preset}, celebration_emojis = ${emojis}`)
      ).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it("accepts a custom set of one to six emojis", () => {
    const db = migratedWithMember();
    try {
      db.exec(`UPDATE members SET celebration_preset = 'custom', celebration_emojis = '["🦄"]'`);
      expect(db.prepare("SELECT celebration_emojis FROM members").get()).toEqual({
        celebration_emojis: '["🦄"]',
      });
    } finally {
      db.close();
    }
  });
});
