import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminRoutes } from "@/admin/AdminRoutes";
import { HomeSurface } from "@/home/HomeSurface";
import { PluginCatalogProvider, usePluginCatalog } from "@/plugins/PluginCatalogProvider";
import { PluginContribution } from "@/plugins/contributions";
import { resolveHouseholdRoute } from "@/shell/routes";
import type { PluginCatalogEntry, PluginId, PluginState } from "../../src/shared/plugins";

vi.mock("@/home/TodayAgenda", () => ({
  TodayAgenda: () => <div />,
}));

vi.mock("@/home/TodayChores", () => ({
  TodayChores: () => <div />,
}));

vi.mock("@/home/TodayMeals", () => ({
  TodayMeals: () => <div />,
}));

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

function entry(id: PluginId, state: PluginState): PluginCatalogEntry {
  return {
    id,
    label: `plugins.${id}.label`,
    description: `plugins.${id}.description`,
    trustTier: "first-party",
    contributions: {
      routes: [`${id}-api`],
      admin: [id === "meals-recipes" ? "meals" : id],
      settings: id === "weather" ? ["weather-settings"] : [],
      widgets: id === "weather" ? ["weather-pill"] : id === "printing" ? ["printer-attention"] : [],
      services:
        id === "printing"
          ? ["printing-executor"]
          : id === "time-announcements"
            ? ["time-announcements-speaker"]
            : [],
      jobs: [],
    },
    requirements: [],
    settingsSchema: [],
    state,
    operation: null,
    health: { status: state === "errored" ? "attention" : "healthy", code: null },
    updatedAt: "2026-09-28T08:00:00.000Z",
    error:
      state === "errored"
        ? { code: "contribution_failed", message: "A plugin contribution failed." }
        : null,
  };
}

function catalog(states: Partial<Record<PluginId, PluginState>> = {}) {
  return IDS.map((id) => entry(id, states[id] ?? "active"));
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function ThrowingContribution(): React.JSX.Element {
  throw new Error("private path /Users/operator/catalog.db");
}

function CatalogProbe(): React.JSX.Element {
  const catalog = usePluginCatalog();
  const weather = catalog.plugins.find(({ id }) => id === "weather");
  return (
    <div>
      <span>{`catalog:${catalog.status}`}</span>
      <span>{`weather:${weather?.state ?? "missing"}`}</span>
      <button
        type="button"
        onClick={() =>
          void (
            catalog.reportFault as unknown as (pluginId: PluginId, code: string) => Promise<void>
          )("weather", "raw exception /Users/operator/private.json")
        }
      >
        Report raw fault
      </button>
    </div>
  );
}

describe("active plugin contribution projection", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/admin");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders active contributions only while core and active siblings remain", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({ plugins: catalog({ weather: "inactive", printing: "errored" }) })
      )
    );

    render(
      <PluginCatalogProvider>
        <div>Core shell</div>
        <PluginContribution pluginId="daily-briefing" group="admin" contributionId="daily-briefing">
          <div>Daily Briefing contribution</div>
        </PluginContribution>
        <PluginContribution pluginId="weather" group="widgets" contributionId="weather-pill">
          <div>Weather contribution</div>
        </PluginContribution>
        <PluginContribution pluginId="printing" group="widgets" contributionId="printer-attention">
          <div>Printing contribution</div>
        </PluginContribution>
      </PluginCatalogProvider>
    );

    expect(await screen.findByText("Daily Briefing contribution")).toBeInTheDocument();
    expect(screen.getByText("Core shell")).toBeInTheDocument();
    expect(screen.queryByText("Weather contribution")).not.toBeInTheDocument();
    expect(screen.queryByText("Printing contribution")).not.toBeInTheDocument();
  });

  it("withdraws the inactive Meals home widget while preserving core widgets", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ plugins: catalog({ "meals-recipes": "inactive" }) }))
    );

    render(
      <PluginCatalogProvider>
        <HomeSurface />
      </PluginCatalogProvider>
    );

    await waitFor(() => {
      expect(screen.queryByTestId("home-meals-region")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("home-agenda-region")).toBeInTheDocument();
    expect(screen.getByTestId("home-chores-region")).toBeInTheDocument();
  });

  it("maps the family Meals route to its declared route contribution", () => {
    expect(resolveHouseholdRoute("/meals")).toMatchObject({
      kind: "family",
      pluginId: "meals-recipes",
      contributionGroup: "routes",
      contributionId: "meals-recipes-api",
    });
  });

  it("keeps inactive plugins catalog-only and fails direct admin loads closed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ plugins: catalog({ weather: "inactive" }) }))
    );

    render(
      <PluginCatalogProvider>
        <AdminRoutes pathname="/admin/weather" onLock={() => {}} />
      </PluginCatalogProvider>
    );

    expect(await screen.findByRole("heading", { name: "Plugin unavailable" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Return to Plugin Management" })).toHaveAttribute(
      "href",
      "/admin/plugins"
    );
    expect(screen.queryByTestId("weather-management")).not.toBeInTheDocument();
    expect(screen.queryByTestId("admin-nav-weather")).not.toBeInTheDocument();
    expect(screen.getByTestId("admin-nav-members-management")).toBeInTheDocument();
    expect(screen.getByTestId("admin-nav-printing")).toBeInTheDocument();
    expect(screen.getByTestId("admin-nav-plugins")).toBeInTheDocument();
  });

  it("keeps canonical-active contributions visible during a busy deactivation", async () => {
    const plugins = catalog();
    plugins[0] = {
      ...plugins[0],
      operation: { targetState: "inactive", startedAt: "2026-09-28T08:00:01.000Z" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ plugins }))
    );

    render(
      <PluginCatalogProvider>
        <PluginContribution pluginId="daily-briefing" group="admin" contributionId="daily-briefing">
          <div>Busy contribution</div>
        </PluginContribution>
      </PluginCatalogProvider>
    );

    expect(await screen.findByText("Busy contribution")).toBeInTheDocument();
  });

  it("contains a rendering fault, reports only its safe code, and preserves siblings", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: Parameters<typeof fetch>[1]) => {
      if (String(url) === "/api/plugins") return response({ plugins: catalog() });
      if (String(url) === "/api/plugins/weather/fault") return response({}, 202);
      throw new Error(`unexpected request ${String(url)} ${String(init?.method)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <PluginCatalogProvider>
        <PluginContribution
          pluginId="weather"
          group="widgets"
          contributionId="weather-pill"
          withdrawnFallback={<div>Weather withdrawn after fault</div>}
        >
          <ThrowingContribution />
        </PluginContribution>
        <PluginContribution pluginId="printing" group="widgets" contributionId="printer-attention">
          <div>Printing sibling</div>
        </PluginContribution>
      </PluginCatalogProvider>
    );

    expect(await screen.findByText("Plugin unavailable")).toBeInTheDocument();
    expect(screen.getByText("Printing sibling")).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/plugins/weather/fault",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ code: "contribution_render_failed" }),
        })
      );
    });
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("/Users/operator/catalog.db");
  });

  it("rejects a catalog error whose allow-listed code carries a non-canonical raw message", async () => {
    const plugins = catalog({ weather: "errored" });
    plugins[2] = {
      ...plugins[2],
      error: {
        code: "contribution_failed",
        message: "raw exception /Users/operator/private.json",
      } as unknown as PluginCatalogEntry["error"],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ plugins }))
    );

    render(
      <PluginCatalogProvider>
        <CatalogProbe />
      </PluginCatalogProvider>
    );

    expect(await screen.findByText("catalog:error")).toBeInTheDocument();
    expect(screen.getByText("weather:missing")).toBeInTheDocument();
  });

  it("refuses a browser fault code outside the closed allowlist", async () => {
    const fetchMock = vi.fn(async () => response({ plugins: catalog() }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <PluginCatalogProvider>
        <CatalogProbe />
      </PluginCatalogProvider>
    );

    expect(await screen.findByText("catalog:ready")).toBeInTheDocument();
    screen.getByRole("button", { name: "Report raw fault" }).click();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("raw exception");
  });

  it("refreshes the catalog after a contained browser fault and withdraws only that plugin", async () => {
    let catalogReads = 0;
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url) === "/api/plugins") {
        catalogReads += 1;
        return response({
          plugins: catalog(catalogReads === 1 ? {} : { weather: "errored" }),
        });
      }
      if (String(url) === "/api/plugins/weather/fault") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${String(url)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <PluginCatalogProvider>
        <CatalogProbe />
        <PluginContribution
          pluginId="weather"
          group="widgets"
          contributionId="weather-pill"
          withdrawnFallback={<div>Weather withdrawn after fault</div>}
        >
          <ThrowingContribution />
        </PluginContribution>
        <PluginContribution pluginId="printing" group="widgets" contributionId="printer-attention">
          <div>Printing survives browser fault</div>
        </PluginContribution>
      </PluginCatalogProvider>
    );

    expect(await screen.findByText("weather:errored")).toBeInTheDocument();
    expect(screen.getByText("Weather withdrawn after fault")).toBeInTheDocument();
    expect(screen.getByText("Printing survives browser fault")).toBeInTheDocument();
    expect(catalogReads).toBe(2);
  });
});
