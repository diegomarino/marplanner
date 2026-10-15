import { describe, expect, it } from "vitest";
import type { Chore, DayPeriodDTO, Routine } from "../../src/shared";
import { groupRoutinesByPeriod, moveChore } from "@/routines/admin/routineOrder";

const PERIODS: DayPeriodDTO[] = [
  { id: "evening", labelKey: "dayPeriod.evening", start: "17:00", sortOrder: 2 },
  { id: "morning", labelKey: "dayPeriod.morning", start: "06:00", sortOrder: 0 },
  { id: "afternoon", labelKey: "dayPeriod.afternoon", start: "12:00", sortOrder: 1 },
];
const routine = (id: string, dayPeriodId: string): Routine => ({
  id,
  name: id,
  dayPeriodId,
  active: true,
});
const chore = (id: string, sortOrder: number): Chore => ({
  id,
  routineId: "r",
  name: id,
  icon: null,
  sortOrder,
  active: true,
});

describe("groupRoutinesByPeriod", () => {
  it("orders groups by period start, keeps arrival order inside a group and drops empty periods", () => {
    const groups = groupRoutinesByPeriod(
      [routine("b", "evening"), routine("z", "morning"), routine("a", "morning")],
      PERIODS
    );
    expect(groups.map((g) => [g.period.id, g.routines.map((r) => r.id)])).toEqual([
      ["morning", ["z", "a"]],
      ["evening", ["b"]],
    ]);
  });

  it("returns no groups without routines", () => {
    expect(groupRoutinesByPeriod([], PERIODS)).toEqual([]);
  });
});

describe("moveChore", () => {
  const chores = [chore("a", 0), chore("b", 1), chore("c", 2)];

  it("moves a chore onto another's slot and renumbers sortOrder", () => {
    expect(moveChore(chores, "a", "c")?.map((c) => [c.id, c.sortOrder])).toEqual([
      ["b", 0],
      ["c", 1],
      ["a", 2],
    ]);
  });

  it("returns null when nothing moves or an id is unknown", () => {
    expect(moveChore(chores, "a", "a")).toBeNull();
    expect(moveChore(chores, "x", "a")).toBeNull();
    expect(moveChore(chores, "a", "x")).toBeNull();
  });
});
