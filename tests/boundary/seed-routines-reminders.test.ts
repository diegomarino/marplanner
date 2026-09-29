import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { getDb } from "../../src/server/db/client";
import { runSeedProfile } from "../../src/server/db/seeds/runner";
import { getBoard, listRoutineAssignments, listRoutines } from "../../src/server/modules/routines";
import { getReminder, listReminders } from "../../src/server/modules/reminders";
import { useIsolatedDb } from "../helpers/db";

const AS_OF_DATE = "2026-09-23";
const NOW_MS = Date.parse("2026-09-23T12:00:00.000Z");
const RERUN_NOW_MS = NOW_MS + 1;
const SEEDS_DIRECTORY = resolve(process.cwd(), "seeds");

describe("routines and reminders demo seed boundary", () => {
  useIsolatedDb();

  it("creates stable Simpson-inspired routines and representative completions through public reads", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);

    const report = await runSeedProfile({
      mode: "public",
      asOfDate: AS_OF_DATE,
      nowMs: NOW_MS,
      disposableTarget: true,
      seedsDirectory: SEEDS_DIRECTORY,
    });

    expect(report.moduleIds).toEqual([
      "public:settings",
      "members:demo",
      "calendar:demo",
      "routines:demo",
      "reminders:demo",
      "meals:demo",
      "daily:content:demo",
      "time:announcements:demo",
    ]);
    expect(listRoutines()).toEqual([
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
    expect(listRoutineAssignments("demo:routine:morning-launch")).toEqual([
      {
        id: "demo:routine-assignment:morning-launch:bart",
        memberId: "demo:member:bart",
        weekdays: ["mon", "tue", "wed", "thu", "fri"],
        active: true,
      },
      {
        id: "demo:routine-assignment:morning-launch:lisa",
        memberId: "demo:member:lisa",
        weekdays: ["mon", "tue", "wed", "thu", "fri"],
        active: true,
      },
    ]);

    const board = getBoard(AS_OF_DATE);
    expect(
      board
        .find((column) => column.memberId === "demo:member:bart")
        ?.dayPeriods.find((period) => period.id === "morning")?.chores
    ).toEqual([
      { id: "demo:chore:morning-launch:make-bed", name: "Make bed", icon: "🛏️", completed: true },
      {
        id: "demo:chore:morning-launch:pack-backpack",
        name: "Pack backpack",
        icon: "🎒",
        completed: false,
      },
      {
        id: "demo:chore:morning-launch:brush-teeth",
        name: "Brush teeth",
        icon: "🪥",
        completed: false,
      },
    ]);
    expect(
      board
        .find((column) => column.memberId === "demo:member:lisa")
        ?.dayPeriods.find((period) => period.id === "morning")?.chores
    ).toEqual([
      { id: "demo:chore:morning-launch:make-bed", name: "Make bed", icon: "🛏️", completed: false },
      {
        id: "demo:chore:morning-launch:pack-backpack",
        name: "Pack backpack",
        icon: "🎒",
        completed: true,
      },
      {
        id: "demo:chore:morning-launch:brush-teeth",
        name: "Brush teeth",
        icon: "🪥",
        completed: false,
      },
    ]);
  });

  it("creates scheduled and calendar-gated reminders with active canonical assignments", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);

    await runSeedProfile({
      mode: "public",
      asOfDate: AS_OF_DATE,
      nowMs: NOW_MS,
      disposableTarget: true,
      seedsDirectory: SEEDS_DIRECTORY,
    });

    expect(listReminders()).toEqual([
      {
        id: "demo:reminder:school-bag",
        kind: "scheduled",
        targetingMode: "specific",
        text: "Pack your school bag",
        weekdays: null,
        query: null,
        queryFields: null,
        active: true,
        assignments: [
          {
            id: "demo:reminder-assignment:school-bag:bart",
            memberId: "demo:member:bart",
            weekdays: ["mon", "tue", "wed", "thu", "fri"],
            active: true,
          },
          {
            id: "demo:reminder-assignment:school-bag:lisa",
            memberId: "demo:member:lisa",
            weekdays: ["mon", "tue", "wed", "thu", "fri"],
            active: true,
          },
        ],
      },
      {
        id: "demo:reminder:music-lesson",
        kind: "calendar_gated",
        targetingMode: "specific",
        text: "Pack your saxophone",
        weekdays: null,
        query: "music lesson",
        queryFields: ["title"],
        active: true,
        assignments: [
          {
            id: "demo:reminder-assignment:music-lesson:lisa",
            memberId: "demo:member:lisa",
            weekdays: [],
            active: true,
          },
        ],
      },
    ]);
    expect(getReminder("demo:reminder:music-lesson").kind).toBe("calendar_gated");
  });

  it("reruns deterministically and refuses an ordinary reminder without changing it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);

    await runSeedProfile({
      mode: "public",
      asOfDate: AS_OF_DATE,
      nowMs: NOW_MS,
      disposableTarget: true,
      seedsDirectory: SEEDS_DIRECTORY,
    });
    const firstBoard = getBoard(AS_OF_DATE);
    const firstReminders = listReminders();

    vi.setSystemTime(RERUN_NOW_MS);
    await runSeedProfile({
      mode: "public",
      asOfDate: AS_OF_DATE,
      nowMs: RERUN_NOW_MS,
      disposableTarget: true,
      seedsDirectory: SEEDS_DIRECTORY,
    });
    expect(getBoard(AS_OF_DATE)).toEqual(firstBoard);
    expect(listReminders()).toEqual(firstReminders);

    getDb()
      .prepare(
        "INSERT INTO reminder (id, kind, targeting_mode, text, weekdays, active, created_at, updated_at) VALUES (?, 'scheduled', 'apply_to_all', ?, ?, 1, ?, ?)"
      )
      .run("ordinary:reminder", "Ordinary reminder", '["tue"]', RERUN_NOW_MS, RERUN_NOW_MS);

    await expect(
      runSeedProfile({
        mode: "public",
        asOfDate: AS_OF_DATE,
        nowMs: RERUN_NOW_MS,
        disposableTarget: true,
        seedsDirectory: SEEDS_DIRECTORY,
      })
    ).rejects.toThrow(/unrelated row.*reminder/i);
    expect(getReminder("ordinary:reminder")).toMatchObject({
      id: "ordinary:reminder",
      text: "Ordinary reminder",
      kind: "scheduled",
    });
  });

  it("does not persist generated or runtime state", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);

    await runSeedProfile({
      mode: "public",
      asOfDate: AS_OF_DATE,
      nowMs: NOW_MS,
      disposableTarget: true,
      seedsDirectory: SEEDS_DIRECTORY,
    });

    for (const table of [
      "client_log",
      "daily_briefing",
      "daily_briefing_block_cache",
      "network_devices",
      "print_jobs",
    ]) {
      expect(getDb().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });
});
