/** ConfirmDialog spec (FR-005/FR-008 — Wiring + Accessibility).
 * The second half of this file is the executable proof for DP2/FR-008: a toggle's constructive
 * direction (completing) stays a single, ungated tap; only the destructive direction (undoing a
 * completed chore) opens this dialog. It models the exact wiring `StatusToggle` +
 * `ConfirmDialog` are meant to compose into ( wires this into the real `ChoresBoard`; this
 * test proves the pattern the two shared components enable, not ChoresBoard itself, which is out
 * of this test’s scope).
 */
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { StatusToggle } from "@/components/StatusToggle";
import { assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-density");
});

describe("ConfirmDialog", () => {
  it("renders nothing when closed", () => {
    render(
      <ConfirmDialog
        open={false}
        onOpenChange={() => {}}
        title="Undo this completed chore?"
        confirmLabel="Undo"
        cancelLabel="Cancel"
        onConfirm={() => {}}
      />
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders the title, description and both actions when open", () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Undo this completed chore?"
        description="This clears today's completion for this chore."
        confirmLabel="Undo"
        cancelLabel="Cancel"
        onConfirm={() => {}}
      />
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Undo this completed chore?");
    expect(dialog).toHaveTextContent("This clears today's completion for this chore.");
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("calls onConfirm and closes when the confirm action is pressed", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Undo this completed chore?"
        confirmLabel="Undo"
        cancelLabel="Cancel"
        onConfirm={onConfirm}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("deliberate negative — cancel closes WITHOUT calling onConfirm", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Undo this completed chore?"
        confirmLabel="Undo"
        cancelLabel="Cancel"
        onConfirm={onConfirm}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("meets kiosk density", async () => {
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");
    try {
      render(
        <ConfirmDialog
          open
          onOpenChange={() => {}}
          title="Undo this completed chore?"
          confirmLabel="Undo"
          cancelLabel="Cancel"
          onConfirm={() => {}}
        />
      );
      // Asserted against document.body, not a local `container`: DialogContent portals outside
      // the render container (Radix mounts to document.body) — the exact "outside the page
      // subtree" case FR-001/SC-003 exist to cover, and asserting on `container` here would
      // silently see zero controls and throw for the wrong reason.
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });
});

/** DP2/FR-008: models the chore-toggle wiring — complete is one tap, un-complete is guarded. */
function ChoreToggleDemo() {
  const [completed, setCompleted] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  function handlePress() {
    if (completed) {
      // Destructive direction (undo) — guarded.
      setConfirmOpen(true);
    } else {
      // Constructive direction (complete) — one tap, never gated.
      setCompleted(true);
    }
  }

  return (
    <>
      <StatusToggle
        pressed={completed}
        label="Wash dishes"
        // A chore's own name is already state-invariant (unlike meals' "Deactivate"/"Activate"),
        // so the accessible name matches `label` unchanged rather than inventing a state-shaped
        // string — see StatusToggle's own doc comment (this is required by the component contract).
        accessibleName="Wash dishes"
        onPress={handlePress}
      />
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Undo this completed chore?"
        confirmLabel="Undo"
        cancelLabel="Cancel"
        onConfirm={() => setCompleted(false)}
      />
    </>
  );
}

describe("ConfirmDialog + StatusToggle — DP2/FR-008 one-direction guard", () => {
  it("completing (constructive direction) is a single tap: no dialog opens", () => {
    render(<ChoreToggleDemo />);
    const toggle = screen.getByRole("button", { name: "Wash dishes" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("un-completing (destructive direction) is guarded: the dialog opens and confirming is required", () => {
    render(<ChoreToggleDemo />);
    const toggle = screen.getByRole("button", { name: "Wash dishes" });
    fireEvent.click(toggle); // complete — ungated
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(toggle); // attempt to un-complete — must be guarded
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // Still completed — the dialog intercepted the transition, it did not happen yet.
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  it("deliberate negative — cancelling the guard leaves the chore completed", () => {
    render(<ChoreToggleDemo />);
    const toggle = screen.getByRole("button", { name: "Wash dishes" });
    fireEvent.click(toggle); // complete
    fireEvent.click(toggle); // attempt undo -> dialog opens
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });
});

// on): with no `DialogTrigger` (this dialog is always
// wired via a controlled `open` prop, per the file header), Radix has nothing of its own to
// restore focus to on close — without the fix, `document.activeElement` becomes `BODY`. On a
// keyboard-operated kiosk that loses the user's place (SC-012 is whole-product).
describe("ConfirmDialog — focus returns to the control that opened it on close (MEDIUM-2)", () => {
  it("cancelling returns focus to the toggle, not document.body", async () => {
    render(<ChoreToggleDemo />);
    const toggle = screen.getByRole("button", { name: "Wash dishes" });
    toggle.focus();
    fireEvent.click(toggle); // complete
    toggle.focus();
    fireEvent.click(toggle); // attempt undo -> dialog opens
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Radix runs its close-autofocus restoration asynchronously (past this same tick) — wait
    // for it rather than asserting the instant fireEvent.click returns.
    await waitFor(() => expect(document.activeElement).toBe(toggle));
  });

  it("confirming also returns focus to the toggle, not document.body", async () => {
    render(<ChoreToggleDemo />);
    const toggle = screen.getByRole("button", { name: "Wash dishes" });
    toggle.focus();
    fireEvent.click(toggle); // complete
    toggle.focus();
    fireEvent.click(toggle); // attempt undo -> dialog opens

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(toggle));
  });
});
