import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DensityControl } from "@/shell/DensityControl";
import {
  applyStoredDensity,
  COMFORTABLE_DENSITY,
  DENSITY_ATTRIBUTE,
  KIOSK_DENSITY,
} from "@/shell/densityAttribute";
import { HouseholdSettingsProvider } from "@/lib/householdSettings";
import { LanguageProvider } from "@/i18n";
import { DensityViolationError, assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

/** Spec for `src/client/shell/DensityControl.tsx` (FR-002/FR-002a).
 * Before this control existed, nothing in production called
 * `setDensity`, so kiosk density was unreachable by any user. This file proves the
 * control actually reaches it: per-device persistence round-trip, the fresh-device
 * default, both locales. Await locale resolution because `/api/settings` can race the initial
 * render. These tests also cover the `StatusToggle` accessible name and kiosk-density
 * compliance across both densities, including a deliberate negative case.
 * `DENSITY_STORAGE_KEY` below mirrors the PRIVATE literal `densityAttribute.ts` keeps
 * unexported (`"marplanner:density"`) — the same "duplicate the frozen file's own
 * selector/constant rather than exporting a test-only seam" convention
 * `family-surfaces.test.tsx`/`chores-board.test.tsx` already use for
 * `CENSUS_CONTROL_SELECTOR`.
 */
const DENSITY_STORAGE_KEY = "marplanner:density";

/** Mirrors `helpers/density.ts`'s own selector — see its sibling specs for why this is
 * duplicated rather than imported (the frozen file exposes no census API by design). */
const CENSUS_CONTROL_SELECTOR = [
  "button",
  "input",
  "select",
  "textarea",
  "a[href]",
  '[role="button"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="option"]',
  '[role="tab"]',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function countInteractiveControls(container: Document | Element): number {
  return container.querySelectorAll(CENSUS_CONTROL_SELECTOR).length;
}

function settingsResponse(language: string): Response {
  return new Response(JSON.stringify({ locale: { timezone: "UTC", language, weekStartDay: 1 } }), {
    status: 200,
  });
}

function renderLocalized(language: string) {
  const mockFetch = vi.fn(() => Promise.resolve(settingsResponse(language)));
  vi.stubGlobal("fetch", mockFetch);
  return render(
    <HouseholdSettingsProvider>
      <LanguageProvider>
        <DensityControl />
      </LanguageProvider>
    </HouseholdSettingsProvider>
  );
}

function resetDensityState() {
  window.localStorage.clear();
  document.documentElement.removeAttribute(DENSITY_ATTRIBUTE);
}

describe("DensityControl (T010, FR-002/FR-002a)", () => {
  beforeEach(() => {
    resetDensityState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetDensityState();
    cleanup();
  });

  it("fresh device: empty localStorage + boot's applyStoredDensity() renders unpressed/comfortable", () => {
    // Mirrors the real boot order (main.tsx): applyStoredDensity runs BEFORE the app
    // renders. With nothing ever stored, it leaves the attribute absent (comfortable) —
    // the control must read exactly that state, not assume it.
    applyStoredDensity();
    expect(document.documentElement.hasAttribute(DENSITY_ATTRIBUTE)).toBe(false);

    render(<DensityControl />);

    const toggle = screen.getByTestId("density-control-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveTextContent("Turn on kiosk mode");
    expect(toggle).toHaveAccessibleName("Kiosk mode");
  });

  it("persistence round-trip: tap -> kiosk persisted + attribute set; tap again -> comfortable + attribute removed", () => {
    render(<DensityControl />);
    const toggle = screen.getByTestId("density-control-toggle");

    fireEvent.click(toggle);

    expect(window.localStorage.getItem(DENSITY_STORAGE_KEY)).toBe(KIOSK_DENSITY);
    expect(document.documentElement.getAttribute(DENSITY_ATTRIBUTE)).toBe(KIOSK_DENSITY);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveTextContent("Turn off kiosk mode");

    fireEvent.click(toggle);

    expect(window.localStorage.getItem(DENSITY_STORAGE_KEY)).toBe(COMFORTABLE_DENSITY);
    expect(document.documentElement.hasAttribute(DENSITY_ATTRIBUTE)).toBe(false);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveTextContent("Turn on kiosk mode");
  });

  it("does not affect any other device — only writes THIS device's localStorage/attribute, never a network call", () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    render(<DensityControl />);
    fireEvent.click(screen.getByTestId("density-control-toggle"));

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("StatusToggle state-invariant accessible-name doctrine (#763): the accessible name never changes across a press, only aria-pressed and the visible action label do", () => {
    render(<DensityControl />);
    const toggle = screen.getByTestId("density-control-toggle");

    expect(toggle).toHaveAccessibleName("Kiosk mode");
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(toggle);

    // Same accessible name, unpressed -> pressed via aria-pressed alone, visible text flips.
    expect(toggle).toHaveAccessibleName("Kiosk mode");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveTextContent("Turn off kiosk mode");
  });

  describe("localized labels (both locales) — awaited, the /api/settings race", () => {
    it("renders English ('Kiosk mode' / 'Turn on kiosk mode') once the settings fetch resolves", async () => {
      renderLocalized("en");

      // findByRole, not getByRole: the household-settings fetch is async, so a synchronous
      // query would flake against the pre-fetch English-fallback render landing first —
      // findByRole retries until it settles (the same fix routines.test.tsx/
      // announcements-briefing-admin.test.tsx already document for this exact race).
      const toggle = await screen.findByRole("button", { name: "Kiosk mode" });
      expect(toggle).toHaveTextContent("Turn on kiosk mode");
    });

    it("renders Spanish ('Modo kiosco' / 'Activar modo kiosco') once the settings fetch resolves", async () => {
      renderLocalized("es");

      const toggle = await screen.findByRole("button", { name: "Modo kiosco" });
      expect(toggle).toHaveTextContent("Activar modo kiosco");
    });

    it("Spanish, pressed: accessible name stays 'Modo kiosco', visible label flips to 'Desactivar modo kiosco'", async () => {
      renderLocalized("es");

      const toggle = await screen.findByRole("button", { name: "Modo kiosco" });
      fireEvent.click(toggle);

      expect(toggle).toHaveAccessibleName("Modo kiosco");
      expect(toggle).toHaveTextContent("Desactivar modo kiosco");
    });
  });

  describe("kiosk-density census (SC-001, SC-002) — across both densities", () => {
    it("comfortable density: exactly one control, the toggle itself", () => {
      document.documentElement.removeAttribute(DENSITY_ATTRIBUTE);
      const { container } = render(<DensityControl />);

      expect(countInteractiveControls(container)).toBe(1);
    });

    it("kiosk density active: exactly one control, and it MEASURES COMPLIANT (built on Button/T004, token-clean by construction)", async () => {
      const uninject = await injectDensityStyles();
      document.documentElement.setAttribute(DENSITY_ATTRIBUTE, KIOSK_DENSITY);

      try {
        const { container } = render(<DensityControl />);

        expect(countInteractiveControls(container)).toBe(1);
        expect(() => assertKioskDensityCompliant(container)).not.toThrow();
      } finally {
        uninject();
      }
    });

    it("DELIBERATE NEGATIVE — forcing the toggle below the kiosk minimum makes the assertion fail", async () => {
      const uninject = await injectDensityStyles();
      document.documentElement.setAttribute(DENSITY_ATTRIBUTE, KIOSK_DENSITY);

      try {
        const { container } = render(<DensityControl />);
        const toggle = screen.getByTestId("density-control-toggle");

        // An explicit inline `height` always wins over `resolveControlHeightPx`'s min-height
        // fallback (density.ts's own precedence) — the real control here uses Button's
        // explicit `h-[var(--control-height)]` token class, never min-height, so overriding
        // `height` directly (rather than `minHeight`) is what a genuine regression of THIS
        // control's own sizing would look like.
        toggle.style.height = "10px";
        toggle.style.fontSize = "8px";

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
});

describe("DensityControl — cross-tab synchronization (Codex review, FR-002 per-device)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    resetDensityState();
  });

  it("another tab's density change (a `storage` event) re-applies the attribute and updates the pressed state", async () => {
    resetDensityState();
    renderLocalized("en");
    const toggle = await screen.findByRole("button", { name: "Kiosk mode" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    // Simulate tab B choosing kiosk: localStorage already updated THERE; this tab only ever
    // receives the storage event (which fires in OTHER tabs, never the writer).
    window.localStorage.setItem("marplanner:density", "kiosk");
    fireEvent(
      window,
      new StorageEvent("storage", { key: "marplanner:density", newValue: "kiosk" })
    );

    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-density")).toBe("kiosk");
      expect(toggle).toHaveAttribute("aria-pressed", "true");
    });

    // And back: tab B returns to comfortable.
    window.localStorage.setItem("marplanner:density", "comfortable");
    fireEvent(
      window,
      new StorageEvent("storage", { key: "marplanner:density", newValue: "comfortable" })
    );

    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-density")).toBeNull();
      expect(toggle).toHaveAttribute("aria-pressed", "false");
    });
  });

  it("an unrelated key's storage event does NOT touch density", async () => {
    resetDensityState();
    renderLocalized("en");
    const toggle = await screen.findByRole("button", { name: "Kiosk mode" });

    window.localStorage.setItem("marplanner:density", "kiosk");
    fireEvent(window, new StorageEvent("storage", { key: "some:other:key", newValue: "x" }));

    // The density key changed in storage, but the EVENT was for another key — the listener
    // must not react (and must certainly not read unrelated events as density flips).
    expect(document.documentElement.getAttribute("data-density")).toBeNull();
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });
});
