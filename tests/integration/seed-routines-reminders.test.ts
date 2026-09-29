import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { runSeedProfile } from "../../src/server/db/seeds/runner";
import { useIsolatedDb } from "../helpers/db";

const AS_OF_DATE = "2026-09-23";
const NEXT_DATE = "2026-09-24";
const FINAL_DATE = "2026-09-25";
const NOW_MS = Date.parse("2026-09-23T12:00:00.000Z");
const SEEDS_DIRECTORY = resolve(process.cwd(), "seeds");

describe("routines and reminders demo seed integration", () => {
  useIsolatedDb();

  it("exposes seeded relations, completions, assignments, and reminder kinds through authenticated public reads", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);
    await runSeedProfile({
      mode: "public",
      asOfDate: AS_OF_DATE,
      nowMs: NOW_MS,
      disposableTarget: true,
      seedsDirectory: SEEDS_DIRECTORY,
    });

    const deviceKey = "seed-routines-reminders-device";
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
      )
      .run("seed-routines-reminders-device", hashKey(deviceKey), NOW_MS);

    const { buildApp } = await import("../../src/server/app");
    const app = await buildApp();
    try {
      const options = { cookies: { mp_device_key: deviceKey } };
      const routines = await app.inject({ method: "GET", url: "/api/routines", ...options });
      expect(routines.statusCode).toBe(200);
      expect(JSON.parse(routines.body)).toEqual([
        {
          id: "demo:routine:morning-launch",
          name: "Morning launch",
          dayPeriodId: "morning",
          active: true,
        },
        {
          id: "demo:routine:evening-reset",
          name: "Evening reset",
          dayPeriodId: "evening",
          active: true,
        },
      ]);

      const assignments = await app.inject({
        method: "GET",
        url: "/api/routines/demo:routine:morning-launch/assignments",
        ...options,
      });
      expect(assignments.statusCode).toBe(200);
      expect(JSON.parse(assignments.body)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            memberId: "demo:member:bart",
            weekdays: ["mon", "tue", "wed", "thu", "fri"],
            active: true,
          }),
          expect.objectContaining({
            memberId: "demo:member:lisa",
            weekdays: ["mon", "tue", "wed", "thu", "fri"],
            active: true,
          }),
        ])
      );

      const board = await app.inject({
        method: "GET",
        url: `/api/chores/board?date=${AS_OF_DATE}`,
        ...options,
      });
      expect(board.statusCode).toBe(200);
      expect(
        JSON.parse(board.body)
          .find((column: { memberId: string }) => column.memberId === "demo:member:bart")
          .dayPeriods.find((period: { id: string }) => period.id === "morning").chores
      ).toContainEqual({
        id: "demo:chore:morning-launch:make-bed",
        name: "Make bed",
        icon: "🛏️",
        completed: true,
      });

      const reminders = await app.inject({ method: "GET", url: "/api/reminders", ...options });
      expect(reminders.statusCode).toBe(200);
      expect(JSON.parse(reminders.body)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "demo:reminder:school-bag",
            kind: "scheduled",
            assignments: expect.arrayContaining([
              expect.objectContaining({ memberId: "demo:member:bart" }),
            ]),
          }),
          expect.objectContaining({
            id: "demo:reminder:music-lesson",
            kind: "calendar_gated",
            assignments: [expect.objectContaining({ memberId: "demo:member:lisa", weekdays: [] })],
          }),
        ])
      );
    } finally {
      await app.close();
    }
  });

  it("advances only seed-owned date-relative completions and refuses ordinary completions", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);
    await runSeedProfile({
      mode: "public",
      asOfDate: AS_OF_DATE,
      nowMs: NOW_MS,
      disposableTarget: true,
      seedsDirectory: SEEDS_DIRECTORY,
    });

    const sameDateCompletions = seedCompletionRows();
    vi.setSystemTime(NOW_MS + 30_000);
    await expect(
      runSeedProfile({
        mode: "public",
        asOfDate: AS_OF_DATE,
        nowMs: NOW_MS + 30_000,
        disposableTarget: true,
        seedsDirectory: SEEDS_DIRECTORY,
      })
    ).resolves.toMatchObject({ asOfDate: AS_OF_DATE, markerAction: "rerun", status: "complete" });
    expect(seedCompletionRows()).toEqual(sameDateCompletions);

    vi.setSystemTime(NOW_MS + 60_000);
    await expect(
      runSeedProfile({
        mode: "public",
        asOfDate: NEXT_DATE,
        nowMs: NOW_MS + 60_000,
        disposableTarget: true,
        seedsDirectory: SEEDS_DIRECTORY,
      })
    ).resolves.toMatchObject({ asOfDate: NEXT_DATE, markerAction: "repair", status: "complete" });

    expect(seedCompletionRows()).toEqual([
      {
        id: "demo:chore-completion:evening-reset:feed-snowball-ii:lisa:2026-09-24",
        date: NEXT_DATE,
      },
      {
        id: "demo:chore-completion:morning-launch:make-bed:bart:2026-09-24",
        date: NEXT_DATE,
      },
      {
        id: "demo:chore-completion:morning-launch:pack-backpack:lisa:2026-09-24",
        date: NEXT_DATE,
      },
    ]);

    getDb()
      .prepare(
        "INSERT INTO chore_completions (id, chore_id, member_id, date, completed_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(
        "ordinary:chore-completion",
        "demo:chore:morning-launch:make-bed",
        "demo:member:homer",
        NEXT_DATE,
        NOW_MS + 60_001
      );

    await expect(
      runSeedProfile({
        mode: "public",
        asOfDate: FINAL_DATE,
        nowMs: NOW_MS + 120_000,
        disposableTarget: true,
        seedsDirectory: SEEDS_DIRECTORY,
      })
    ).rejects.toThrow(/unrelated row.*chore_completions/i);
    expect(
      getDb()
        .prepare("SELECT id, date FROM chore_completions WHERE id = ?")
        .get("ordinary:chore-completion")
    ).toEqual({ id: "ordinary:chore-completion", date: NEXT_DATE });
  });
});

function seedCompletionRows() {
  return getDb()
    .prepare(
      "SELECT id, date FROM chore_completions WHERE id LIKE 'demo:chore-completion:%' ORDER BY id"
    )
    .all();
}
