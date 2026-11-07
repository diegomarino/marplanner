import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminSidebar } from "@/admin/AdminRoutes";
import { log } from "@/lib/logger";
import { PluginCatalogProvider } from "@/plugins/PluginCatalogProvider";
import { PLUGIN_IDS, type PluginCatalogEntry, type PluginState } from "../../src/shared/plugins";

vi.mock("@/lib/logger", () => ({ log: vi.fn() }));
const telemetryLog = vi.mocked(log);

function entry(id: (typeof PLUGIN_IDS)[number], state: PluginState): PluginCatalogEntry {
  return {
    id,
    label: `plugins.${id}.label`,
    description: `plugins.${id}.description`,
    trustTier: "first-party",
    contributions: {
      routes: [],
      admin: [id === "meals-recipes" ? "meals" : id],
      settings: [],
      widgets: [],
      services: [],
      jobs: [],
    },
    requirements: [],
    settingsSchema: [],
    state,
    operation: null,
    health: { status: "healthy", code: null },
    updatedAt: "2026-11-07T08:00:00.000Z",
    error: null,
  };
}

function catalogResponse(state: PluginState = "active"): Response {
  return new Response(JSON.stringify({ plugins: PLUGIN_IDS.map((id) => entry(id, state)) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function failure(): Response {
  return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
}

function renderSidebar() {
  return render(
    <PluginCatalogProvider>
      <AdminSidebar pathname="/admin" onLock={() => undefined} />
    </PluginCatalogProvider>
  );
}

/** Let pending fetch promises and the React updates they trigger settle. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
}

describe("plugin catalog refresh and recovery", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    telemetryLog.mockClear();
    window.history.replaceState(null, "", "/admin");
    setVisibility("visible");
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("refetches when the tab becomes visible again and shows newly activated plugins", async () => {
    fetchMock.mockResolvedValueOnce(catalogResponse("inactive"));
    renderSidebar();
    await settle();
    expect(screen.queryByText("Briefing")).toBeNull();

    fetchMock.mockResolvedValueOnce(catalogResponse("active"));
    setVisibility("hidden");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    setVisibility("visible");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Briefing")).toBeTruthy();
  });

  it("refetches on window focus", async () => {
    fetchMock.mockResolvedValueOnce(catalogResponse("inactive"));
    renderSidebar();
    await settle();

    fetchMock.mockResolvedValueOnce(catalogResponse("active"));
    act(() => void window.dispatchEvent(new Event("focus")));
    await settle();

    expect(screen.getByText("Briefing")).toBeTruthy();
  });

  it("shows a notice, logs once, and recovers by itself after a failed first fetch", async () => {
    fetchMock.mockResolvedValue(failure());
    renderSidebar();
    await settle();

    expect(screen.getByTestId("plugin-catalog-notice").textContent).toContain(
      "Plugin list unavailable"
    );
    expect(screen.queryByText("Briefing")).toBeNull();
    expect(telemetryLog).toHaveBeenCalledTimes(1);
    expect(telemetryLog).toHaveBeenCalledWith(
      "error",
      "plugin-catalog",
      "plugin catalog unavailable",
      { reason: "http_503" }
    );

    // The first automatic retry still fails: no second log for the same outage.
    await act(async () => void vi.advanceTimersByTime(2_000));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(telemetryLog).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValue(catalogResponse("active"));
    await act(async () => void vi.advanceTimersByTime(5_000));
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.queryByTestId("plugin-catalog-notice")).toBeNull();
    expect(screen.getByText("Briefing")).toBeTruthy();
  });

  it("keeps the last good catalog while a failed refresh retries", async () => {
    fetchMock.mockResolvedValueOnce(catalogResponse("active"));
    renderSidebar();
    await settle();
    expect(screen.getByText("Briefing")).toBeTruthy();

    fetchMock.mockResolvedValue(failure());
    act(() => void window.dispatchEvent(new Event("focus")));
    await settle();

    expect(screen.getByText("Briefing")).toBeTruthy();
    expect(screen.getByTestId("plugin-catalog-notice").textContent).toContain(
      "Plugin list may be out of date"
    );
    expect(telemetryLog).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValue(catalogResponse("active"));
    await act(async () => void vi.advanceTimersByTime(2_000));
    await settle();
    expect(screen.queryByTestId("plugin-catalog-notice")).toBeNull();
    expect(screen.getByText("Briefing")).toBeTruthy();
  });

  it("retries from the notice button", async () => {
    fetchMock.mockResolvedValueOnce(failure());
    renderSidebar();
    await settle();

    fetchMock.mockResolvedValueOnce(catalogResponse("active"));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("plugin-catalog-notice")).toBeNull();
    expect(screen.getByText("Briefing")).toBeTruthy();
  });

  it("logs a parse failure as an invalid catalog", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ plugins: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    renderSidebar();
    await settle();

    expect(telemetryLog).toHaveBeenCalledWith(
      "error",
      "plugin-catalog",
      "plugin catalog unavailable",
      { reason: "invalid_catalog" }
    );
  });
});
