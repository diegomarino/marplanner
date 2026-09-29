/** ChoreOrderControls spec (FR-009).
 * (independent): this file's verification policy ("calls the frozen
 * assertion over that surface's rendered control set with kiosk density active, in its OWN
 * per-surface spec") was satisfied for `ChoresBoard.tsx` but NOT for `ChoreOrderControls.tsx` —
 * `rg ChoreOrderControls tests/` returned zero hits before this file existed. Mutation M14
 * (deleting the `Button` import and reverting all five controls to raw `<button>`s with no
 * density classes) shipped green because nothing here rendered the component at all. This file
 * closes that gap: it renders BOTH of the component's two states — the collapsed "Reorder" link
 * (one control) and the expanded edit view (five: two move buttons per chore row plus Save/
 * Cancel, with two chores) — and calls the frozen density assertion over each, with a deliberate
 * negative proving it can fail on this surface's own controls.
 * (same): a failed order PUT used to be `log`-ed with no visible/announced
 * error. `ChoreOrderControls.tsx` now renders an `ErrorNotice` on that path — covered below.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/i18n";
import { ChoreOrderControls } from "@/admin/ChoreOrderControls";
import { DensityViolationError, assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

// Same house pattern as tests/client/time-announcements-management.test.tsx — a fixed English
// household language, resolved synchronously, no real /api/settings fetch/timing dependency.
vi.mock("@/lib/householdSettings", () => ({
  useHouseholdSettings: () => ({ timezone: "Europe/Madrid", language: "en", weekStartDay: 1 }),
  useHouseholdSettingsContext: () => ({
    timezone: "Europe/Madrid",
    language: "en",
    weekStartDay: 1,
  }),
}));

type FetchCall = Parameters<typeof globalThis.fetch>;

const CHORES = [
  { id: "c1", name: "Brush teeth" },
  { id: "c2", name: "Make bed" },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status });
}

function renderSurface(onReorder = vi.fn()) {
  const utils = render(
    <LanguageProvider>
      <ChoreOrderControls routineId="r1" chores={CHORES} onReorder={onReorder} />
    </LanguageProvider>
  );
  return { ...utils, onReorder };
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  document.documentElement.removeAttribute("data-density");
});

describe("ChoreOrderControls — kiosk density (SC-001, SC-002, SC-003)", () => {
  it("meets kiosk density in BOTH states — the collapsed Reorder link and the expanded edit view", async () => {
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = renderSurface();

      // Phase 1 — collapsed: one control (the "Reorder" link button).
      expect(container.querySelectorAll("button").length).toBe(1);
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();

      // Phase 2 — expanded: two chores * (move-up + move-down) + Save + Cancel = 6.
      fireEvent.click(screen.getByRole("button", { name: "Reorder" }));
      expect(container.querySelectorAll("button").length).toBe(6);
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("DELIBERATE NEGATIVE — forcing this surface's own Save button below the kiosk minimum makes the assertion fail", async () => {
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = renderSurface();
      fireEvent.click(screen.getByRole("button", { name: "Reorder" }));
      const saveButton = screen.getByRole("button", { name: "Save Order" });

      // A real control from this surface, not a synthetic fixture.
      (saveButton as HTMLElement).style.height = "10px";
      (saveButton as HTMLElement).style.fontSize = "8px";

      let thrown: unknown;
      try {
        assertKioskDensityCompliant(container);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(DensityViolationError);
      const message = (thrown as DensityViolationError).message;
      expect(message).toMatch(/height 10px is below the kiosk minimum 48px/);
      expect(message).toMatch(/font-size 8px is below the kiosk minimum 18px/);
    } finally {
      uninject();
    }
  });
});

describe("ChoreOrderControls — reorder wiring (research.md R3)", () => {
  it("move-up/move-down reorder the LOCAL list before saving, with no fetch until Save", () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    renderSurface();

    fireEvent.click(screen.getByRole("button", { name: "Reorder" }));
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["Brush teeth↑↓", "Make bed↑↓"]);

    fireEvent.click(screen.getAllByRole("button", { name: "Move down" })[0]);
    const reordered = screen.getAllByRole("listitem");
    expect(reordered.map((li) => li.textContent)).toEqual(["Make bed↑↓", "Brush teeth↑↓"]);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("Save persists the new order via PUT and calls onReorder with it; the panel collapses", async () => {
    const mockFetch = vi.fn((..._args: FetchCall) => Promise.resolve(jsonResponse(null, 204)));
    vi.stubGlobal("fetch", mockFetch);
    const { onReorder } = renderSurface();

    fireEvent.click(screen.getByRole("button", { name: "Reorder" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Move down" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Save Order" }));

    await waitFor(() => expect(onReorder).toHaveBeenCalledWith(["c2", "c1"]));
    expect(
      (mockFetch.mock.calls as FetchCall[]).filter(
        ([reqInput, init]) =>
          String(reqInput) === "/api/routines/r1/chores/order" && init?.method === "PUT"
      )
    ).toHaveLength(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "Reorder" })).toBeVisible());
  });

  it("Cancel discards the local reorder — no fetch, order reverts, panel collapses", () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    renderSurface();

    fireEvent.click(screen.getByRole("button", { name: "Reorder" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Move down" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(mockFetch).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Reorder" })).toBeVisible();

    // Re-opening shows the ORIGINAL order — the local reorder was discarded, not persisted.
    fireEvent.click(screen.getByRole("button", { name: "Reorder" }));
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Brush teeth↑↓",
      "Make bed↑↓",
    ]);
  });
});

describe("ChoreOrderControls — a failed save is announced (SC-011, MEDIUM-1)", () => {
  it("announces a failed order PUT through ErrorNotice's live region and stays in edit mode", async () => {
    const mockFetch = vi.fn(() => Promise.resolve(jsonResponse(null, 500)));
    vi.stubGlobal("fetch", mockFetch);
    const { onReorder } = renderSurface();

    fireEvent.click(screen.getByRole("button", { name: "Reorder" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Order" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to save the new order. Please try again.");
    expect(alert).toHaveAttribute("aria-live", "assertive");

    // The failure does not collapse the panel or call onReorder.
    expect(screen.getByRole("button", { name: "Save Order" })).toBeVisible();
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("starting a fresh edit, or cancelling, clears a previous save error", async () => {
    const mockFetch = vi.fn(() => Promise.resolve(jsonResponse(null, 500)));
    vi.stubGlobal("fetch", mockFetch);
    renderSurface();

    fireEvent.click(screen.getByRole("button", { name: "Reorder" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Order" }));
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Reorder" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
