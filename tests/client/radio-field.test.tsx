/** RadioField spec (FR-005 — Wiring).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RadioField } from "@/components/RadioField";
import { assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-density");
});

describe("RadioField", () => {
  it("associates the label with the radio by wrapping it, and shares the group name", () => {
    render(
      <>
        <RadioField name="weekday" value="mon" checked={false} onChange={() => {}} label="Mon" />
        <RadioField name="weekday" value="tue" checked onChange={() => {}} label="Tue" />
      </>
    );
    const mon = screen.getByRole("radio", { name: "Mon" });
    const tue = screen.getByRole("radio", { name: "Tue" });
    expect(mon).toHaveAttribute("name", "weekday");
    expect(tue).toHaveAttribute("name", "weekday");
    expect(mon).not.toBeChecked();
    expect(tue).toBeChecked();
  });

  it("calls onChange with its own value on click", () => {
    const onChange = vi.fn();
    render(
      <RadioField name="weekday" value="wed" checked={false} onChange={onChange} label="Wed" />
    );
    fireEvent.click(screen.getByRole("radio", { name: "Wed" }));
    expect(onChange).toHaveBeenCalledWith("wed");
  });

  it("deliberate negative — each field reports ITS OWN value, never a sibling's", () => {
    const onChangeMon = vi.fn();
    const onChangeTue = vi.fn();
    render(
      <>
        <RadioField name="weekday" value="mon" checked={false} onChange={onChangeMon} label="Mon" />
        <RadioField name="weekday" value="tue" checked={false} onChange={onChangeTue} label="Tue" />
      </>
    );
    fireEvent.click(screen.getByRole("radio", { name: "Tue" }));
    expect(onChangeTue).toHaveBeenCalledWith("tue");
    expect(onChangeMon).not.toHaveBeenCalled();
  });

  it("meets kiosk density", async () => {
    const uninject = await injectDensityStyles({
      extraCandidates: ["size-[var(--control-height)]"],
    });
    document.documentElement.setAttribute("data-density", "kiosk");
    try {
      const { container } = render(
        <RadioField name="weekday" value="fri" checked={false} onChange={() => {}} label="Fri" />
      );
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });
});
