/** RoutineWeekGrid shows its seven day columns in the household week-start order (spec D9 and
 * the orchestrator addendum); assignments themselves keep their stored weekday codes. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RoutineWeekGrid } from "@/routines/admin/RoutineWeekGrid";
import type { Assignment, Member } from "../../src/shared";

const household = vi.hoisted(() => ({
  timezone: "UTC",
  language: "en",
  weekStartDay: null as number | null,
}));
vi.mock("@/lib/householdSettings", () => ({
  useHouseholdSettings: () => household,
  useHouseholdSettingsContext: () => household,
}));

afterEach(() => {
  cleanup();
  household.weekStartDay = null;
});

const MEMBER = {
  id: "m1",
  displayName: "Ari",
  role: "child",
  colorKey: "blue",
  lifecycle: "active",
} as unknown as Member;
const ASSIGNMENT = {
  id: "a1",
  memberId: "m1",
  weekdays: ["sun"],
  active: true,
} as unknown as Assignment;

const dayOrder = () =>
  screen.getAllByTestId(/^routine-week-day-/).map((el) => el.dataset.testid?.slice(-3));

describe("RoutineWeekGrid — week start", () => {
  it("is Monday-first by default", () => {
    render(<RoutineWeekGrid assignments={[ASSIGNMENT]} members={[MEMBER]} onOpen={() => {}} />);
    expect(dayOrder()).toEqual(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
  });

  it("is Sunday-first for a Sunday household and keeps each assignment on its day", () => {
    household.weekStartDay = 0;
    render(<RoutineWeekGrid assignments={[ASSIGNMENT]} members={[MEMBER]} onOpen={() => {}} />);
    expect(dayOrder()).toEqual(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
    expect(screen.getByTestId("routine-week-day-sun")).toHaveTextContent("Ari");
    expect(screen.getByTestId("routine-week-day-mon")).not.toHaveTextContent("Ari");
  });
});
