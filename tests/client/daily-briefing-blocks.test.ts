import { describe, expect, it } from "vitest";
import {
  ALL_BLOCK_TYPES,
  COUNT_BLOCK_TYPES,
  DIFFICULTY_BLOCK_TYPES,
  LEVEL_BLOCK_TYPES,
  WEEKDAY_LABEL_KEYS,
  countOptions,
  cellToggleInput,
  rowToggleInput,
  defaultMemberBlockSettings,
  effectiveBlockDays,
  effectiveMatrixBlockTypes,
  reorderBlockOrderByType,
  resolveMemberBlockSettings,
  weekdayOfDate,
  type MemberBlockSettings,
} from "@/daily-briefing/admin/briefingBlocks";

const ALL = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function row(partial: Partial<MemberBlockSettings>): MemberBlockSettings {
  return { ...defaultMemberBlockSettings("m1", "weather"), ...partial };
}

describe("briefingBlocks — effective days and cell writes", () => {
  it("treats enabled + null weekdays as every day and disabled as no day", () => {
    expect(effectiveBlockDays(row({ enabled: true, weekdays: null }))).toEqual(ALL);
    expect(effectiveBlockDays(row({ enabled: false, weekdays: ["mon"] }))).toEqual([]);
    expect(effectiveBlockDays(row({ enabled: true, weekdays: ["sun", "mon"] }))).toEqual([
      "mon",
      "sun",
    ]);
  });

  it("switching one cell on in a legacy disabled row writes only that day", () => {
    expect(cellToggleInput(row({ enabled: false, weekdays: ["mon", "tue"] }), "fri")).toEqual({
      enabled: true,
      weekdays: ["fri"],
    });
  });

  it("switching the last cell off disables the block with an empty list", () => {
    expect(cellToggleInput(row({ enabled: true, weekdays: ["wed"] }), "wed")).toEqual({
      enabled: false,
      weekdays: [],
    });
  });

  it("completing all seven days writes null (every day) in canonical order otherwise", () => {
    expect(
      cellToggleInput(
        row({ enabled: true, weekdays: ["mon", "tue", "wed", "thu", "fri", "sat"] }),
        "sun"
      )
    ).toEqual({ enabled: true, weekdays: null });
    expect(cellToggleInput(row({ enabled: true, weekdays: null }), "mon")).toEqual({
      enabled: true,
      weekdays: ["tue", "wed", "thu", "fri", "sat", "sun"],
    });
  });

  it("the row toggle turns a block off every day while any day is on", () => {
    expect(rowToggleInput(row({ enabled: true, weekdays: null }))).toEqual({
      enabled: false,
      weekdays: [],
    });
    expect(rowToggleInput(row({ enabled: true, weekdays: ["wed"] }))).toEqual({
      enabled: false,
      weekdays: [],
    });
  });

  it("the row toggle turns a block on every day when no day is on", () => {
    expect(rowToggleInput(row({ enabled: false, weekdays: ["mon"] }))).toEqual({
      enabled: true,
      weekdays: null,
    });
    expect(rowToggleInput(row({ enabled: true, weekdays: [] }))).toEqual({
      enabled: true,
      weekdays: null,
    });
  });

  it("resolves a missing row to the FR-013 default (onThisDay off)", () => {
    expect(resolveMemberBlockSettings([], "m1", "onThisDay").enabled).toBe(false);
    expect(resolveMemberBlockSettings([], "m1", "dadJoke").enabled).toBe(true);
  });
});

describe("briefingBlocks — order", () => {
  it("lists configured types first, then the rest of the registry once", () => {
    const types = effectiveMatrixBlockTypes([{ type: "weather" }, { type: "weather" }]);
    expect(types[0]).toBe("weather");
    expect(types).toHaveLength(ALL_BLOCK_TYPES.length);
  });

  it("moves a type and keeps repeated instances with their params", () => {
    const order = [
      { type: "dadJoke" },
      { type: "wordOfDay", params: { level: "L1" as const } },
      { type: "wordOfDay", params: { level: "L3" as const } },
    ];
    const next = reorderBlockOrderByType(order, "wordOfDay", "dadJoke");
    expect(next.slice(0, 3)).toEqual([order[1], order[2], order[0]]);
    expect(next).toHaveLength(ALL_BLOCK_TYPES.length + 1);
  });

  it("returns the same array when nothing moves", () => {
    const order = [{ type: "dadJoke" }];
    expect(reorderBlockOrderByType(order, "dadJoke", "dadJoke")).toBe(order);
  });
});

describe("briefingBlocks — dates and labels", () => {
  it("reads a calendar date's weekday without a timezone", () => {
    expect(weekdayOfDate("2026-10-15")).toBe("thu");
    expect(weekdayOfDate("2026-10-18")).toBe("sun");
    expect(weekdayOfDate("not-a-date")).toBeNull();
  });

  it("maps every weekday to its own key", () => {
    for (const day of ALL) {
      expect(WEEKDAY_LABEL_KEYS[day as keyof typeof WEEKDAY_LABEL_KEYS]).toBe(
        `dailyBriefing.admin.weekday.${day}`
      );
    }
  });
});

describe("briefingBlocks — catalogue-derived controls", () => {
  it("offers each block's declared count range and none to blocks without a count", () => {
    expect(countOptions("phonics")).toEqual([1, 2, 3, 4, 5, 6]);
    expect(countOptions("trivia")).toEqual([]);
    expect([...COUNT_BLOCK_TYPES]).toEqual(["phonics"]);
    expect([...LEVEL_BLOCK_TYPES]).toEqual(["wordOfDay", "phonics"]);
    expect([...DIFFICULTY_BLOCK_TYPES]).toEqual(["trivia", "wordSearch"]);
  });
});
