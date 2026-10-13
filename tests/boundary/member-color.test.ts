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
  "teal",
  "green",
  "lime",
  "amber",
  "orange",
  "red",
  "pink",
  "violet",
];
const cookies = { mp_device_key: "mpk-member-color-test" };

describe("member colour public boundary", () => {
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

  it("assigns all ten unused keys in order, then cycles by active count", async () => {
    const actual = [];
    for (let i = 0; i < PALETTE.length + 2; i++) {
      const response = await create();
      expect(response.statusCode).toBe(201);
      actual.push(response.json().colorKey);
    }
    expect(actual).toEqual([...PALETTE, "blue", "sky"]);
    const listed = await app.inject({ method: "GET", url: "/api/members", cookies });
    expect(listed.json().map((m: { colorKey: string }) => m.colorKey)).toEqual(actual);
    expect(listActiveChildren().map((m) => m.colorKey)).toEqual(actual);
  });

  it("accepts every explicit curated key once, and a repeat only after all are held", async () => {
    for (const colorKey of PALETTE) {
      const response = await create(colorKey);
      expect(response.statusCode).toBe(201);
      expect(response.json().colorKey).toBe(colorKey);
    }
    // Every colour is held now, so a repeat is the only option left.
    const eleventh = await create("blue");
    expect(eleventh.statusCode).toBe(201);
    expect(eleventh.json().colorKey).toBe("blue");
  });

  it("refuses an explicit colour another active member holds while a free one remains", async () => {
    const first = (await create("blue")).json();
    const second = (await create("sky")).json();

    const duplicate = await create("blue");
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json()).toMatchObject({ error: "validation_error" });

    const stolen = await app.inject({
      method: "PATCH",
      url: `/api/members/${second.id}`,
      cookies,
      payload: { displayName: "Must not persist", colorKey: "blue" },
    });
    expect(stolen.statusCode).toBe(400);

    // Sending one's own colour back is not a conflict.
    const unchanged = await app.inject({
      method: "PATCH",
      url: `/api/members/${first.id}`,
      cookies,
      payload: { displayName: "Renamed", colorKey: "blue" },
    });
    expect(unchanged.statusCode).toBe(200);

    const listed = await app.inject({ method: "GET", url: "/api/members", cookies });
    expect(
      listed
        .json()
        .map((m: { displayName: string; colorKey: string }) => [m.displayName, m.colorKey])
    ).toEqual([
      ["Renamed", "blue"],
      ["Member", "sky"],
    ]);
  });

  it("frees an archived member's colour for others to take", async () => {
    const first = (await create("blue")).json();
    await app.inject({ method: "POST", url: `/api/members/${first.id}/archive`, cookies });

    expect((await create("blue")).statusCode).toBe(201);
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

  it("preserves colour on archive, no-ops and unrelated edits; a restore keeps it only while it is free", async () => {
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
      // Blue went to the member created while this one was archived, so the restored member
      // takes the first free colour; restoring again changes nothing.
      expect(restored.json()).toMatchObject({ colorKey: "sky", lifecycle: "active" });
    }
    const edited = await app.inject({
      method: "PATCH",
      url: `/api/members/${original.id}`,
      cookies,
      payload: { colorKey: "violet" },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().colorKey).toBe("violet");
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
      expect(response.json().colorKey).toBe("violet");
    }
    expect((await create()).json().colorKey).toBe("sky");
    const all = await app.inject({ method: "GET", url: "/api/members?lifecycle=all", cookies });
    expect(all.json()).toContainEqual(
      expect.objectContaining({ id: original.id, colorKey: "violet" })
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
