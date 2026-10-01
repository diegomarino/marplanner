import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server/app";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { listActiveChildren } from "../../src/server/modules/members/referential";
import { useIsolatedDb } from "../helpers/db";

const PALETTE = [
  "blue",
  "sky",
  "cyan",
  "teal",
  "green",
  "lime",
  "yellow",
  "amber",
  "orange",
  "red",
  "rose",
  "pink",
  "fuchsia",
  "purple",
  "violet",
  "indigo",
];
const cookies = { mp_device_key: "mpk-member-color-test" };

describe("member colour public boundary (slice 021 T002)", () => {
  useIsolatedDb();
  let app: FastifyInstance;

  beforeEach(async () => {
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES ('color-device', ?, '*', 'device', 1)"
      )
      .run(hashKey(cookies.mp_device_key));
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  async function create(colorKey?: unknown) {
    return app.inject({
      method: "POST",
      url: "/api/members",
      cookies,
      payload: {
        displayName: "Member",
        role: "child",
        ...(colorKey === undefined ? {} : { colorKey }),
      },
    });
  }

  it("assigns all sixteen unused keys in order, then cycles by active count", async () => {
    const actual = [];
    for (let i = 0; i < 18; i++) {
      const response = await create();
      expect(response.statusCode).toBe(201);
      actual.push(response.json().colorKey);
    }
    expect(actual).toEqual([...PALETTE, "blue", "sky"]);
    const listed = await app.inject({ method: "GET", url: "/api/members", cookies });
    expect(listed.json().map((m: { colorKey: string }) => m.colorKey)).toEqual(actual);
    expect(listActiveChildren().map((m) => m.colorKey)).toEqual(actual);
  });

  it("accepts every explicit curated key, including reuse before exhaustion", async () => {
    for (const colorKey of [...PALETTE, "blue"]) {
      const response = await create(colorKey);
      expect(response.statusCode).toBe(201);
      expect(response.json().colorKey).toBe(colorKey);
    }
  });

  it.each(["#ff0000", "oklch(50% 0.2 40)", "BLUE", "", " blue ", null, 5])(
    "rejects invalid create and patch key %j without writing",
    async (colorKey) => {
      const original = (await create()).json();
      expect((await create(colorKey)).statusCode).toBe(400);
      const response = await app.inject({
        method: "PATCH",
        url: `/api/members/${original.id}`,
        cookies,
        payload: { displayName: "Must not persist", colorKey },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("validation_error");
      const listed = await app.inject({ method: "GET", url: "/api/members", cookies });
      expect(listed.json()).toEqual([original]);
    }
  );

  it("preserves colour on archive, restore, no-ops and unrelated edits; archived keys are reusable", async () => {
    const original = (await create()).json();
    for (let i = 0; i < 2; i++) {
      const archived = await app.inject({
        method: "POST",
        url: `/api/members/${original.id}/archive`,
        cookies,
      });
      expect(archived.json()).toMatchObject({ colorKey: "blue", lifecycle: "archived" });
    }
    const archivedList = await app.inject({
      method: "GET",
      url: "/api/members?lifecycle=archived",
      cookies,
    });
    expect(archivedList.json()).toEqual([
      expect.objectContaining({ id: original.id, colorKey: "blue" }),
    ]);
    expect((await create()).json().colorKey).toBe("blue");
    for (let i = 0; i < 2; i++) {
      const restored = await app.inject({
        method: "POST",
        url: `/api/members/${original.id}/restore`,
        cookies,
      });
      expect(restored.json()).toMatchObject({ colorKey: "blue", lifecycle: "active" });
    }
    const edited = await app.inject({
      method: "PATCH",
      url: `/api/members/${original.id}`,
      cookies,
      payload: { colorKey: "indigo" },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().colorKey).toBe("indigo");
    for (const payload of [
      { displayName: "Renamed" },
      { birthDate: { month: 2, day: 29, year: null } },
      { birthDate: null },
    ]) {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/members/${original.id}`,
        cookies,
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().colorKey).toBe("indigo");
    }
    expect((await create()).json().colorKey).toBe("sky");
    const all = await app.inject({ method: "GET", url: "/api/members?lifecycle=all", cookies });
    expect(all.json()).toContainEqual(
      expect.objectContaining({ id: original.id, colorKey: "indigo" })
    );
  });

  it("keeps database keys required and closed while supporting omitted raw-SQL inserts", async () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO members (id, display_name, role, created_at, updated_at) VALUES ('10000000-0000-4000-8000-000000000001', 'Legacy', 'parent', 1, 1)"
    ).run();
    const listed = await app.inject({ method: "GET", url: "/api/members", cookies });
    expect(listed.json()).toEqual([
      expect.objectContaining({ id: "10000000-0000-4000-8000-000000000001", colorKey: "blue" }),
    ]);
    for (const key of [null, "#ff0000", "not-a-key"]) {
      expect(() =>
        db
          .prepare(
            "UPDATE members SET color_key = ? WHERE id = '10000000-0000-4000-8000-000000000001'"
          )
          .run(key)
      ).toThrow();
    }
    expect(
      db
        .prepare("SELECT color_key FROM members WHERE id = '10000000-0000-4000-8000-000000000001'")
        .get()
    ).toEqual({
      color_key: "blue",
    });
  });
});
