/** WeekdayPicker spec (FR-005, SC-009 — Wiring + Accessibility).
 * Exercises every mode/render combination this component must serve — multi (checkbox
 * semantics), single as a native `<select>` (the default, `MealsManagement` parity), and single
 * as a radiogroup (`renderAs="radio"`) — since collapsing any of these into another would
 * silently change behaviour for whichever call site adopts it.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CANONICAL_WEEKDAY_ORDER,
  WeekdayPicker,
  type WeekdayLabels,
} from "@/components/WeekdayPicker";
import { assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-density");
});

const LABELS: WeekdayLabels = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

/** Literal, not derived from `CANONICAL_WEEKDAY_ORDER` — a test that compares the rendered
 * order against the very constant the component renders from can never fail when both sides
 * move together (this is what let a reversed-order mutant survive). This is the one thing
 * SC-009 exists to centralise, so it is the one thing pinned against literals here. */
const EXPECTED_LABEL_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const EXPECTED_CODE_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

describe("CANONICAL_WEEKDAY_ORDER", () => {
  it("is pinned to the literal mon..sun order", () => {
    expect(CANONICAL_WEEKDAY_ORDER).toEqual(EXPECTED_CODE_ORDER);
  });
});

describe("WeekdayPicker — multi mode (default)", () => {
  it("renders all seven days in canonical order as a group of checkboxes", () => {
    render(
      <WeekdayPicker labels={LABELS} groupLabel="Weekdays" value={["mon"]} onChange={() => {}} />
    );
    const group = screen.getByRole("group");
    const checkboxes = within(group).getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(7);
    expect(
      checkboxes.map((c) => c.getAttribute("aria-label") ?? c.closest("label")?.textContent)
    ).toEqual(EXPECTED_LABEL_ORDER);
  });

  it("reflects the selected set", () => {
    render(
      <WeekdayPicker
        labels={LABELS}
        groupLabel="Weekdays"
        value={["mon", "wed"]}
        onChange={() => {}}
      />
    );
    expect(screen.getByRole("checkbox", { name: "Mon" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Tue" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Wed" })).toBeChecked();
  });

  it("adds a day to the set on click", () => {
    const onChange = vi.fn();
    render(
      <WeekdayPicker labels={LABELS} groupLabel="Weekdays" value={["mon"]} onChange={onChange} />
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Tue" }));
    expect(onChange).toHaveBeenCalledWith(["mon", "tue"]);
  });

  it("deliberate negative — removes (not re-adds) a day already in the set", () => {
    const onChange = vi.fn();
    render(
      <WeekdayPicker
        labels={LABELS}
        groupLabel="Weekdays"
        value={["mon", "tue"]}
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Mon" }));
    expect(onChange).toHaveBeenCalledWith(["tue"]);
  });

  it("emits the canonical mon..sun order on change, not click/insertion order (C1)", () => {
    const onChange = vi.fn();
    // Starting value already holds "wed"; clicking "mon" must PREPEND it in canonical order,
    // never append it — a naive `[...value, day]` would produce ["wed", "mon"] instead.
    render(
      <WeekdayPicker labels={LABELS} groupLabel="Weekdays" value={["wed"]} onChange={onChange} />
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Mon" }));
    expect(onChange).toHaveBeenCalledWith(["mon", "wed"]);
  });

  it("wires testIdPrefix onto each day as `${prefix}-${day}` (H2)", () => {
    render(
      <WeekdayPicker
        labels={LABELS}
        groupLabel="Weekdays"
        value={["mon"]}
        onChange={() => {}}
        testIdPrefix="routines-weekday"
      />
    );
    for (const day of EXPECTED_CODE_ORDER) {
      expect(screen.getByTestId(`routines-weekday-${day}`)).toBeInTheDocument();
    }
  });

  it("uses the caller-provided groupLabel as the accessible name, not a hardcoded default (M2)", () => {
    render(
      <WeekdayPicker
        labels={LABELS}
        groupLabel="Días de la semana"
        value={["mon"]}
        onChange={() => {}}
      />
    );
    expect(screen.getByRole("group", { name: "Días de la semana" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Weekdays" })).not.toBeInTheDocument();
  });
});

describe('WeekdayPicker — single mode, renderAs="select" (default, MealsManagement parity)', () => {
  it("renders a native select with all seven days in canonical order", () => {
    render(
      <WeekdayPicker
        mode="single"
        labels={LABELS}
        groupLabel="Weekday"
        value="mon"
        onChange={() => {}}
      />
    );
    const select = screen.getByRole("combobox");
    expect(select.tagName.toLowerCase()).toBe("select");
    const options = within(select).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(EXPECTED_LABEL_ORDER);
    expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual(EXPECTED_CODE_ORDER);
  });

  // Uses a NON-FIRST day deliberately. With `value="mon"` a component that hardcoded the first
  // option would pass — the fixture and the bug agree. Multi and radio mode already avoid this by
  // accident; the select path did not.
  it("reflects the current value and emits the selected day on change", () => {
    const onChange = vi.fn();
    render(
      <WeekdayPicker
        mode="single"
        labels={LABELS}
        groupLabel="Weekday"
        value="wed"
        onChange={onChange}
      />
    );
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("wed");
    fireEvent.change(select, { target: { value: "fri" } });
    expect(onChange).toHaveBeenCalledWith("fri");
  });

  // The M2 accessible-name guarantee was pinned for multi mode only. It matters MORE here: the
  // Meals call site wraps the select in a <label>, so a missing aria-label silently falls back to
  // the wrapper text and LOOKS correct — masking exactly the case M2 exists to prevent.
  it("carries the caller's groupLabel as the select's accessible name", () => {
    render(
      <WeekdayPicker
        mode="single"
        labels={LABELS}
        groupLabel="Día de la semana"
        value="wed"
        onChange={() => {}}
      />
    );
    expect(screen.getByRole("combobox", { name: "Día de la semana" })).toBeInTheDocument();
  });

  // `disabled={saving}` is live on two weekday call sites today; the checkbox path pins it, the
  // select path did not.
  it("disables the select when disabled is passed", () => {
    render(
      <WeekdayPicker
        mode="single"
        labels={LABELS}
        groupLabel="Weekday"
        value="wed"
        disabled
        onChange={() => {}}
      />
    );
    expect(screen.getByRole("combobox")).toBeDisabled();
  });

  it("preserves the `-select` testid suffix (H1)", () => {
    render(
      <WeekdayPicker
        mode="single"
        labels={LABELS}
        groupLabel="Weekday"
        value="mon"
        onChange={() => {}}
        testIdPrefix="meals-recurring-weekday"
      />
    );
    expect(screen.getByTestId("meals-recurring-weekday-select")).toBeInTheDocument();
  });
});

describe('WeekdayPicker — single mode, renderAs="radio"', () => {
  it("renders all seven days as a radiogroup sharing one group name", () => {
    render(
      <WeekdayPicker
        mode="single"
        renderAs="radio"
        labels={LABELS}
        groupLabel="Weekday"
        value="mon"
        onChange={() => {}}
      />
    );
    const group = screen.getByRole("radiogroup");
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(7);
    expect(
      radios.map((r) => r.getAttribute("aria-label") ?? r.closest("label")?.textContent)
    ).toEqual(EXPECTED_LABEL_ORDER);
    const names = new Set(radios.map((r) => r.getAttribute("name")));
    expect(names.size).toBe(1);
  });

  it("only the current value is checked", () => {
    render(
      <WeekdayPicker
        mode="single"
        renderAs="radio"
        labels={LABELS}
        groupLabel="Weekday"
        value="wed"
        onChange={() => {}}
      />
    );
    expect(screen.getByRole("radio", { name: "Wed" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Mon" })).not.toBeChecked();
  });

  it("replaces the single value on click, not accumulating a set", () => {
    const onChange = vi.fn();
    render(
      <WeekdayPicker
        mode="single"
        renderAs="radio"
        labels={LABELS}
        groupLabel="Weekday"
        value="mon"
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByRole("radio", { name: "Fri" }));
    expect(onChange).toHaveBeenCalledWith("fri");
    expect(onChange).not.toHaveBeenCalledWith(expect.arrayContaining(["fri"]));
  });

  it("wires testIdPrefix onto each day as `${prefix}-${day}` (H2)", () => {
    render(
      <WeekdayPicker
        mode="single"
        renderAs="radio"
        labels={LABELS}
        groupLabel="Weekday"
        value="mon"
        onChange={() => {}}
        testIdPrefix="meals-recurring-weekday"
      />
    );
    for (const day of EXPECTED_CODE_ORDER) {
      expect(screen.getByTestId(`meals-recurring-weekday-${day}`)).toBeInTheDocument();
    }
  });
});

describe("WeekdayPicker — density", () => {
  it("meets kiosk density in multi mode", async () => {
    const uninject = await injectDensityStyles({
      extraCandidates: ["size-[var(--control-height)]"],
    });
    document.documentElement.setAttribute("data-density", "kiosk");
    try {
      const { container } = render(
        <WeekdayPicker labels={LABELS} groupLabel="Weekdays" value={["mon"]} onChange={() => {}} />
      );
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it('meets kiosk density in single mode (renderAs="select", default)', async () => {
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");
    try {
      const { container } = render(
        <WeekdayPicker
          mode="single"
          labels={LABELS}
          groupLabel="Weekday"
          value="mon"
          onChange={() => {}}
        />
      );
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it('meets kiosk density in single mode (renderAs="radio")', async () => {
    const uninject = await injectDensityStyles({
      extraCandidates: ["size-[var(--control-height)]"],
    });
    document.documentElement.setAttribute("data-density", "kiosk");
    try {
      const { container } = render(
        <WeekdayPicker
          mode="single"
          renderAs="radio"
          labels={LABELS}
          groupLabel="Weekday"
          value="mon"
          onChange={() => {}}
        />
      );
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });
});

describe("WeekdayPicker — radio group isolation", () => {
  it("gives two prefix-less radio pickers DIFFERENT native group names", () => {
    // The props permit omitting testIdPrefix. With a shared fallback name the browser treats two
    // separate radiogroups as ONE native group: selecting in the first clears the second, and
    // arrow keys walk across them. jsdom does not implement that native coupling, so this asserts
    // the mechanism that prevents it — the names must differ.
    render(
      <>
        <WeekdayPicker
          mode="single"
          renderAs="radio"
          labels={LABELS}
          groupLabel="First"
          value="mon"
          onChange={() => {}}
        />
        <WeekdayPicker
          mode="single"
          renderAs="radio"
          labels={LABELS}
          groupLabel="Second"
          value="tue"
          onChange={() => {}}
        />
      </>
    );

    const names = new Set(screen.getAllByRole("radio").map((r) => (r as HTMLInputElement).name));
    expect(names.size).toBe(2);
  });
});

describe("WeekdayPicker — disabledDays", () => {
  it("disables only the listed days in multi mode", () => {
    render(
      <WeekdayPicker
        value={["mon", "tue"]}
        onChange={() => {}}
        labels={{
          mon: "Mon",
          tue: "Tue",
          wed: "Wed",
          thu: "Thu",
          fri: "Fri",
          sat: "Sat",
          sun: "Sun",
        }}
        groupLabel="Days"
        disabledDays={["tue", "sun"]}
        testIdPrefix="picker"
      />
    );
    expect(screen.getByTestId("picker-tue")).toBeDisabled();
    expect(screen.getByTestId("picker-sun")).toBeDisabled();
    expect(screen.getByTestId("picker-mon")).toBeEnabled();
    expect(screen.getByTestId("picker-tue")).toBeChecked();
  });
});
