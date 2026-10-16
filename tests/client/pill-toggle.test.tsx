import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PillToggle } from "@/components/PillToggle";
import { assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-density");
});

describe("PillToggle", () => {
  it("is a native checkbox named by its label and reports the new state", () => {
    const onChange = vi.fn();
    render(<PillToggle checked={false} onChange={onChange} label="Dinner" />);

    const checkbox = screen.getByRole("checkbox", { name: "Dinner" });
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("does not report a change while disabled", () => {
    const onChange = vi.fn();
    render(<PillToggle checked={false} onChange={onChange} label="Dinner" disabled />);

    expect(screen.getByRole("checkbox", { name: "Dinner" })).toBeDisabled();
  });

  it("draws a coloured pill from the caller's colour class and reserves its bold width", () => {
    render(
      <PillToggle
        checked
        onChange={vi.fn()}
        label="School lunches"
        colorClassName="meal-origin-pill meal-origin-plan-2"
      />
    );
    const checkbox = screen.getByRole("checkbox", { name: "School lunches" });
    const pill = checkbox.closest("label") as HTMLElement;
    expect(pill).toHaveClass(
      "meal-origin-pill",
      "meal-origin-plan-2",
      "has-[:checked]:bg-[var(--pill-color-selected)]",
      "has-[:checked]:border-[var(--pill-color)]",
      "has-[:checked]:font-semibold",
      "bg-muted"
    );
    expect(pill).not.toHaveClass("has-[:checked]:bg-accent");
    expect(pill.querySelector('[data-text="School lunches"]')).not.toBeNull();
  });

  it("keeps the plain accent pill when no colour class is given", () => {
    render(<PillToggle checked onChange={vi.fn()} label="Dinner" />);
    const pill = screen.getByRole("checkbox", { name: "Dinner" }).closest("label") as HTMLElement;
    expect(pill).toHaveClass("has-[:checked]:bg-accent");
    expect(pill.querySelector("[data-text]")).toBeNull();
  });

  it("meets kiosk density: the hidden checkbox spans the full control height", async () => {
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");
    try {
      const { container } = render(<PillToggle checked onChange={vi.fn()} label="Dinner" />);
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });
});
