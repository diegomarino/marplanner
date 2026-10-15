import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChoicePills, type ChoicePillsOption } from "@/components/ChoicePills";
import { assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-density");
});

type Kind = "scheduled" | "calendar_gated";
const OPTIONS: ChoicePillsOption<Kind>[] = [
  { value: "scheduled", label: "Scheduled", "data-testid": "kind-scheduled" },
  { value: "calendar_gated", label: "Calendar-gated", "data-testid": "kind-gated" },
];

describe("ChoicePills", () => {
  it("is a radiogroup named by groupLabel, options in order, only the value checked", () => {
    render(
      <ChoicePills value="scheduled" onChange={() => {}} options={OPTIONS} groupLabel="Kind" />
    );
    const group = screen.getByRole("radiogroup", { name: "Kind" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.closest("label")?.textContent)).toEqual([
      "Scheduled",
      "Calendar-gated",
    ]);
    expect(screen.getByRole("radio", { name: "Scheduled" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Calendar-gated" })).not.toBeChecked();
  });

  it("checks nothing when value is null", () => {
    render(<ChoicePills value={null} onChange={() => {}} options={OPTIONS} groupLabel="Kind" />);
    for (const radio of screen.getAllByRole("radio")) expect(radio).not.toBeChecked();
  });

  it("emits the clicked option's value and puts testids on the inputs", () => {
    const onChange = vi.fn();
    render(
      <ChoicePills value="scheduled" onChange={onChange} options={OPTIONS} groupLabel="Kind" />
    );
    fireEvent.click(screen.getByTestId("kind-gated"));
    expect(onChange).toHaveBeenCalledWith("calendar_gated");
  });

  it("disables the whole group or a single option", () => {
    const { rerender } = render(
      <ChoicePills
        value="scheduled"
        onChange={() => {}}
        options={[OPTIONS[0], { ...OPTIONS[1], disabled: true }]}
        groupLabel="Kind"
      />
    );
    expect(screen.getByTestId("kind-scheduled")).toBeEnabled();
    expect(screen.getByTestId("kind-gated")).toBeDisabled();
    rerender(
      <ChoicePills
        value="scheduled"
        onChange={() => {}}
        options={OPTIONS}
        groupLabel="Kind"
        disabled
      />
    );
    expect(screen.getByTestId("kind-scheduled")).toBeDisabled();
  });

  it("gives two groups different native names", () => {
    render(
      <>
        <ChoicePills value="scheduled" onChange={() => {}} options={OPTIONS} groupLabel="A" />
        <ChoicePills value="scheduled" onChange={() => {}} options={OPTIONS} groupLabel="B" />
      </>
    );
    const names = within(screen.getByRole("radiogroup", { name: "A" }))
      .getAllByRole("radio")
      .map((r) => (r as HTMLInputElement).name);
    const other = within(screen.getByRole("radiogroup", { name: "B" }))
      .getAllByRole("radio")
      .map((r) => (r as HTMLInputElement).name);
    expect(new Set(names).size).toBe(1);
    expect(names[0]).not.toBe(other[0]);
  });

  it("meets kiosk density", async () => {
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");
    try {
      const { container } = render(
        <ChoicePills value="scheduled" onChange={() => {}} options={OPTIONS} groupLabel="Kind" />
      );
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });
});
