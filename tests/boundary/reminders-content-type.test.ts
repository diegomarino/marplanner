import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** Image reminders (#96): a reminder's content is either `text` or an ordered list of catalog
 * emojis (`images`) for pre-readers. Black-box over Fastify.inject for create/edit/emission, plus
 * raw inserts proving the `reminders_content_check` DB CHECK backs the service rules. */
describe("reminders content type (text | images)", () => {
  useIsolatedDb();

  const MONDAY = "2026-08-17";

  function seedKeys(): string {
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
      )
      .run(`${now}-device`, hashKey(deviceKey), now);
    return deviceKey;
  }

  function seedMember(): string {
    const id = `member-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    getDb()
      .prepare(
        "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, 'Pre-reader', 'child', 'active', ?, ?)"
      )
      .run(id, now, now);
    return id;
  }

  async function withApp(run: (app: FastifyInstance, deviceKey: string) => Promise<void>) {
    const deviceKey = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      await run(app, deviceKey);
    } finally {
      await app.close();
    }
  }

  function create(app: FastifyInstance, deviceKey: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/reminders",
      cookies: { mp_device_key: deviceKey },
      payload: {
        kind: "scheduled",
        targetingMode: "apply_to_all",
        weekdays: ["mon"],
        ...payload,
      },
    });
  }

  function patch(
    app: FastifyInstance,
    deviceKey: string,
    id: string,
    payload: Record<string, unknown>
  ) {
    return app.inject({
      method: "PATCH",
      url: `/api/reminders/${id}`,
      cookies: { mp_device_key: deviceKey },
      payload,
    });
  }

  it("creates an images reminder, defaults a text reminder, and lists both with their content", async () => {
    await withApp(async (app, deviceKey) => {
      const images = await create(app, deviceKey, {
        contentType: "images",
        emojis: ["🩰", "👟"],
      });
      expect(images.statusCode).toBe(201);
      expect(JSON.parse(images.body)).toMatchObject({
        contentType: "images",
        text: "",
        emojis: ["🩰", "👟"],
      });

      const described = await create(app, deviceKey, {
        contentType: "images",
        emojis: ["🤸"],
        text: "  Sports today  ",
      });
      expect(JSON.parse(described.body)).toMatchObject({ text: "Sports today", emojis: ["🤸"] });

      const text = await create(app, deviceKey, { text: "Saca la basura" });
      expect(text.statusCode).toBe(201);
      expect(JSON.parse(text.body)).toMatchObject({
        contentType: "text",
        text: "Saca la basura",
        emojis: null,
      });

      const list = await app.inject({
        method: "GET",
        url: "/api/reminders",
        cookies: { mp_device_key: deviceKey },
      });
      expect(
        (JSON.parse(list.body) as Array<{ contentType: string; emojis: string[] | null }>).map(
          ({ contentType, emojis }) => ({ contentType, emojis })
        )
      ).toEqual([
        { contentType: "images", emojis: ["🩰", "👟"] },
        { contentType: "images", emojis: ["🤸"] },
        { contentType: "text", emojis: null },
      ]);
    });
  });

  it("accepts images content on a calendar_gated rule", async () => {
    await withApp(async (app, deviceKey) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/reminders",
        cookies: { mp_device_key: deviceKey },
        payload: {
          kind: "calendar_gated",
          targetingMode: "apply_to_all",
          contentType: "images",
          emojis: ["🩰"],
          query: "ballet",
        },
      });
      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body)).toMatchObject({ kind: "calendar_gated", emojis: ["🩰"] });
    });
  });

  it.each([
    ["images without emojis", { contentType: "images" }],
    ["images with an empty list", { contentType: "images", emojis: [] }],
    ["an emoji the app ships no artwork for", { contentType: "images", emojis: ["🦄"] }],
    ["a non-string emoji", { contentType: "images", emojis: [42] }],
    ["more than 12 emojis", { contentType: "images", emojis: Array(13).fill("🍎") }],
    ["emojis on a text reminder", { text: "Hola", emojis: ["🍎"] }],
    ["a blank text reminder", { contentType: "text", text: "   " }],
    ["an unknown content type", { contentType: "video", text: "Hola" }],
  ])("rejects %s with 400 and persists nothing", async (_label, payload) => {
    await withApp(async (app, deviceKey) => {
      const res = await create(app, deviceKey, payload);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ error: "validation_error" });
      expect(getDb().prepare("SELECT COUNT(*) AS n FROM reminder").get()).toEqual({ n: 0 });
    });
  });

  it("keeps 12 emojis, repeats included, in the order given", async () => {
    await withApp(async (app, deviceKey) => {
      const emojis = ["🍎", "🍎", "🎒", ...Array<string>(9).fill("👟")];
      const res = await create(app, deviceKey, { contentType: "images", emojis });
      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).emojis).toEqual(emojis);
    });
  });

  it("switches content both ways on PATCH, reorders emojis, and rejects incomplete switches", async () => {
    await withApp(async (app, deviceKey) => {
      const created = JSON.parse((await create(app, deviceKey, { text: "Ballet today" })).body) as {
        id: string;
      };

      // text -> images needs emojis; nothing changes on the rejected patch.
      expect((await patch(app, deviceKey, created.id, { contentType: "images" })).statusCode).toBe(
        400
      );
      // emojis alone are not accepted on a text reminder.
      expect((await patch(app, deviceKey, created.id, { emojis: ["🩰"] })).statusCode).toBe(400);

      const toImages = await patch(app, deviceKey, created.id, {
        contentType: "images",
        emojis: ["🩰", "🎒"],
      });
      expect(toImages.statusCode).toBe(200);
      expect(JSON.parse(toImages.body)).toMatchObject({
        contentType: "images",
        text: "Ballet today",
        emojis: ["🩰", "🎒"],
      });

      const reordered = await patch(app, deviceKey, created.id, { emojis: ["🎒", "🩰"] });
      expect(JSON.parse(reordered.body).emojis).toEqual(["🎒", "🩰"]);

      // an images reminder may drop its description.
      const blank = await patch(app, deviceKey, created.id, { text: "" });
      expect(JSON.parse(blank.body)).toMatchObject({ text: "", emojis: ["🎒", "🩰"] });

      // images -> text with no non-blank text (given or stored) is rejected.
      expect((await patch(app, deviceKey, created.id, { contentType: "text" })).statusCode).toBe(
        400
      );
      const toText = await patch(app, deviceKey, created.id, {
        contentType: "text",
        text: "Ballet",
      });
      expect(toText.statusCode).toBe(200);
      expect(JSON.parse(toText.body)).toMatchObject({
        contentType: "text",
        text: "Ballet",
        emojis: null,
      });
    });
  });

  it("emits an images reminder with its emojis next to text reminders, which keep their shape", async () => {
    await withApp(async (app, deviceKey) => {
      const memberId = seedMember();
      const text = JSON.parse((await create(app, deviceKey, { text: "Mochila" })).body) as {
        id: string;
      };
      const images = JSON.parse(
        (await create(app, deviceKey, { contentType: "images", emojis: ["🤸", "👟"] })).body
      ) as { id: string };

      const res = await app.inject({
        method: "GET",
        url: `/api/reminders/emissions?memberId=${memberId}&date=${MONDAY}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual([
        { id: text.id, text: "Mochila" },
        { id: images.id, text: "", emojis: ["🤸", "👟"] },
      ]);
    });
  });

  describe("reminders_content_check (DB CHECK)", () => {
    function insert(contentType: string, text: string, emojis: string | null) {
      const now = Date.now();
      getDb()
        .prepare(
          "INSERT INTO reminder (id, kind, targeting_mode, content_type, text, emojis, weekdays, active, created_at, updated_at) VALUES (?, 'scheduled', 'apply_to_all', ?, ?, ?, '[\"mon\"]', 1, ?, ?)"
        )
        .run(`r-${Math.random()}`, contentType, text, emojis, now, now);
    }

    it("accepts the two valid shapes", () => {
      expect(() => insert("text", "Hola", null)).not.toThrow();
      expect(() => insert("images", "", '["🩰"]')).not.toThrow();
    });

    it.each([
      ["text with a blank text", "text", "  ", null],
      ["text with emojis", "text", "Hola", '["🩰"]'],
      ["images without emojis", "images", "", null],
      ["images with an empty list", "images", "", "[]"],
      ["an unknown content type", "video", "Hola", null],
    ])("rejects %s", (_label, contentType, text, emojis) => {
      expect(() => insert(contentType, text, emojis)).toThrow(/CHECK constraint failed/);
    });
  });
});
