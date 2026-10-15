import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReminderMemberDays } from "@/admin/ReminderMemberDays";
import type { WeekdayLabels } from "@/components/WeekdayPicker";
import type { Member, Weekday } from "../../src/shared";

const LABELS: WeekdayLabels = {
  mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun",
};
const ARI = { id: "m1", displayName: "Ari", colorKey: "blue" } as Member;
const BEA = { id: "m2", displayName: "Bea", colorKey: "teal" } as Member;

afterEach(cleanup);

function setup(
  value: Record<string, Weekday[]>,
  members: Member[] = [ARI, BEA],
  weekStartDay?: 0 | 1
) {
  const onChange = vi.fn();
  render(
    <ReminderMemberDays
      members={members}
      value={value}
      onChange={onChange}
      labels={LABELS}
      weekdaysLabel="Weekdays"
      emptyMessage="No active members."
      hint="Pick at least one weekday."
      weekStartDay={weekStartDay}
    />
  );
  return onChange;
}

describe("ReminderMemberDays", () => {
  it("shows a pill per member and day rows only for selected members", () => {
    setup({ m1: ["mon"] });
    expect(screen.getByTestId("reminders-member-m1")).toBeChecked();
    expect(screen.getByTestId("reminders-member-m2")).not.toBeChecked();
    expect(screen.getByTestId("reminders-weekday-m1-mon")).toBeChecked();
    expect(screen.queryByTestId("reminders-weekday-m2-mon")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Ari — Weekdays" })).toBeInTheDocument();
  });

  it("selecting a member adds an empty entry", () => {
    const onChange = setup({});
    fireEvent.click(screen.getByTestId("reminders-member-m2"));
    expect(onChange).toHaveBeenCalledWith({ m2: [] });
  });

  it("deselecting a member removes their entry, days included", () => {
    const onChange = setup({ m1: ["mon"], m2: ["fri"] });
    fireEvent.click(screen.getByTestId("reminders-member-m1"));
    expect(onChange).toHaveBeenCalledWith({ m2: ["fri"] });
  });

  it("toggling a day emits canonical order for that member only", () => {
    const onChange = setup({ m1: ["wed"] });
    fireEvent.click(screen.getByTestId("reminders-weekday-m1-mon"));
    expect(onChange).toHaveBeenCalledWith({ m1: ["mon", "wed"] });
  });

  it("explains a selected member with no days", () => {
    setup({ m1: [] });
    expect(screen.getByTestId("reminders-member-hint-m1")).toHaveTextContent(
      "Pick at least one weekday."
    );
    expect(screen.queryByTestId("reminders-member-hint-m2")).not.toBeInTheDocument();
  });

  it("puts Sunday first for a Sunday-first household without changing emitted order", () => {
    const onChange = setup({ m1: ["sun"] }, [ARI], 0);
    const group = screen.getByRole("group", { name: "Ari — Weekdays" });
    const labels = within(group)
      .getAllByRole("checkbox")
      .map((c) => c.closest("label")?.textContent?.trim());
    expect(labels[0]).toBe("Sun");
    fireEvent.click(screen.getByTestId("reminders-weekday-m1-mon"));
    expect(onChange).toHaveBeenCalledWith({ m1: ["mon", "sun"] });
  });

  it("renders the empty message when there are no members", () => {
    setup({}, []);
    expect(screen.getByText("No active members.")).toBeInTheDocument();
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });
});
