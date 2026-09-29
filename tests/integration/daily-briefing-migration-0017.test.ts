import { describe, expect, it } from "vitest";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

describe("daily briefing current baseline", () => {
  useIsolatedDb();

  it("provides the current schema, defaults, and direct readback", () => {
    const db = getDb();
    const columns = db.prepare("PRAGMA table_info(daily_briefing)").all() as { name: string }[];

    expect(columns.map((column) => column.name)).toEqual([
      "id",
      "member_id",
      "date",
      "status",
      "payload",
      "failed_render_blocks",
      "unrendered_blocks",
      "raster_bits",
      "raster_height",
      "png",
      "last_print_state",
      "last_print_at",
      "last_print_generation",
      "created_at",
      "updated_at",
    ]);

    const now = 1_757_000_000_000;
    db.prepare(
      "INSERT INTO daily_briefing (id, member_id, date, status, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("baseline-briefing", "member-1", "2026-09-01", "render-failed", "{}", now, now);

    expect(
      db.prepare("SELECT * FROM daily_briefing WHERE id = ?").get("baseline-briefing")
    ).toMatchObject({
      id: "baseline-briefing",
      member_id: "member-1",
      date: "2026-09-01",
      status: "render-failed",
      payload: "{}",
      failed_render_blocks: "[]",
      unrendered_blocks: "[]",
      raster_bits: null,
      raster_height: null,
      png: null,
      last_print_state: null,
      last_print_at: null,
      last_print_generation: null,
      created_at: now,
      updated_at: now,
    });
    expect(() =>
      db
        .prepare(
          "INSERT INTO daily_briefing (id, member_id, date, status, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .run("invalid-status", "member-1", "2026-09-02", "legacy", "{}", now, now)
    ).toThrow(/CHECK constraint failed/);
  });
});
