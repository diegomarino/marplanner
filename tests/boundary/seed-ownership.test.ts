import { describe, expect, it } from "vitest";
import { getDb } from "../../src/server/db/client";
import {
  DEMO_PROFILE,
  beginSeedProfile,
  completeSeedProfile,
} from "../../src/server/db/seeds/ownership";
import { useIsolatedDb } from "../helpers/db";

const AS_OF_DATE = "2026-09-23";
const NOW = 1_790_121_600_000;

describe("seed ownership boundary", () => {
  useIsolatedDb();

  it("creates the running simpsons marker with canonical migration and lifecycle metadata", () => {
    const result = beginSeedProfile(getDb(), { asOfDate: AS_OF_DATE, nowMs: NOW });

    expect(result).toEqual({ action: "created", profile: DEMO_PROFILE, status: "running" });
    expect(
      getDb()
        .prepare(
          "SELECT profile, version, as_of_date, status, started_at, completed_at FROM seed_profile_state"
        )
        .get()
    ).toEqual({
      profile: "simpsons-demo",
      version: 1,
      as_of_date: AS_OF_DATE,
      status: "running",
      started_at: NOW,
      completed_at: null,
    });
  });

  it("refuses incomplete lifecycle metadata before creating a marker", () => {
    getDb()
      .prepare("DELETE FROM plugin_activation_registry WHERE plugin_id = 'daily-messages'")
      .run();

    expect(() => beginSeedProfile(getDb(), { asOfDate: AS_OF_DATE, nowMs: NOW })).toThrow(
      /plugin_activation_registry/
    );
    expect(getDb().prepare("SELECT * FROM seed_profile_state").all()).toEqual([]);
  });

  it("refuses a noncanonical fixed day-period row before creating a marker", () => {
    getDb().prepare("UPDATE day_periods SET start_minutes = 301 WHERE id = 'morning'").run();

    expect(() => beginSeedProfile(getDb(), { asOfDate: AS_OF_DATE, nowMs: NOW })).toThrow(
      /day_periods/
    );
    expect(getDb().prepare("SELECT * FROM seed_profile_state").all()).toEqual([]);
  });

  it("refuses a household row on a fresh target without deleting it", () => {
    getDb()
      .prepare(
        "INSERT INTO members (id, display_name, role, created_at, updated_at) VALUES ('ordinary:member', 'Ordinary', 'parent', ?, ?)"
      )
      .run(NOW, NOW);

    expect(() => beginSeedProfile(getDb(), { asOfDate: AS_OF_DATE, nowMs: NOW })).toThrow(
      /members/
    );
    expect(getDb().prepare("SELECT id FROM members").all()).toEqual([{ id: "ordinary:member" }]);
    expect(getDb().prepare("SELECT * FROM seed_profile_state").all()).toEqual([]);
  });

  it("refuses an unrelated baseline-system row without deleting it", () => {
    getDb().exec("CREATE TABLE baseline_probe (id TEXT PRIMARY KEY)");
    getDb().prepare("INSERT INTO baseline_probe (id) VALUES ('unrelated')").run();

    expect(() => beginSeedProfile(getDb(), { asOfDate: AS_OF_DATE, nowMs: NOW })).toThrow(
      /baseline_probe/
    );
    expect(getDb().prepare("SELECT id FROM baseline_probe").all()).toEqual([{ id: "unrelated" }]);
  });

  it("refuses an invalid calendar date before creating a marker", () => {
    expect(() => beginSeedProfile(getDb(), { asOfDate: "2026-02-30", nowMs: NOW })).toThrow(
      /valid calendar date/
    );
    expect(getDb().prepare("SELECT * FROM seed_profile_state").all()).toEqual([]);
  });

  it("refuses a marker for a foreign profile without changing it", () => {
    getDb()
      .prepare(
        "INSERT INTO seed_profile_state (profile, version, as_of_date, status, started_at, completed_at) VALUES ('another-profile', 1, ?, 'running', ?, NULL)"
      )
      .run(AS_OF_DATE, NOW);

    expect(() => beginSeedProfile(getDb(), { asOfDate: AS_OF_DATE, nowMs: NOW + 1 })).toThrow(
      /another profile/
    );
    expect(getDb().prepare("SELECT profile, status FROM seed_profile_state").get()).toEqual({
      profile: "another-profile",
      status: "running",
    });
  });

  it("refuses a stale marker for a different as-of date without changing it", () => {
    beginSeedProfile(getDb(), { asOfDate: AS_OF_DATE, nowMs: NOW });

    expect(() => beginSeedProfile(getDb(), { asOfDate: "2026-09-24", nowMs: NOW + 1 })).toThrow(
      /as-of date/
    );
    expect(getDb().prepare("SELECT as_of_date, status FROM seed_profile_state").get()).toEqual({
      as_of_date: AS_OF_DATE,
      status: "running",
    });
  });

  it("repairs a running marker and completes it only after a valid owned-inventory scan", () => {
    beginSeedProfile(getDb(), { asOfDate: AS_OF_DATE, nowMs: NOW });
    getDb()
      .prepare(
        "INSERT INTO members (id, display_name, role, created_at, updated_at) VALUES ('demo:member:homer', 'Homer', 'parent', ?, ?)"
      )
      .run(NOW, NOW);

    expect(beginSeedProfile(getDb(), { asOfDate: AS_OF_DATE, nowMs: NOW + 1 })).toEqual({
      action: "repair",
      profile: DEMO_PROFILE,
      status: "running",
    });
    expect(completeSeedProfile(getDb(), { asOfDate: AS_OF_DATE, nowMs: NOW + 2 })).toEqual({
      action: "completed",
      profile: DEMO_PROFILE,
      status: "complete",
    });
    expect(getDb().prepare("SELECT status, completed_at FROM seed_profile_state").get()).toEqual({
      status: "complete",
      completed_at: NOW + 2,
    });
  });
});
