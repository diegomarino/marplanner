/** AssignmentDialog spec — week-start ordered weekday pills, the widened dialog and the
 * deactivated marker, rendered directly with a mocked household week start.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Assignment, Member } from "../../src/shared";
import { LanguageProvider } from "@/i18n";
import { AssignmentDialog } from "@/routines/admin/AssignmentDialog";

const household = vi.hoisted(() => ({ weekStartDay: null as number | null }));
vi.mock("@/lib/householdSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/householdSettings")>()),
  useHouseholdSettings: () => household,
}));

afterEach(() => {
  cleanup();
  household.weekStartDay = null;
});

const CHILD: Member = {
  id: "m1",
  displayName: "Ari",
  role: "child",
  colorKey: "red",
  lifecycle: "active",
  createdAt: 0,
  updatedAt: 0,
} as Member;

function renderDialog(assignments: Assignment[] = []) {
  const onSave = vi.fn();
  render(
    <LanguageProvider>
      <AssignmentDialog
        open
        childMembers={[CHILD]}
        assignments={assignments}
        busy={false}
        error={null}
        onClose={vi.fn()}
        onSave={onSave}
        onDeactivate={vi.fn()}
      />
    </LanguageProvider>
  );
  return { onSave, row: screen.getByTestId("routine-assignment-m1") };
}

const names = (row: HTMLElement) =>
  within(row)
    .getAllByRole("checkbox")
    .map((box) => box.getAttribute("aria-label") ?? box.closest("label")?.textContent ?? "");

describe("AssignmentDialog", () => {
  it("lists the weekday pills Monday-first when the week starts on Monday", () => {
    household.weekStartDay = 1;
    const { row } = renderDialog();
    expect(names(row)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  });

  it("lists Sunday first and still saves weekdays in canonical order", () => {
    household.weekStartDay = 0;
    const { row, onSave } = renderDialog();
    expect(names(row)).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    fireEvent.click(within(row).getByRole("checkbox", { name: "Wed" }));
    fireEvent.click(within(row).getByRole("checkbox", { name: "Mon" }));
    fireEvent.click(within(row).getByRole("button", { name: "Save Assignment" }));
    expect(onSave).toHaveBeenCalledWith("m1", ["mon", "wed"]);
  });

  it("is wide enough for one pill row", () => {
    renderDialog();
    const dialog = screen.getByTestId("assignment-dialog");
    expect(dialog).toHaveClass("sm:max-w-2xl");
    expect(dialog).not.toHaveClass("sm:max-w-xl");
  });

  it("marks a deactivated assignment and only that", () => {
    renderDialog([{ id: "a1", memberId: "m1", weekdays: ["mon"], active: false }]);
    expect(screen.getByTestId("routine-assignment-m1-inactive")).toHaveTextContent("Deactivated");
    cleanup();
    renderDialog([{ id: "a1", memberId: "m1", weekdays: ["mon"], active: true }]);
    expect(screen.queryByTestId("routine-assignment-m1-inactive")).not.toBeInTheDocument();
  });
});
