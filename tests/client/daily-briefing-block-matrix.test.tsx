import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockMatrix, type BlockMatrixProps } from "@/daily-briefing/admin/BlockMatrix";
import {
  defaultMemberBlockSettings,
  type BlockRegistryType,
  type MemberBlockSettings,
} from "@/daily-briefing/admin/briefingBlocks";
import { assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-density");
});

const ALL = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

function renderMatrix(overrides: Partial<BlockMatrixProps> = {}, rows: MemberBlockSettings[] = []) {
  const props: BlockMatrixProps = {
    memberName: "Lisa",
    blockOrder: [],
    resolve: (type: BlockRegistryType) =>
      rows.find((r) => r.blockType === type) ?? defaultMemberBlockSettings("m1", type),
    schedule: ALL,
    savingTypes: new Set(),
    scheduleSaving: false,
    orderSaving: false,
    weekStartDay: 1,
    onToggleCell: vi.fn(),
    onParamChange: vi.fn(),
    onToggleDay: vi.fn(),
    onReorder: vi.fn(),
    ...overrides,
  };
  render(<BlockMatrix {...props} />);
  return props;
}

describe("BlockMatrix", () => {
  it("puts the weekday columns in household week-start order, headers and cells aligned", () => {
    renderMatrix({ weekStartDay: 0 });
    const headings = screen
      .getAllByTestId(/^daily-briefing-block-weekday-heading-/)
      .map((el) => el.dataset.testid?.replace("daily-briefing-block-weekday-heading-", ""));
    expect(headings).toEqual(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
    const row = screen.getByTestId("daily-briefing-admin-block-settings-row-weather");
    const cells = within(row)
      .getAllByRole("checkbox")
      .map((el) => el.dataset.testid?.replace("daily-briefing-block-cell-weather-", ""));
    expect(cells).toEqual(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
  });

  it("names each cell by block and day and reports toggles", () => {
    const props = renderMatrix();
    const cell = screen.getByRole("checkbox", { name: "Weather on Tue" });
    expect(cell).toBeChecked();
    fireEvent.click(cell);
    expect(props.onToggleCell).toHaveBeenCalledWith("weather", "tue");
  });

  it("shows a disabled block as all off, with onThisDay's default-off note", () => {
    renderMatrix();
    for (const day of ALL) {
      expect(screen.getByTestId(`daily-briefing-block-cell-onThisDay-${day}`)).not.toBeChecked();
    }
    expect(
      screen.getByTestId("daily-briefing-admin-block-default-disabled-onThisDay")
    ).toBeVisible();
  });

  it("drops onThisDay's default-off note once the member has configured the block", () => {
    renderMatrix({}, [
      {
        ...defaultMemberBlockSettings("m1", "onThisDay"),
        enabled: true,
        weekdays: ["mon"],
        updatedAt: 5,
      },
    ]);
    expect(
      screen.queryByTestId("daily-briefing-admin-block-default-disabled-onThisDay")
    ).not.toBeInTheDocument();
  });

  it("disables a paused column's cells but keeps their value, and toggles the pause", () => {
    const props = renderMatrix({ schedule: ["mon", "tue", "wed", "thu", "fri"] });
    expect(screen.getByTestId("daily-briefing-schedule-day-sun")).not.toBeChecked();
    expect(screen.getByTestId("daily-briefing-block-cell-weather-sun")).toBeDisabled();
    expect(screen.getByTestId("daily-briefing-block-cell-weather-sun")).toBeChecked();
    expect(screen.getByTestId("daily-briefing-block-cell-weather-mon")).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Briefing on Sun" }));
    expect(props.onToggleDay).toHaveBeenCalledWith("sun");
  });

  it("disables only the saving row, and the pause row while the schedule saves", () => {
    renderMatrix({ savingTypes: new Set(["weather"]), scheduleSaving: true });
    expect(screen.getByTestId("daily-briefing-block-cell-weather-mon")).toBeDisabled();
    expect(screen.getByTestId("daily-briefing-block-cell-dadJoke-mon")).toBeEnabled();
    expect(screen.getByTestId("daily-briefing-schedule-day-mon")).toBeDisabled();
  });

  it("offers params inline and reports changes", () => {
    const props = renderMatrix();
    fireEvent.change(screen.getByTestId("daily-briefing-admin-block-difficulty-trivia"), {
      target: { value: "hard" },
    });
    expect(props.onParamChange).toHaveBeenCalledWith("trivia", { difficulty: "hard" });
    fireEvent.change(screen.getByTestId("daily-briefing-admin-block-level-wordOfDay"), {
      target: { value: "" },
    });
    expect(props.onParamChange).toHaveBeenCalledWith("wordOfDay", { level: undefined });
  });

  it("names the drag handles and disables them while the order saves", () => {
    renderMatrix({ orderSaving: true });
    expect(screen.getByRole("button", { name: "Reorder Weather" })).toBeDisabled();
  });

  it("contains the hidden cell labels inside its own scroll box (no page-wide sideways scroll)", () => {
    renderMatrix();
    expect(screen.getByTestId("daily-briefing-block-matrix").parentElement).toHaveClass(
      "relative",
      "overflow-x-auto"
    );
  });

  it("meets kiosk density", async () => {
    const uninject = await injectDensityStyles({
      extraCandidates: ["size-[var(--control-height)]"],
    });
    document.documentElement.setAttribute("data-density", "kiosk");
    try {
      renderMatrix();
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });
});
