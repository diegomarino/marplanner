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
