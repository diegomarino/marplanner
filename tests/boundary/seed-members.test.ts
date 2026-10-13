import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { getDb } from "../../src/server/db/client";
import { runSeedProfile } from "../../src/server/db/seeds/runner";
import { listMembersWithLifecycle } from "../../src/server/modules/members";
import { useIsolatedDb } from "../helpers/db";

const AS_OF_DATE = "2026-09-23";
const NOW_MS = Date.parse("2026-09-23T12:00:00.000Z");
const RERUN_NOW_MS = NOW_MS + 1;
const SEEDS_DIRECTORY = resolve(process.cwd(), "seeds");

const EXPECTED_MEMBERS = [
  {
    id: "demo:member:homer",
    displayName: "Homer",
    colorKey: "blue",
    role: "parent",
    lifecycle: "active",
    birthDate: { month: 5, day: 12, year: null },
    createdAt: NOW_MS,
    updatedAt: NOW_MS,
  },
  {
    id: "demo:member:marge",
    displayName: "Marge",
    colorKey: "sky",
    role: "parent",
    lifecycle: "active",
    birthDate: { month: 5, day: 19, year: null },
    createdAt: NOW_MS,
    updatedAt: NOW_MS,
  },
  {
    id: "demo:member:bart",
    displayName: "Bart",
    colorKey: "red",
    role: "child",
    lifecycle: "active",
    birthDate: { month: 2, day: 23, year: null },
    createdAt: NOW_MS,
    updatedAt: NOW_MS,
  },
  {
    id: "demo:member:lisa",
    displayName: "Lisa",
    colorKey: "violet",
    role: "child",
    lifecycle: "active",
    birthDate: { month: 5, day: 9, year: null },
    createdAt: NOW_MS,
    updatedAt: NOW_MS,
  },
  {
    id: "demo:member:maggie",
    displayName: "Maggie",
    colorKey: "teal",
    role: "child",
    lifecycle: "active",
    birthDate: { month: 1, day: 12, year: null },
    createdAt: NOW_MS,
    updatedAt: NOW_MS,
  },
] as const;

describe("canonical demo member seed boundary", () => {
  useIsolatedDb();

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates the five canonical active members and preserves public readback on rerun", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);

    const firstReport = await runSeedProfile({
      mode: "public",
      asOfDate: AS_OF_DATE,
      nowMs: NOW_MS,
      disposableTarget: true,
      seedsDirectory: SEEDS_DIRECTORY,
    });
    const firstRead = await readAllMembers();

    vi.setSystemTime(RERUN_NOW_MS);
    const secondReport = await runSeedProfile({
      mode: "public",
      asOfDate: AS_OF_DATE,
      nowMs: RERUN_NOW_MS,
      disposableTarget: true,
      seedsDirectory: SEEDS_DIRECTORY,
    });
    const secondRead = await readAllMembers();

    expect(firstReport).toMatchObject({
      moduleIds: [
        "public:settings",
        "members:demo",
        "calendar:demo",
        "routines:demo",
        "reminders:demo",
        "meals:demo",
        "daily:content:demo",
        "time:announcements:demo",
        "plugins:demo",
      ],
      asOfDate: AS_OF_DATE,
      status: "complete",
    });
    expect(secondReport).toMatchObject({
      moduleIds: [
        "public:settings",
        "members:demo",
        "calendar:demo",
        "routines:demo",
        "reminders:demo",
        "meals:demo",
        "daily:content:demo",
        "time:announcements:demo",
        "plugins:demo",
      ],
      asOfDate: AS_OF_DATE,
      status: "complete",
    });
    expect(firstRead).toEqual(EXPECTED_MEMBERS);
    expect(secondRead).toEqual(EXPECTED_MEMBERS);
  });

  it("refuses a non-demo member without changing it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);

    await runSeedProfile({
      mode: "public",
      asOfDate: AS_OF_DATE,
      nowMs: NOW_MS,
      disposableTarget: true,
      seedsDirectory: SEEDS_DIRECTORY,
    });

    getDb()
      .prepare(
        "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run("ordinary:member", "Ordinary", "parent", "active", NOW_MS + 1, NOW_MS + 1);

    await expect(
      runSeedProfile({
        mode: "public",
        asOfDate: AS_OF_DATE,
        nowMs: NOW_MS,
        disposableTarget: true,
        seedsDirectory: SEEDS_DIRECTORY,
      })
    ).rejects.toThrow(/unrelated row.*members/i);

    expect(
      getDb()
        .prepare(
          "SELECT id, display_name, role, lifecycle, created_at, updated_at FROM members WHERE id = ?"
        )
        .get("ordinary:member")
    ).toEqual({
      id: "ordinary:member",
      display_name: "Ordinary",
      role: "parent",
      lifecycle: "active",
      created_at: NOW_MS + 1,
      updated_at: NOW_MS + 1,
    });
  });
});

async function readAllMembers() {
  return listMembersWithLifecycle("all");
}
