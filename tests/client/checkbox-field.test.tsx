/** CheckboxField spec (FR-005 — Wiring).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CheckboxField } from "@/components/CheckboxField";
import { assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-density");
});

describe("CheckboxField", () => {
  it("associates the label with the checkbox by wrapping it", () => {
    render(<CheckboxField checked={false} onChange={() => {}} label="Active" />);
    const checkbox = screen.getByRole("checkbox", { name: "Active" });
    expect(checkbox).not.toBeChecked();
  });

  it("reflects the checked prop", () => {
    render(<CheckboxField checked onChange={() => {}} label="Active" />);
    expect(screen.getByRole("checkbox", { name: "Active" })).toBeChecked();
  });

  it("calls onChange with the new checked value on click", () => {
    const onChange = vi.fn();
    render(<CheckboxField checked={false} onChange={onChange} label="Active" />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Active" }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("deliberate negative — reports the ACTUAL next state (false when currently checked), not a hardcoded value", () => {
    const onChange = vi.fn();
    render(<CheckboxField checked onChange={onChange} label="Active" />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Active" }));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("renders the disabled attribute when disabled is set", () => {
    render(<CheckboxField checked={false} onChange={() => {}} label="Active" disabled />);
    expect(screen.getByRole("checkbox", { name: "Active" })).toBeDisabled();
  });

  it("meets kiosk density", async () => {
    const uninject = await injectDensityStyles({
      extraCandidates: ["size-[var(--control-height)]"],
    });
    document.documentElement.setAttribute("data-density", "kiosk");
    try {
      const { container } = render(
        <CheckboxField checked={false} onChange={() => {}} label="Active" />
      );
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("keeps a hidden label as the accessible name when labelHidden is set", () => {
    render(
      <CheckboxField checked={false} onChange={() => {}} label="Weather on Mon" labelHidden />
    );
    const checkbox = screen.getByRole("checkbox", { name: "Weather on Mon" });
    expect(checkbox.closest("label")?.querySelector(".sr-only")?.textContent).toBe(
      "Weather on Mon"
    );
  });
});
