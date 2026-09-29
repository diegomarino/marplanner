/** StatusToggle spec (FR-005 — Accessibility).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StatusToggle } from "@/components/StatusToggle";
import { assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-density");
});

describe("StatusToggle", () => {
  it("wires aria-pressed to the pressed prop", () => {
    const { rerender } = render(
      <StatusToggle
        pressed={false}
        label="Mark done"
        accessibleName="Mark done"
        onPress={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: "Mark done" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );

    rerender(
      <StatusToggle pressed label="Mark done" accessibleName="Mark done" onPress={() => {}} />
    );
    expect(screen.getByRole("button", { name: "Mark done" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("calls onPress on click", () => {
    const onPress = vi.fn();
    render(
      <StatusToggle
        pressed={false}
        label="Mark done"
        accessibleName="Mark done"
        onPress={onPress}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark done" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("busy sets aria-busy and disables the control, guarding against a double tap", () => {
    const onPress = vi.fn();
    render(
      <StatusToggle
        pressed={false}
        label="Mark done"
        accessibleName="Mark done"
        onPress={onPress}
        busy
      />
    );
    const button = screen.getByRole("button", { name: "Mark done" });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toBeDisabled();
  });

  it("deliberate negative — not busy means aria-busy is absent, not merely false-ish", () => {
    render(
      <StatusToggle
        pressed={false}
        label="Mark done"
        accessibleName="Mark done"
        onPress={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: "Mark done" })).not.toHaveAttribute("aria-busy");
  });

  it("forwards `wrap` to the underlying Button (kills M7's static blindness, PR #782 independent review)", () => {
    // M7: a mutant that drops `wrap={wrap}` from StatusToggle's
    // forward to `Button` is caught ONLY by one e2e test on one surface (`ChoresBoard.tsx`) —
    // `tsc -b`, `eslint`, and all 602 pre-existing unit tests stayed green. This unit test closes
    // that static blindness: it fails immediately, with no browser, if the forward is dropped.
    const { rerender } = render(
      <StatusToggle
        pressed={false}
        label="A user-authored chore name"
        accessibleName="A user-authored chore name"
        onPress={() => {}}
        wrap
      />
    );
    const wrappedButton = screen.getByRole("button", { name: "A user-authored chore name" });
    expect(wrappedButton.className).toMatch(/\bwhitespace-normal\b/);
    expect(wrappedButton.className).toMatch(/\bwrap-anywhere\b/);
    expect(wrappedButton.className).not.toMatch(/\bwhitespace-nowrap\b/);

    rerender(
      <StatusToggle
        pressed={false}
        label="A user-authored chore name"
        accessibleName="A user-authored chore name"
        onPress={() => {}}
        wrap={false}
      />
    );
    const nowrapButton = screen.getByRole("button", { name: "A user-authored chore name" });
    expect(nowrapButton.className).toMatch(/\bwhitespace-nowrap\b/);
    expect(nowrapButton.className).not.toMatch(/\bwhitespace-normal\b/);
  });

  it("meets kiosk density", async () => {
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");
    try {
      const { container } = render(
        <StatusToggle
          pressed={false}
          label="Mark done"
          accessibleName="Mark done"
          onPress={() => {}}
        />
      );
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });
});
