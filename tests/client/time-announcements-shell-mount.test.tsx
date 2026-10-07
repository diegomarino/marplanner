import { render, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerShellService, Shell } from "@/shell/Shell";
// Side-effect import — self-registers AnnouncementService into the US0 `ShellServices`
// slot at MODULE IMPORT TIME, exactly like the production wiring in `src/client/main.tsx`.
import "@/time-announcements/service";
import type { PluginCatalogEntry, PluginId, PluginState } from "../../src/shared/plugins";

const IDS = [
  "daily-briefing",
  "printing",
  "weather",
  "time-announcements",
  "backups",
  "network-devices",
  "meals-recipes",
  "reminders",
  "daily-messages",
] as const;

function plugin(id: PluginId, state: PluginState): PluginCatalogEntry {
  return {
    id,
    label: id,
    description: id,
    trustTier: "first-party",
    contributions: {
      routes: [],
      admin: [],
      settings: [],
      widgets: [],
      services: id === "time-announcements" ? ["time-announcements-speaker"] : [],
      jobs: [],
    },
    requirements: [],
    settingsSchema: [],
    state,
    operation: null,
    health: { status: "healthy", code: null },
    updatedAt: "2026-09-28T08:00:00.000Z",
    error: null,
  };
}

/** — proves the service actually reaches production through the real
 * `Shell`, on the admin-gated branch (probe via the slot), WITHOUT touching
 * `Shell.tsx` itself: this file imports `@/time-announcements/service` for its
 * self-registering side effect, exactly as `src/client/main.tsx` does. Kept in its own
 * file (not `tests/client/time-announcements-service.test.tsx`, which mocks
 * `@/lib/householdSettings` file-wide) so the REAL `HouseholdSettingsProvider` fetch path
 * is exercised here.
 * (Traces: KIOSK-SHELL-NAVIGATION-AC-07 — announcements half, TIME-ANNOUNCEMENTS-AC-03)
 */
describe("time-announcements service — real Shell mount", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.cookie = "mp_provisioned=1; path=/";
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    document.cookie = "mp_provisioned=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
    window.history.pushState({}, "", "/");
    window.localStorage.clear();
  });

  function settingsResponse() {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          locale: { timezone: "America/New_York", language: "en", weekStartDay: 1 },
        }),
        { status: 200 }
      )
    );
  }

  function genericOkResponse(url: string) {
    if (url.includes("/api/plugins")) {
      return Promise.resolve(
        new Response(JSON.stringify({ plugins: IDS.map((id) => plugin(id, "active")) }), {
          status: 200,
        })
      );
    }
    const isListEndpoint = /\/api\/time-announcements$/.test(url);
    return Promise.resolve(new Response(JSON.stringify(isListEndpoint ? [] : {}), { status: 200 }));
  }

  it("mounts and fetches its rules on the admin-gated default branch", async () => {
    mockFetch = vi.fn((url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/settings")) return settingsResponse();
      return genericOkResponse(u);
    });
    vi.stubGlobal("fetch", mockFetch);

    render(<Shell />);

    await waitFor(() => {
      expect(
        mockFetch.mock.calls.some(([url]) => String(url).includes("/api/time-announcements"))
      ).toBe(true);
    });
  });

  it("mounts and fetches its rules on a family route too (/chores)", async () => {
    window.history.pushState({}, "", "/chores");
    mockFetch = vi.fn((url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/settings")) return settingsResponse();
      if (u.includes("/api/chores/board"))
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      return genericOkResponse(u);
    });
    vi.stubGlobal("fetch", mockFetch);

    render(<Shell />);

    await waitFor(() => {
      expect(
        mockFetch.mock.calls.some(([url]) => String(url).includes("/api/time-announcements"))
      ).toBe(true);
    });
  });

  it("does not mount while inactive and leaves core shell requests usable", async () => {
    window.history.pushState({}, "", "/chores");
    mockFetch = vi.fn((url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/settings")) return settingsResponse();
      if (u.includes("/api/plugins")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              plugins: IDS.map((id) =>
                plugin(id, id === "time-announcements" ? "inactive" : "active")
              ),
            }),
            { status: 200 }
          )
        );
      }
      if (u.includes("/api/chores/board")) {
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      }
      return genericOkResponse(u);
    });
    vi.stubGlobal("fetch", mockFetch);

    render(<Shell />);

    await waitFor(() => {
      expect(mockFetch.mock.calls.some(([url]) => String(url).includes("/api/plugins"))).toBe(true);
    });
    expect(
      mockFetch.mock.calls.some(([url]) => /\/api\/time-announcements$/.test(String(url)))
    ).toBe(false);
    expect(screen.getByTestId("household-menubar")).toBeInTheDocument();
  });

  it("uses explicit plugin metadata instead of a component runtime name", async () => {
    const serviceRender = vi.fn();
    function OpaqueBrowserService() {
      serviceRender();
      return null;
    }
    const unregister = registerShellService(OpaqueBrowserService, {
      id: "time-announcements",
      contributionId: "time-announcements-speaker",
    });
    mockFetch = vi.fn((url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/settings")) return settingsResponse();
      if (u.includes("/api/plugins")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              plugins: IDS.map((id) =>
                plugin(id, id === "time-announcements" ? "inactive" : "active")
              ),
            }),
            { status: 200 }
          )
        );
      }
      return genericOkResponse(u);
    });
    vi.stubGlobal("fetch", mockFetch);

    try {
      render(<Shell />);
      await waitFor(() => {
        expect(mockFetch.mock.calls.some(([url]) => String(url).includes("/api/plugins"))).toBe(
          true
        );
      });
      expect(serviceRender).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });
});
