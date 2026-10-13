import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getDb } from "../../src/server/db/client";
import { MEMBER_COLOR_KEYS, RETIRED_MEMBER_COLOR_KEYS } from "../../src/shared";
import { useIsolatedDb } from "../helpers/db";

const MIGRATION = readFileSync("drizzle/0004_member_palette.sql", "utf8");

describe("member palette migration", () => {
  useIsolatedDb();

  // A migrated database refuses the retired names. Lifting the CHECK for the insert stands in
  // for a database from before the palette shrank, which is where this migration matters.
  function member(id: string, colorKey: string, lifecycle: "active" | "archived" = "active") {
    const db = getDb();
    db.pragma("ignore_check_constraints = ON");
    try {
      insertMember(id, colorKey, lifecycle);
    } finally {
      db.pragma("ignore_check_constraints = OFF");
    }
  }
  function insertMember(id: string, colorKey: string, lifecycle: "active" | "archived") {
    getDb()
      .prepare(
        `INSERT INTO members (id, display_name, role, lifecycle, color_key, created_at, updated_at)
         VALUES (?, ?, 'child', ?, ?, 0, 0)`
      )
      .run(id, id, lifecycle, colorKey);
  }
  // As the migration runner does: foreign keys off around the batch, then every key verified.
  function migrate(): void {
    const db = getDb();
    db.pragma("foreign_keys = OFF");
    try {
      db.exec(MIGRATION);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.pragma("foreign_keys = ON");
    }
  }
  const colours = () =>
    Object.fromEntries(
      (
        getDb().prepare("SELECT id, color_key FROM members ORDER BY id").all() as {
          id: string;
          color_key: string;
        }[]
      ).map((row) => [row.id, row.color_key])
    );

  it("moves every retired colour to its survivor and leaves current colours alone", () => {
    for (const retired of Object.keys(RETIRED_MEMBER_COLOR_KEYS)) member(retired, retired);
    member("keeps-green", "green");

    migrate();

    expect(colours()).toEqual({ ...RETIRED_MEMBER_COLOR_KEYS, "keeps-green": "green" });
  });

  it("gives the first free colour when another active member already has the survivor", () => {
    member("a-red", "red");
    member("b-rose", "rose");
    member("c-blue", "blue");

    migrate();

    // Red is taken, so the rose member takes the first colour nobody active uses: sky.
    expect(colours()).toEqual({ "a-red": "red", "b-rose": "sky", "c-blue": "blue" });
  });

  it("does not hand out a colour that a retired colour is about to become", () => {
    member("a-red", "red");
    member("b-rose", "rose");
    member("c-indigo", "indigo");

    migrate();

    const after = colours();
    expect(after["c-indigo"]).toBe("blue");
    // Blue was reserved for the indigo member, so rose could not take it.
    expect(after["b-rose"]).toBe("sky");
  });

  it("moves an archived member straight to the survivor, since archived members hold no colour", () => {
    member("a-amber", "amber");
    member("b-yellow", "yellow", "archived");

    migrate();

    expect(colours()).toEqual({ "a-amber": "amber", "b-yellow": "amber" });
  });

  it("leaves only current colours behind", () => {
    for (const retired of Object.keys(RETIRED_MEMBER_COLOR_KEYS)) member(retired, retired);
    migrate();

    for (const colour of Object.values(colours())) {
      expect(MEMBER_COLOR_KEYS).toContain(colour);
    }
  });

  it("leaves an upgraded database refusing the retired names, like a fresh one", () => {
    member("a-cyan", "cyan");
    migrate();

    expect(() => insertMember("late", "cyan", "active")).toThrow(/members_color_key_check/);
    expect(() =>
      getDb().prepare("UPDATE members SET color_key = 'indigo' WHERE id = 'a-cyan'").run()
    ).toThrow(/members_color_key_check/);
    // The other constraints came across with the rebuild.
    expect(() =>
      getDb().prepare("UPDATE members SET role = 'admin' WHERE id = 'a-cyan'").run()
    ).toThrow(/members_role_check/);
  });

  it("keeps the rows that reference a member through the rebuild", () => {
    member("a-rose", "rose");
    const db = getDb();
    db.prepare(
      `INSERT INTO calendar_events (id, source, title, all_day, start_date, end_date, created_at, updated_at)
       VALUES ('event-1', 'local', 'Swim', 1, '2026-10-15', '2026-10-16', 0, 0)`
    ).run();
    db.prepare(
      "INSERT INTO calendar_assignments (id, event_id, member_id, created_at) VALUES ('a1', 'event-1', 'a-rose', 0)"
    ).run();

    migrate();

    expect(db.prepare("SELECT member_id FROM calendar_assignments WHERE id = 'a1'").get()).toEqual({
      member_id: "a-rose",
    });
    // The reference is live again: deleting the member still cascades to their assignments.
    db.prepare("DELETE FROM members WHERE id = 'a-rose'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM calendar_assignments").get()).toEqual({ n: 0 });
  });
});
