import { fireEvent, render, cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Shell } from "@/shell/Shell";

const DAY_PERIODS = [
  { id: "morning", labelKey: "dayPeriod.morning", start: "05:00", sortOrder: 0 },
  { id: "afternoon", labelKey: "dayPeriod.afternoon", start: "12:00", sortOrder: 1 },
  { id: "evening", labelKey: "dayPeriod.evening", start: "18:00", sortOrder: 2 },
  { id: "night", labelKey: "dayPeriod.night", start: "21:00", sortOrder: 3 },
];

/** — proves the density control actually reaches production through the REAL
 * `Shell`, without unlocking admin (FR-002a: a device choice, family-reachable chrome).
 * WHY THIS FILE EXISTS AS A SEPARATE PROOF: itself
 * was the task the slice-close audit caught checked-off with the control never mounted anywhere —
 * every gate green while kiosk density was unreachable by users. The isolation spec
 * (`density-control.test.tsx`) proves the control WORKS; this file proves it is WIRED. Deleting
 * the `<DensityControl />` mount from `Shell.tsx` leaves the entire gate stack green EXCEPT this
 * test (verified by mutation at review time). `Shell.tsx` is a queued shared path — future
 * writers of that file get their tripwire here. Modeled on
 * `time-announcements-shell-mount.test.tsx` (the real-Shell-mount precedent).
 */
describe("density control — real Shell mount (T010, close-audit F1)", () => {
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

  it("renders the control from the Options menu on the default route, WITHOUT any admin unlock", async () => {
    mockShellBackend();

    render(<Shell />);

    fireEvent.click(await screen.findByRole("button", { name: "Options" }));

    // The state-invariant accessible name (StatusToggle doctrine) — found through the REAL
    // Shell's Options path, pre-unlock. This is the assertion that fails if that mount is deleted.
    expect(await screen.findByRole("button", { name: "Kiosk mode" })).toBeInTheDocument();
  });

  it("renders the control on a family route too (/chores)", async () => {
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

    fireEvent.click(await screen.findByRole("button", { name: "Options" }));
    expect(await screen.findByRole("button", { name: "Kiosk mode" })).toBeInTheDocument();
  });
});
