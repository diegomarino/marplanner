import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminGate } from "@/admin/AdminGate";
import type { HouseholdSettingsValue } from "@/lib/householdSettings";

/** FR-013 (233) splits the behavior in two: family-facing surfaces HIDE
 * (`PrintExecutor`, `tests/client/printing-executor-fr013.test.tsx`); the ADMIN surface instead
 * SAYS SO — it stays visible, and `PrintingManagement`'s own trigger already communicates
 * `pluginInactive` on a 409 (`tests/client/printing-management.test.tsx`'s * "test-print trigger: plugin-inactive (409) shows that message distinctly" case).
 * ARCHITECT DECISION: hiding `admin-nav-printing`
 * was wrong — it made that pluginInactive branch unreachable from the admin surface, the exact
 * dead-code class itself was filed to close. This file previously asserted the OPPOSITE
 * (nav hidden when inactive); flipped here to assert admin visibility is unconditional.
 * Uses the same `unlocked: true` + household-settings mocking convention as
 * `admin-gate-panel-reset.test.tsx`.
 */
vi.mock("@/lib/adminUnlock", () => ({
  isAdminPinBypassEnabled: () => false,
  useAdminUnlock: () => ({ unlocked: true, setUnlocked: vi.fn() }),
}));

const MOCK_SETTINGS = {
  timezone: "Europe/Madrid",
  language: "en",
  weekStartDay: 1,
  weatherLat: null,
  weatherLon: null,
  weatherLabel: null,
} satisfies HouseholdSettingsValue;

vi.mock("@/lib/householdSettings", () => ({
  useHouseholdSettings: () => MOCK_SETTINGS,
  useHouseholdSettingsContext: () => MOCK_SETTINGS,
}));

describe("AdminGate — admin-nav-printing stays visible regardless of plugin state (FR-013)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("renders admin-nav-printing immediately — no async gate, no /api/printing/status read at all", () => {
    const mockFetch = vi.fn((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(new Response(JSON.stringify([]), { status: 200 }))
    );
    vi.stubGlobal("fetch", mockFetch);

    render(<AdminGate />);

    // Synchronous — AdminGate no longer reads printing-plugin state to decide this button's
    // visibility (that would make PrintingManagement's own pluginInactive messaging
    // unreachable, the dead-code class this file guards against).
    expect(screen.getByTestId("admin-nav-printing")).toBeInTheDocument();
    expect(
      mockFetch.mock.calls.some((call) => String(call[0]).includes("/api/printing/status"))
    ).toBe(false);
  });

  it("stays visible even if something else on the page has independently read active: false", () => {
    // Even a stray active:false response elsewhere on the page must not affect this nav entry —
    // AdminGate itself never consumes `usePrintingPluginActive`.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ active: false }), { status: 200 }))
    );

    render(<AdminGate />);

    expect(screen.getByTestId("admin-nav-printing")).toBeInTheDocument();
  });
});
