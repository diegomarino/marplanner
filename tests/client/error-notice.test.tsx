/** ErrorNotice spec (FR-006, SC-011).
 * SC-011 is "100% of error states across migrated surfaces are announced to assistive
 * technology" — this file is the executable proof that the live region this component renders
 * actually behaves like one: it is present with the right role/politeness, its text updates on a
 * re-render (not a static one-time mount), and it disappears when the error clears. A
 * `role="alert"` attribute nobody exercised proves nothing (the component contract) — every assertion below
 * targets the wiring, not just its presence.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Button } from "@/components/ui/button";
import { ErrorNotice } from "@/components/ErrorNotice";
import { assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-density");
});

describe("ErrorNotice", () => {
  it("renders nothing when there is no message", () => {
    const { container } = render(<ErrorNotice message={null} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("announces the message via a role=alert, aria-live=assertive live region by default", () => {
    render(<ErrorNotice message="Failed to load members." />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Failed to load members.");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(alert).toHaveAttribute("aria-atomic", "true");
  });

  it("supports a polite live region for non-blocking notices", () => {
    render(<ErrorNotice message="Saved with warnings." politeness="polite" />);
    expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "polite");
  });

  it("updates the announced text on a re-render — proves this is a dynamic live region, not a static mount", () => {
    const { rerender } = render(<ErrorNotice message="First error." />);
    expect(screen.getByRole("alert")).toHaveTextContent("First error.");

    rerender(<ErrorNotice message="Second, different error." />);
    expect(screen.getByRole("alert")).toHaveTextContent("Second, different error.");
    expect(screen.queryByText("First error.")).not.toBeInTheDocument();
  });

  it("removes the live region entirely once the error clears — deliberate negative: a stale error notice would fail this", () => {
    const { rerender } = render(<ErrorNotice message="Transient failure." />);
    expect(screen.getByRole("alert")).toBeInTheDocument();

    rerender(<ErrorNotice message={null} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("wires a caller-supplied id onto the live region so a Field's aria-describedby can reach it", () => {
    render(<ErrorNotice id="my-field-error" message="Required." />);
    expect(screen.getByRole("alert")).toHaveAttribute("id", "my-field-error");
  });

  it("meets kiosk density alongside a real control (this component itself renders no interactive control)", async () => {
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");
    try {
      const { container } = render(
        <>
          <ErrorNotice message="Could not save." />
          <Button>Retry</Button>
        </>
      );
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });
});
