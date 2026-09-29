import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Shell } from "@/shell/Shell";
import { resolveHouseholdRoute } from "@/shell/routes";
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

async function waitForPluginCatalog(): Promise<void> {
  await screen.findByTestId("plugin-health-indicator");
}

describe("household shell routes", () => {
  let language: "en" | "es";

  beforeEach(() => {
    language = "en";
    document.cookie = "mp_provisioned=1; path=/";
    window.history.replaceState({}, "", "/");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/settings") {
          return Response.json({
            locale: { timezone: "Europe/Madrid", language, weekStartDay: 1 },
          });
        }
        if (url === "/api/plugins") return pluginCatalogResponse();
        if (url === "/api/members") return Response.json([]);
        if (
          url.startsWith("/api/calendar/events") ||
          url.startsWith("/api/chores/board") ||
          url.startsWith("/api/menu")
        ) {
          return Response.json([]);
        }
        return Response.json({});
      })
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    document.cookie = "mp_provisioned=; Max-Age=0; path=/";
    window.history.replaceState({}, "", "/");
  });

  it.each(["/", "/calendar", "/chores", "/meals"])(
    "keeps all four named family links at %s",
    async (path) => {
      window.history.replaceState({}, "", path);
      render(<Shell />);
      await waitForPluginCatalog();
      const nav = screen.getByRole("navigation", { name: "Household navigation" });
      expect(
        within(nav)
          .getAllByRole("link")
          .map((link) => [link.textContent, link.getAttribute("href")])
      ).toEqual([
        ["Home", "/"],
        ["Calendar", "/calendar"],
        ["Tasks", "/chores"],
        ["Meals", "/meals"],
      ]);
    }
  );

  it("navigates from Home to the real Calendar surface without reloading the chrome", async () => {
    render(<Shell />);
    await waitForPluginCatalog();
    expect(screen.getByTestId("home-surface")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Household navigation" });
    fireEvent.click(within(nav).getByRole("link", { name: "Calendar" }));
    expect(window.location.pathname).toBe("/calendar");
    expect(await screen.findByRole("heading", { name: "Calendar" })).toBeInTheDocument();
    expect(screen.queryByTestId("home-surface")).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Household navigation" })).toBe(nav);
  });

  it.each(["/daily-briefing", "/missing", "/administrator", "/calendar/extra"])(
    "renders a recoverable not-found outcome at %s",
    async (path) => {
      window.history.replaceState({}, "", path);
      render(<Shell />);
      await waitForPluginCatalog();
      expect(screen.getByRole("heading", { name: "Page not found" })).toBeInTheDocument();
      expect(screen.queryByTestId("home-surface")).not.toBeInTheDocument();
      expect(screen.queryByTestId("daily-briefing-view")).not.toBeInTheDocument();
      expect(screen.queryByTestId("admin-panel-scope")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("link", { name: "Home" }));
      expect(await screen.findByTestId("home-surface")).toBeInTheDocument();
    }
  );

  it("localizes navigation and the unknown-route outcome from household Spanish", async () => {
    language = "es";
    window.history.replaceState({}, "", "/daily-briefing");
    render(<Shell />);
    await waitForPluginCatalog();
    const nav = screen.getByRole("navigation", { name: "Navegación del hogar" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent)
    ).toEqual(["Inicio", "Calendario", "Tareas", "Comidas"]);
    expect(screen.getByRole("heading", { name: "Página no encontrada" })).toBeInTheDocument();
  });

  it.each(["/admin", "/admin/printing", "/admin/daily-briefing", "/admin/missing"])(
    "keeps direct %s entry locked without changing the URL",
    async (path) => {
      window.history.replaceState({}, "", path);
      render(<Shell />);
      await waitForPluginCatalog();
      expect(await screen.findByTestId("admin-pin-keypad")).toBeInTheDocument();
      expect(screen.queryByTestId("admin-affordance")).not.toBeInTheDocument();
      expect(window.location.pathname).toBe(path);
      expect(screen.queryByTestId("admin-panel-scope")).not.toBeInTheDocument();
      expect(screen.queryByTestId("printing-management")).not.toBeInTheDocument();
      expect(screen.queryByTestId("home-surface")).not.toBeInTheDocument();
    }
  );

  it.each(["/", "/calendar", "/chores", "/meals"])(
    "does not mount an admin gate or admin content at family route %s",
    async (path) => {
      window.history.replaceState({}, "", path);
      render(<Shell />);

      await waitForPluginCatalog();
      expect(screen.queryByTestId("admin-affordance")).not.toBeInTheDocument();
      expect(screen.queryByTestId("admin-panel-scope")).not.toBeInTheDocument();
    }
  );
});

// Literal contract inventory, independent of the production table.
describe("closed route resolver", () => {
  it.each([
    ["/", "home"],
    ["/calendar", "calendar"],
    ["/chores", "chores"],
    ["/meals", "meals"],
  ])("resolves family destination %s", (path, id) => {
    expect(resolveHouseholdRoute(path)).toMatchObject({
      kind: "family",
      id,
      path,
      Component: expect.any(Function),
    });
  });

  it.each([
    ["/admin", "member-create"],
    ["/admin/members", "members"],
    ["/admin/day-periods", "day-periods"],
    ["/admin/routines", "routines"],
    ["/admin/reminders", "reminders"],
    ["/admin/meals", "meals"],
    ["/admin/daily-messages", "daily-messages"],
    ["/admin/daily-briefing", "daily-briefing"],
    ["/admin/telemetry", "telemetry"],
    ["/admin/backups", "backups"],
    ["/admin/time-announcements", "time-announcements"],
    ["/admin/weather", "weather"],
    ["/admin/network-devices", "network-devices"],
    ["/admin/printing", "printing"],
  ])("recognizes protected destination %s without unlock state", (path, id) => {
    expect(resolveHouseholdRoute(path)).toEqual({ kind: "admin", id, path });
  });

  it.each([
    ["/admin/", "unknown-admin"],
    ["/admin/missing", "unknown-admin"],
    ["/admin/printing/extra", "unknown-admin"],
    ["/daily-briefing", "unknown-family"],
    ["/administrator", "unknown-family"],
    ["/calendar/", "unknown-family"],
    ["/Calendar", "unknown-family"],
    ["/missing", "unknown-family"],
  ])("classifies unknown pathname %s without prefix leakage", (path, kind) => {
    expect(resolveHouseholdRoute(path)).toEqual({ kind, path });
  });
});
