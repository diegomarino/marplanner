import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/server/app";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

describe("member colour current baseline", () => {
  useIsolatedDb();

  it("enforces the curated colour set, supplies the default, and exposes it through public reads", async () => {
    const db = getDb();
    const now = 1_757_000_000_000;
    db.prepare(
      "INSERT INTO members (id, display_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run("10000000-0000-4000-8000-000000000001", "Active Member", "parent", now, now);
    db.prepare(
      "INSERT INTO members (id, display_name, color_key, role, lifecycle, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "10000000-0000-4000-8000-000000000002",
      "Archived Member",
      "violet",
      "child",
      "archived",
      now + 1,
      now + 1
    );

    expect(db.prepare("SELECT id, color_key FROM members ORDER BY id").all()).toEqual([
      { id: "10000000-0000-4000-8000-000000000001", color_key: "blue" },
      { id: "10000000-0000-4000-8000-000000000002", color_key: "violet" },
    ]);
    expect(() =>
      db
        .prepare(
          "INSERT INTO members (id, display_name, color_key, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run("invalid-member", "Invalid Member", "ultraviolet", "parent", now, now)
    ).toThrow(/CHECK constraint failed/);

    const key = "mpk-current-baseline-member-colour";
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES ('device', ?, '*', 'device', ?)"
    ).run(hashKey(key), now);
    const app = await buildApp();
    try {
      const active = await app.inject({
        method: "GET",
        url: "/api/members?lifecycle=active",
        cookies: { mp_device_key: key },
      });
      expect(active.statusCode).toBe(200);
      expect(active.json()).toEqual([
        {
          id: "10000000-0000-4000-8000-000000000001",
          displayName: "Active Member",
          colorKey: "blue",
          role: "parent",
          lifecycle: "active",
          createdAt: now,
          updatedAt: now,
          birthDate: null,
        },
      ]);

      const archived = await app.inject({
        method: "GET",
        url: "/api/members?lifecycle=archived",
        cookies: { mp_device_key: key },
      });
      expect(archived.statusCode).toBe(200);
      expect(archived.json()).toEqual([
        {
          id: "10000000-0000-4000-8000-000000000002",
          displayName: "Archived Member",
          colorKey: "violet",
          role: "child",
          lifecycle: "archived",
          createdAt: now + 1,
          updatedAt: now + 1,
          birthDate: null,
        },
      ]);
    } finally {
      await app.close();
    }
  });
});
