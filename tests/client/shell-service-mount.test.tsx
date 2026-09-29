import { StrictMode, useEffect } from "react";
import { render, screen, cleanup, waitFor, fireEvent, act, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Shell, registerShellService } from "@/shell/Shell";
import { useT } from "@/i18n";
import { HouseholdSettingsProvider, useHouseholdSettings } from "@/lib/householdSettings";
import type { PluginCatalogEntry, PluginId } from "../../src/shared/plugins";

const PLUGIN_IDS: readonly PluginId[] = [
  "daily-briefing",
  "printing",
  "weather",
  "time-announcements",
  "backups",
  "network-devices",
  "meals-recipes",
  "reminders",
  "daily-messages",
];

function activePlugin(id: PluginId): PluginCatalogEntry {
  const contributions: Record<PluginId, PluginCatalogEntry["contributions"]> = {
    "daily-briefing": {
      routes: ["daily-briefing-api"],
      admin: ["daily-briefing"],
      settings: ["daily-briefing-settings"],
      widgets: [],
      services: ["daily-briefing-generator"],
      jobs: [
        "daily-briefing.generate-all",
        "daily-briefing.retry-15",
        "daily-briefing.retry-30",
        "daily-briefing.auto-print-sweep",
      ],
    },
    printing: {
      routes: ["printing-api"],
      admin: ["printing"],
      settings: [],
      widgets: ["printer-attention"],
      services: ["printing-queue", "printing-executor"],
      jobs: [],
    },
    weather: {
      routes: ["weather-api"],
      admin: ["weather"],
      settings: ["weather-settings"],
      widgets: ["weather-pill"],
      services: ["weather-forecast-provider"],
      jobs: [],
    },
    "time-announcements": {
      routes: ["time-announcements-api"],
      admin: ["time-announcements"],
      settings: [],
      widgets: [],
      services: ["time-announcements-speaker"],
      jobs: [],
    },
    backups: {
      routes: ["backups-api"],
      admin: ["backups"],
      settings: [],
      widgets: [],
      services: [],
      jobs: ["backups.nightly"],
    },
    "network-devices": {
      routes: ["network-devices-api"],
      admin: ["network-devices"],
      settings: [],
      widgets: [],
      services: ["network-devices-controller"],
      jobs: ["network-devices.poll"],
    },
    "meals-recipes": {
      routes: ["meals-recipes-api"],
      admin: ["meals"],
      settings: [],
      widgets: ["today-meals"],
      services: [],
      jobs: [],
    },
    reminders: {
      routes: ["reminders-api"],
      admin: ["reminders"],
      settings: [],
      widgets: [],
      services: [],
      jobs: [],
    },
    "daily-messages": {
      routes: ["daily-messages-api"],
      admin: ["daily-messages"],
      settings: [],
      widgets: [],
      services: [],
      jobs: [],
    },
  };
  return {
    id,
    label: `plugins.${id}.label`,
    description: `plugins.${id}.description`,
    trustTier: "first-party",
    contributions: contributions[id],
    requirements: [],
    settingsSchema: [],
    state: "active",
    operation: null,
    health: { status: "healthy", code: null },
    updatedAt: "2026-09-28T08:00:00.000Z",
    error: null,
  };
}

function pluginCatalogResponse(): Response {
  return Response.json({ plugins: PLUGIN_IDS.map(activePlugin) });
}

/** (US0): the shell hoist's assembly seam —
 * `HouseholdSettingsProvider` -> `LanguageProvider` -> `ShellServices` sits
 * above the per-route branch chain, so a service registered through
 * `registerShellService` is present on every route the shell can show, with
 * language context available. This is the Constitution XIII front-loaded
 * assembly proof: a jsdom probe stands in for the real announcement service
 * that mounts here in a later .
 * (Traces: KIOSK-SHELL-NAVIGATION-AC-07 — announcements half, mount-point
 * part; FR-007)
 */

/** A stand-in headless service: renders a language-dependent string + the household tz. */
function Probe() {
  const t = useT();
  const { timezone } = useHouseholdSettings();
  return (
    <div data-testid="shell-service-probe">
      {t("admin.nav.memberCreate")}::{String(timezone)}
    </div>
  );
}

function SettingsLifecycleProbe() {
  const { timezone, status, retry } = useHouseholdSettings();
  return (
    <>
      <output data-testid="settings-lifecycle-probe">
        {status}::{String(timezone)}
      </output>
      <button type="button" onClick={retry}>
        Retry settings
      </button>
    </>
  );
}

function settingsResponse(language: string) {
  return new Response(
    JSON.stringify({ locale: { timezone: "America/New_York", language, weekStartDay: 1 } }),
    { status: 200 }
  );
}

/** Generic 200 for any other authenticated call a mounted board surface makes (its own
 * non-settings data fetch — ChoresBoard's `/api/chores/board`, MealsBoard's `/api/menu`,
 * DailyBriefingView's `/api/members?lifecycle=all` + `/api/daily-briefing/...` — ALL now
 * consume the hoisted settings context instead of fetching `/api/settings` themselves,
 *). List-shaped endpoints get `[]` so the surface's own render doesn't crash on a
 * shape mismatch; everything else gets `{}`.
 */
function genericOkResponse(url: string) {
  if (url === "/api/plugins") return pluginCatalogResponse();
  const isListEndpoint = /\/api\/(calendar\/events|chores\/board|members|menu)/.test(url);
  return new Response(JSON.stringify(isListEndpoint ? [] : {}), { status: 200 });
}

describe("Shell — US0 service mount point (slice-015 T003)", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let unregister: (() => void) | null = null;

  const settingsCalls = () =>
    mockFetch.mock.calls.filter(([url]) => String(url).includes("/api/settings"));

  beforeEach(() => {
    document.cookie = "mp_provisioned=1; path=/";
  });

  afterEach(() => {
    unregister?.();
    unregister = null;
    vi.unstubAllGlobals();
    document.cookie = "mp_provisioned=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
    window.history.pushState({}, "", "/");
    cleanup();
  });

  describe.each([
    ["/chores", "family"],
    ["/meals", "family"],
    ["/", "home"],
    ["/calendar", "family"],
    ["/admin/printing", "locked admin"],
    ["/admin/missing", "unknown admin"],
    ["/daily-briefing", "removed family route"],
  ])("mounted on the %s branch (%s)", (path) => {
    it("renders the registered probe with language context (household language: es)", async () => {
      mockFetch = vi.fn((url: string | URL) => {
        const u = String(url);
        if (u.includes("/api/settings")) return Promise.resolve(settingsResponse("es"));
        return Promise.resolve(genericOkResponse(u));
      });
      vi.stubGlobal("fetch", mockFetch);

      window.history.pushState({}, "", path);
      unregister = registerShellService(Probe);

      render(<Shell />);

      // "Crear Miembro" is the es translation of admin.nav.memberCreate — proves the
      // probe renders UNDER the hoisted LanguageProvider, not the English default.
      await waitFor(() => {
        expect(screen.getByTestId("shell-service-probe")).toHaveTextContent(
          "Crear Miembro::America/New_York"
        );
      });
    });

    // the "ONE /api/settings fetch per boot" property was previously
    // pinned on the default ("/") branch only — a mutation reintroducing an ad-hoc fetch
    // in ChoresBoard/MealsBoard/DailyBriefingView specifically would have survived every
    // existing test (none of them mount those surfaces AND count settings calls). Each
    // retrofitted branch now gets its own count assertion.
    it("the provider layer performs exactly ONE /api/settings fetch per boot (no ad-hoc surface fetchers)", async () => {
      mockFetch = vi.fn((url: string | URL) => {
        const u = String(url);
        if (u.includes("/api/settings")) return Promise.resolve(settingsResponse("en"));
        return Promise.resolve(genericOkResponse(u));
      });
      vi.stubGlobal("fetch", mockFetch);

      window.history.pushState({}, "", path);
      unregister = registerShellService(Probe);

      render(<Shell />);

      await waitFor(() => {
        expect(screen.getByTestId("shell-service-probe")).toHaveTextContent(
          "Member Create::America/New_York"
        );
      });

      // Give any stray extra effect a tick, then assert the count settled at exactly 1 —
      // every settings-derived surface (ChoresBoard, MealsBoard, DailyBriefingView, and
      // the various admin panels) now consumes the hoisted context instead of
      // fetching `/api/settings` itself, so every call here is directly attributable to
      // the hoisted HouseholdSettingsProvider regardless of which branch is mounted.
      await Promise.resolve();
      expect(settingsCalls()).toHaveLength(1);
    });
  });

  it("keeps services and the singular printer owner alive across family/admin/history changes", async () => {
    const mounted = vi.fn();
    const unmounted = vi.fn();
    function LifetimeProbe() {
      useEffect(() => {
        mounted();
        return unmounted;
      }, []);
      return <Probe />;
    }
    mockFetch = vi.fn(async (url: string) => {
      if (url.includes("/api/settings")) return settingsResponse("en");
      return genericOkResponse(url);
    });
    vi.stubGlobal("fetch", mockFetch);
    unregister = registerShellService(LifetimeProbe);
    render(<Shell />);
    await waitFor(() => {
      expect(mockFetch.mock.calls.filter(([url]) => url === "/api/plugins")).toHaveLength(1);
    });
    fireEvent.click(
      within(screen.getByTestId("household-menubar")).getByRole("link", { name: "Calendar" })
    );
    expect(window.location.pathname).toBe("/calendar");
    act(() => {
      window.history.pushState({}, "", "/admin/printing");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByTestId("admin-pin-keypad")).toBeInTheDocument();
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();
    expect(settingsCalls()).toHaveLength(1);
    // The owner reads the catalog once on mount. A second read here would prove it was torn down
    // and recreated by route composition, even though it deliberately renders no DOM.
    expect(mockFetch.mock.calls.filter(([url]) => url === "/api/plugins")).toHaveLength(1);
    cleanup();
    expect(unmounted).toHaveBeenCalledTimes(1);
  });

  it("the pre-gate/provisioning branch performs ZERO fetches (no new boot-time probe)", () => {
    document.cookie = "mp_provisioned=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    unregister = registerShellService(Probe);

    render(<Shell />);

    expect(screen.getByRole("button", { name: "Provision Device" })).toBeInTheDocument();
    expect(screen.queryByTestId("shell-service-probe")).not.toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("shares one boot settings request and one explicit retry across consumers", async () => {
    let attempts = 0;
    mockFetch = vi.fn((url: string | URL) => {
      if (String(url) !== "/api/settings") return Promise.resolve(genericOkResponse(String(url)));
      attempts += 1;
      return Promise.resolve(
        attempts === 1
          ? new Response(JSON.stringify({ error: "unavailable" }), { status: 503 })
          : settingsResponse("en")
      );
    });
    vi.stubGlobal("fetch", mockFetch);

    render(
      <HouseholdSettingsProvider>
        <SettingsLifecycleProbe />
        <SettingsLifecycleProbe />
      </HouseholdSettingsProvider>
    );

    expect(await screen.findAllByText("error::null")).toHaveLength(2);
    expect(settingsCalls()).toHaveLength(1);
    for (const button of screen.getAllByRole("button", { name: "Retry settings" })) {
      fireEvent.click(button);
    }
    expect(await screen.findAllByText("ready::America/New_York")).toHaveLength(2);
    expect(settingsCalls()).toHaveLength(2);
  });

  it("ignores an old settings response after unmounting before a newer boot", async () => {
    let resolveFirst!: (response: Response) => void;
    let resolveSecond!: (response: Response) => void;
    let calls = 0;
    mockFetch = vi.fn((url: string | URL) => {
      if (String(url) !== "/api/settings") return Promise.resolve(genericOkResponse(String(url)));
      calls += 1;
      return new Promise((resolve) => {
        if (calls === 1) resolveFirst = resolve;
        else resolveSecond = resolve;
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const mounted = render(
      <HouseholdSettingsProvider>
        <SettingsLifecycleProbe />
      </HouseholdSettingsProvider>
    );
    await waitFor(() => expect(settingsCalls()).toHaveLength(1));
    mounted.unmount();
    render(
      <HouseholdSettingsProvider>
        <SettingsLifecycleProbe />
      </HouseholdSettingsProvider>
    );
    await waitFor(() => expect(settingsCalls()).toHaveLength(2));
    await act(async () => {
      resolveFirst(settingsResponse("es"));
    });
    expect(screen.getByTestId("settings-lifecycle-probe")).toHaveTextContent("loading::null");
    await act(async () => {
      resolveSecond(settingsResponse("en"));
    });
    expect(await screen.findByText("ready::America/New_York")).toBeVisible();
  });

  it("settles the one boot request after StrictMode replays provider effects", async () => {
    let resolveSettings!: (response: Response) => void;
    mockFetch = vi.fn((url: string | URL) => {
      if (String(url) !== "/api/settings") return Promise.resolve(genericOkResponse(String(url)));
      return new Promise((resolve) => {
        resolveSettings = resolve;
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    render(
      <StrictMode>
        <HouseholdSettingsProvider>
          <SettingsLifecycleProbe />
        </HouseholdSettingsProvider>
      </StrictMode>
    );

    await waitFor(() => expect(settingsCalls()).toHaveLength(1));
    await act(async () => {
      resolveSettings(settingsResponse("en"));
    });
    expect(await screen.findByText("ready::America/New_York")).toBeVisible();
    expect(settingsCalls()).toHaveLength(1);
  });
});
