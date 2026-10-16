import { render, cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Shell } from "@/shell/Shell";

const DAY_PERIODS = [
  { id: "morning", labelKey: "dayPeriod.morning", start: "05:00", sortOrder: 0 },
  { id: "afternoon", labelKey: "dayPeriod.afternoon", start: "12:00", sortOrder: 1 },
  { id: "evening", labelKey: "dayPeriod.evening", start: "18:00", sortOrder: 2 },
  { id: "night", labelKey: "dayPeriod.night", start: "21:00", sortOrder: 3 },
];

/** Density toggle is intentionally unmounted from Options while we work in the
 * comfortable default. Isolation specs (`density-control.test.tsx`) keep proving the
 * control still works; this file proves the shell does NOT expose it. Re-mounting
 * `<DensityControl />` in HouseholdChrome without flipping these assertions is the
 * tripwire for an accidental product re-enable.
 */
describe("density control — real Shell mount intentionally hidden", () => {
  beforeEach(() => {
    document.cookie = "mp_provisioned=1; path=/";
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    document.cookie = "mp_provisioned=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
    window.history.pushState({}, "", "/");
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-density");
  });

  function mockShellBackend() {
    const mockFetch = vi.fn((url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/settings")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } }),
            { status: 200 }
          )
        );
      }
      if (u.includes("/api/day-periods")) {
        return Promise.resolve(new Response(JSON.stringify(DAY_PERIODS), { status: 200 }));
      }
      const isList =
        /\/api\/(time-announcements|members|calendar\/events|chores\/board|menu|day-periods)/.test(
          u
        );
      return Promise.resolve(new Response(JSON.stringify(isList ? [] : {}), { status: 200 }));
    });
    vi.stubGlobal("fetch", mockFetch);
    return mockFetch;
  }

  it("does not expose the density toggle from Options on the default route", async () => {
    mockShellBackend();

    render(<Shell />);

    await screen.findByRole("button", { name: "Options" });

    expect(screen.getByTestId("admin-affordance")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Kiosk mode" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("density-control-toggle")).not.toBeInTheDocument();
  });

  it("does not expose the density toggle from Options on a family route either (/chores)", async () => {
    window.history.pushState({}, "", "/chores");
    const mockFetch = mockShellBackend();
    mockFetch.mockImplementation((url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/settings")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } }),
            { status: 200 }
          )
        );
      }
      if (u.includes("/api/chores/board")) {
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      }
      if (u.includes("/api/day-periods")) {
        return Promise.resolve(new Response(JSON.stringify(DAY_PERIODS), { status: 200 }));
      }
      const isList =
        /\/api\/(time-announcements|members|calendar\/events|chores\/board|menu|day-periods)/.test(
          u
        );
      return Promise.resolve(new Response(JSON.stringify(isList ? [] : {}), { status: 200 }));
    });

    render(<Shell />);

    await screen.findByRole("button", { name: "Options" });
    expect(screen.getByTestId("admin-affordance")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Kiosk mode" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("density-control-toggle")).not.toBeInTheDocument();
  });
});
