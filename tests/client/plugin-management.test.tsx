import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { messages } from "@/i18n/messages";
import { PluginCatalogProvider } from "@/plugins/PluginCatalogProvider";
import { PluginHealthIndicator } from "@/plugins/PluginHealthIndicator";
import { PluginManagement } from "@/plugins/PluginManagement";
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

const LABEL_KEYS: Record<PluginId, string> = {
  "daily-briefing": "plugins.dailyBriefing.label",
  printing: "plugins.printing.label",
  weather: "plugins.weather.label",
  "time-announcements": "plugins.timeAnnouncements.label",
  backups: "plugins.backups.label",
  "network-devices": "plugins.networkDevices.label",
  "meals-recipes": "plugins.mealsRecipes.label",
  reminders: "plugins.reminders.label",
  "daily-messages": "plugins.dailyMessages.label",
};

function entry(id: PluginId, state: PluginState = "inactive"): PluginCatalogEntry {
  return {
    id,
    label: LABEL_KEYS[id],
    description: LABEL_KEYS[id].replace(".label", ".description"),
    trustTier: "first-party",
    contributions: {
      routes: [`${id}-api`],
      admin: [id],
      settings: id === "weather" ? ["weather-settings"] : [],
      widgets: id === "weather" ? ["weather-pill"] : [],
      services: [`${id}-service`],
      jobs: [],
    },
    requirements: ["app-settings"],
    settingsSchema:
      id === "weather"
        ? [
            {
              key: "weatherLat",
              label: "weather.management.latLabel",
              valueType: "number",
              required: false,
              sensitive: true,
            },
          ]
        : [],
    state,
    operation: null,
    health: { status: state === "errored" ? "attention" : "healthy", code: null },
    updatedAt: "2026-09-27T10:00:00.000Z",
    error:
      state === "errored"
        ? { code: "migration_failed", message: "Plugin data could not be prepared." }
        : null,
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderCatalog(children = <PluginManagement />) {
  return render(<PluginCatalogProvider>{children}</PluginCatalogProvider>);
}

describe("Plugin Management (Slice 026 T006)", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/admin/plugins");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ plugins: IDS.map((id) => entry(id)) }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("renders exactly nine localized rows in manifest order with safe declarative metadata", async () => {
    renderCatalog();

    const rows = await screen.findAllByTestId(/^plugin-row-/);
    expect(rows.map((row) => row.getAttribute("data-plugin-id"))).toEqual(IDS);
    expect(rows[0]).toHaveTextContent("Daily Briefing");
    expect(rows[0]).toHaveTextContent("First-party");
    expect(rows[0]).toHaveTextContent("Inactive");
    expect(rows[0]).toHaveTextContent("Routes");
    expect(rows[0]).toHaveTextContent("Requirements");

    const weather = screen.getByTestId("plugin-row-weather");
    expect(weather).toHaveTextContent("Latitude");
    expect(weather).toHaveTextContent("Number");
    expect(weather).toHaveTextContent("Protected value");

    const visible = document.body.textContent ?? "";
    expect(visible).not.toContain("plugins.weather.label");
    expect(visible).not.toContain("weatherLat");
    expect(visible).not.toContain("41.3874");
    expect(visible).not.toContain("mpk-");
  });

  it("uses only the authenticated session and never sends client PIN state", async () => {
    sessionStorage.setItem("adminPin", "7391");
    renderCatalog();

    await screen.findByTestId("plugin-row-daily-briefing");
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe("/api/plugins");
    expect(init).toMatchObject({ credentials: "include" });
    expect(JSON.stringify(init)).not.toContain("7391");
    expect(JSON.stringify(init)).not.toMatch(/pin/i);
  });

  it("keeps canonical state visible while busy and disables only that plugin", async () => {
    const plugins = IDS.map((id) => entry(id, "active"));
    plugins[0] = {
      ...plugins[0],
      operation: { targetState: "inactive", startedAt: "2026-09-27T10:00:00.000Z" },
    };
    vi.mocked(fetch).mockResolvedValueOnce(response({ plugins }));

    renderCatalog();

    const briefing = await screen.findByTestId("plugin-row-daily-briefing");
    expect(briefing).toHaveTextContent("Active");
    expect(briefing).toHaveTextContent("Stopping safely…");
    expect(
      within(briefing).getByRole("button", { name: "Deactivate Daily Briefing" })
    ).toBeDisabled();
    expect(within(briefing).getByText("Stopping safely…")).toHaveAttribute("aria-live", "polite");

    const printing = screen.getByTestId("plugin-row-printing");
    expect(within(printing).getByRole("button", { name: "Deactivate Printing" })).toBeEnabled();
  });

  it("applies the 409 plugin snapshot, announces a safe failure, and preserves control focus", async () => {
    const stale = entry("weather", "inactive");
    const current = {
      ...entry("weather", "active"),
      operation: { targetState: "inactive" as const, startedAt: "2026-09-27T10:00:01.000Z" },
    };
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        response({ plugins: IDS.map((id) => (id === "weather" ? stale : entry(id))) })
      )
      .mockResolvedValueOnce(
        response(
          {
            code: "plugin_lifecycle_busy",
            message: "A lifecycle operation is already in progress for this plugin.",
            plugin: current,
            raw: "mpk-never-render /Users/operator/private.db",
          },
          409
        )
      );

    renderCatalog();
    const button = await screen.findByRole("button", { name: "Activate Weather" });
    button.focus();
    fireEvent.click(button);

    expect(
      await screen.findByText("Another lifecycle change is already in progress.")
    ).toHaveAttribute("aria-live", "polite");
    const weather = screen.getByTestId("plugin-row-weather");
    expect(weather).toHaveTextContent("Active");
    expect(weather).toHaveTextContent("Stopping safely…");
    expect(button).toHaveFocus();
    expect(document.body).not.toHaveTextContent("mpk-never-render");
    expect(document.body).not.toHaveTextContent("/Users/operator/private.db");
  });

  it("restores focus to the renamed action after a successful lifecycle transition", async () => {
    let resolveTransition!: (value: Response) => void;
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ plugins: IDS.map((id) => entry(id)) }))
      .mockImplementationOnce(
        () => new Promise<Response>((resolve) => (resolveTransition = resolve))
      );

    renderCatalog();
    const activate = await screen.findByRole("button", { name: "Activate Weather" });
    activate.focus();
    fireEvent.click(activate);
    await waitFor(() => expect(activate).toBeDisabled());

    document.body.tabIndex = -1;
    document.body.focus();
    expect(document.body).toHaveFocus();
    resolveTransition(response(entry("weather", "active")));

    const deactivate = await screen.findByRole("button", { name: "Deactivate Weather" });
    await waitFor(() => expect(deactivate).toHaveFocus());
    document.body.removeAttribute("tabindex");
  });

  it("reveals aggregate health only after load and focuses the errored row on activation", async () => {
    let resolveCatalog!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () => new Promise<Response>((resolve) => (resolveCatalog = resolve))
    );

    renderCatalog(
      <>
        <PluginHealthIndicator />
        <PluginManagement />
      </>
    );
    expect(screen.queryByTestId("plugin-health-indicator")).not.toBeInTheDocument();

    resolveCatalog(
      response({ plugins: IDS.map((id) => entry(id, id === "weather" ? "errored" : "inactive")) })
    );
    const indicator = await screen.findByRole("button", { name: "Plugins need attention" });
    fireEvent.click(indicator);

    expect(window.location.pathname).toBe("/admin/plugins");
    expect(window.location.hash).toBe("#plugin-weather");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Weather" })).toHaveFocus());
  });

  it("keeps every supported locale complete for the plugin surface", () => {
    const pluginKeys = Object.keys(messages.en).filter(
      (key) => key.startsWith("plugins.") || key === "admin.nav.plugins"
    ) as (keyof typeof messages.en)[];
    expect(pluginKeys.length).toBeGreaterThan(20);
    for (const key of pluginKeys) {
      expect(messages.es[key], key).toBeTruthy();
    }
  });

  it("uses a narrow-safe stacked structure with visible actions and no table overflow", async () => {
    renderCatalog();
    const catalog = await screen.findByTestId("plugin-catalog");
    expect(catalog).toHaveClass("grid");
    expect(catalog.querySelector("table")).toBeNull();
    expect(catalog.className).toContain("min-w-0");
    expect(screen.getAllByRole("button", { name: /^Activate / })).toHaveLength(9);
  });
});
