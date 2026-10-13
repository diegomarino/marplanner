import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getDb } from "../../src/server/db/client";
import { MEMBER_COLOR_KEYS, RETIRED_MEMBER_COLOR_KEYS } from "../../src/shared";
import { useIsolatedDb } from "../helpers/db";

const MIGRATION = readFileSync("drizzle/0004_member_palette.sql", "utf8");

describe("member palette migration", () => {
  useIsolatedDb();

  // A current database refuses the retired names. Lifting the CHECK for the insert stands in
  // for a database created before the palette shrank, which is where this migration matters.
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

    getDb().exec(MIGRATION);

    expect(colours()).toEqual({ ...RETIRED_MEMBER_COLOR_KEYS, "keeps-green": "green" });
  });

  it("gives the first free colour when another active member already has the survivor", () => {
    member("a-red", "red");
    member("b-rose", "rose");
    member("c-blue", "blue");

    getDb().exec(MIGRATION);

    // Red is taken, so the rose member takes the first colour nobody active uses: sky.
    expect(colours()).toEqual({ "a-red": "red", "b-rose": "sky", "c-blue": "blue" });
  });

  it("does not hand out a colour that a retired colour is about to become", () => {
    member("a-red", "red");
    member("b-rose", "rose");
    member("c-indigo", "indigo");

    getDb().exec(MIGRATION);

    const after = colours();
    expect(after["c-indigo"]).toBe("blue");
    // Blue was reserved for the indigo member, so rose could not take it.
    expect(after["b-rose"]).toBe("sky");
  });

  it("moves an archived member straight to the survivor, since archived members hold no colour", () => {
    member("a-amber", "amber");
    member("b-yellow", "yellow", "archived");

    getDb().exec(MIGRATION);

    expect(colours()).toEqual({ "a-amber": "amber", "b-yellow": "amber" });
  });

  it("leaves only current colours behind", () => {
    for (const retired of Object.keys(RETIRED_MEMBER_COLOR_KEYS)) member(retired, retired);
    getDb().exec(MIGRATION);

    for (const colour of Object.values(colours())) {
      expect(MEMBER_COLOR_KEYS).toContain(colour);
    }
  });
});
