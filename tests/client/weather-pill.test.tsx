import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HouseholdSettingsProvider } from "@/lib/householdSettings";
import { LanguageProvider } from "@/i18n";
import { WeatherPill, WeatherPillView } from "@/home/WeatherPill";
import { Shell } from "@/shell/Shell";
import { writeWeatherCache } from "@/home/weatherCache";
import { sliceUpcomingHours } from "@/home/weatherFormat";
import type { ForecastHour, ForecastResult } from "../../src/shared";
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

/** docs/features/weather.md — kiosk weather pill jsdom tests (FR-016/017/022,
 * WEATHER-INV-12). Render + empty states + NO error/retry UI + pill absence outside the
 * home route ("/").
 */

const HEALTHY_FORECAST: ForecastResult = {
  current: { conditionKey: "clear", tempC: 21.4, rainPct: 10 },
  hourly: [{ time: "2026-09-04T15:00", conditionKey: "clear", tempC: 22.0, rainPct: 12 }],
  daily: [
    { date: "2026-09-04", conditionKey: "clear", tempMinC: 15.0, tempMaxC: 26.0, rainPct: 20 },
  ],
};

function settingsResponse(weather?: { lat: number; lon: number; label?: string }): Response {
  return new Response(
    JSON.stringify({
      locale: { timezone: "Europe/Madrid", language: "en", weekStartDay: 1 },
      weather: weather ?? { lat: null, lon: null },
    }),
    { status: 200 }
  );
}

function weatherResponse(forecast: ForecastResult | null): Response {
  return new Response(JSON.stringify({ forecast }), { status: 200 });
}

/** A full day's normalized hourly entries (00:00..23:00), hour 21 marked distinctly so a test
 * can prove the modal starts rendering FROM the current hour, not from midnight . */
function fullDayHourly(): ForecastHour[] {
  return Array.from({ length: 24 }, (_, h) => ({
    time: `2026-09-04T${String(h).padStart(2, "0")}:00`,
    conditionKey: "clear" as const,
    tempC: 15 + h * 0.3,
    rainPct: h === 21 ? 77 : h === 0 ? 5 : (h * 7) % 60,
  }));
}

/** Generic 200 for any other authenticated call a mounted board surface makes (shell-service-mount.test.tsx precedent). */
function genericOkResponse(url: string): Response {
  if (url === "/api/plugins") return pluginCatalogResponse();
  const isListEndpoint = /\/api\/(chores\/board|members|calendar\/events|menu)/.test(url);
  return new Response(JSON.stringify(isListEndpoint ? [] : {}), { status: 200 });
}

describe("WeatherPill", () => {
  let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    mockFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", mockFetch);
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    cleanup();
  });

  it("renders nothing when no location is configured (silent absence, FR-022)", async () => {
    mockFetch.mockImplementation((url) => {
      const u = String(url);
      if (u.includes("/api/settings")) return Promise.resolve(settingsResponse());
      return Promise.reject(new Error(`unexpected fetch: ${u}`));
    });

    render(
      <HouseholdSettingsProvider>
        <WeatherPill />
      </HouseholdSettingsProvider>
    );

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    // Give the (absent) weather effect a tick — it must never fire when location is blank.
    await Promise.resolve();
    expect(screen.queryByTestId("weather-pill")).not.toBeInTheDocument();
    expect(mockFetch.mock.calls.some(([u]) => String(u).includes("/api/weather"))).toBe(false);
  });

  it("renders condition/temp/rain once a location + healthy forecast resolve", async () => {
    mockFetch.mockImplementation((url) => {
      const u = String(url);
      if (u.includes("/api/settings"))
        return Promise.resolve(settingsResponse({ lat: 40.4, lon: -3.7 }));
      if (u.includes("/api/weather")) return Promise.resolve(weatherResponse(HEALTHY_FORECAST));
      return Promise.reject(new Error(`unexpected fetch: ${u}`));
    });

    render(
      <HouseholdSettingsProvider>
        <WeatherPill />
      </HouseholdSettingsProvider>
    );

    await waitFor(() => expect(screen.getByTestId("weather-pill")).toBeInTheDocument());
    expect(screen.getByTestId("weather-pill-condition")).toHaveTextContent("Clear");
    expect(screen.getByTestId("weather-pill-temp")).toHaveTextContent("21°");
    expect(screen.getByTestId("weather-pill-rain")).toHaveTextContent("10%");
  });

  it("adds device-local HH:mm beside present weather only while browser fullscreen is active", async () => {
    let fullscreenElement: Element | null = null;
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fullscreenElement,
    });
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    );
    mockFetch.mockImplementation((url) => {
      const u = String(url);
      if (u.includes("/api/settings"))
        return Promise.resolve(settingsResponse({ lat: 40.4, lon: -3.7 }));
      if (u.includes("/api/weather")) return Promise.resolve(weatherResponse(HEALTHY_FORECAST));
      return Promise.reject(new Error(`unexpected fetch: ${u}`));
    });

    render(
      <HouseholdSettingsProvider>
        <WeatherPill />
      </HouseholdSettingsProvider>
    );

    expect(await screen.findByTestId("weather-pill")).toBeInTheDocument();
    expect(screen.queryByLabelText("Device time")).not.toBeInTheDocument();

    fullscreenElement = document.documentElement;
    await act(() => document.dispatchEvent(new Event("fullscreenchange")));
    expect(screen.getByLabelText("Device time")).toHaveTextContent(/^\d{2}:\d{2}$/);
  });

  it("owns the one-second device clock only while presentation and usable weather are both active", async () => {
    let nextIntervalId = 0;
    const activeIntervals = new Map<number, number>();
    vi.spyOn(window, "setInterval").mockImplementation((_handler, delay) => {
      const id = ++nextIntervalId;
      activeIntervals.set(id, Number(delay));
      return id as unknown as ReturnType<typeof window.setInterval>;
    });
    vi.spyOn(window, "clearInterval").mockImplementation((id) => {
      activeIntervals.delete(Number(id));
    });
    let fullscreenElement: Element | null = document.documentElement;
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fullscreenElement,
    });
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    );
    writeWeatherCache(40.4, -3.7, { fetchedAt: Date.now(), result: HEALTHY_FORECAST });

    const { rerender } = render(<WeatherPillView lat={null} lon={null} />);
    await act(async () => {});
    expect([...activeIntervals.values()]).toEqual([60_000]);

    rerender(<WeatherPillView lat={40.4} lon={-3.7} />);
    expect(await screen.findByTestId("weather-pill")).toBeInTheDocument();
    expect([...activeIntervals.values()].sort()).toEqual([1_000, 60_000]);

    rerender(<WeatherPillView lat={null} lon={null} />);
    await act(async () => {});
    expect([...activeIntervals.values()]).toEqual([60_000]);

    rerender(<WeatherPillView lat={40.4} lon={-3.7} />);
    expect(await screen.findByTestId("weather-pill")).toBeInTheDocument();
    fullscreenElement = null;
    await act(() => document.dispatchEvent(new Event("fullscreenchange")));
    expect([...activeIntervals.values()]).toEqual([60_000]);
  });

  it("renders nothing when the forecast is null (blank/disabled/failed server-side) — NO error or retry UI", async () => {
    mockFetch.mockImplementation((url) => {
      const u = String(url);
      if (u.includes("/api/settings"))
        return Promise.resolve(settingsResponse({ lat: 40.4, lon: -3.7 }));
      if (u.includes("/api/weather")) return Promise.resolve(weatherResponse(null));
      return Promise.reject(new Error(`unexpected fetch: ${u}`));
    });

    render(
      <HouseholdSettingsProvider>
        <WeatherPill />
      </HouseholdSettingsProvider>
    );

    await waitFor(() =>
      expect(mockFetch.mock.calls.some(([u]) => String(u).includes("/api/weather"))).toBe(true)
    );
    await Promise.resolve();
    expect(screen.queryByTestId("weather-pill")).not.toBeInTheDocument();
    expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });

  it("renders nothing when the /api/weather call itself fails — NO error or retry UI", async () => {
    mockFetch.mockImplementation((url) => {
      const u = String(url);
      if (u.includes("/api/settings"))
        return Promise.resolve(settingsResponse({ lat: 40.4, lon: -3.7 }));
      if (u.includes("/api/weather")) return Promise.resolve(new Response(null, { status: 500 }));
      return Promise.reject(new Error(`unexpected fetch: ${u}`));
    });

    render(
      <HouseholdSettingsProvider>
        <WeatherPill />
      </HouseholdSettingsProvider>
    );

    await waitFor(() =>
      expect(mockFetch.mock.calls.some(([u]) => String(u).includes("/api/weather"))).toBe(true)
    );
    await Promise.resolve();
    expect(screen.queryByTestId("weather-pill")).not.toBeInTheDocument();
    expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });
});

describe("WeatherPill — shared family chrome", () => {
  let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    mockFetch = vi.fn<typeof fetch>((url) => {
      const u = String(url);
      if (u.includes("/api/settings"))
        return Promise.resolve(settingsResponse({ lat: 40.4, lon: -3.7 }));
      if (u.includes("/api/weather")) return Promise.resolve(weatherResponse(HEALTHY_FORECAST));
      return Promise.resolve(genericOkResponse(u));
    });
    vi.stubGlobal("fetch", mockFetch);
    document.cookie = "mp_provisioned=1; path=/";
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.cookie = "mp_provisioned=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
    window.localStorage.clear();
    window.history.pushState({}, "", "/");
    cleanup();
  });

  describe.each(["/", "/calendar", "/chores", "/meals"])("at %s", (path) => {
    it("renders one top-bar pill with a configured location and retains forecast access", async () => {
      window.history.pushState({}, "", path);

      render(<Shell />);

      const pills = await screen.findAllByTestId("weather-pill");
      expect(pills).toHaveLength(1);
      expect(pills[0].closest("header")).not.toBeNull();
      expect(mockFetch.mock.calls.some(([u]) => String(u).includes("/api/weather"))).toBe(true);
    });
  });

  it("does not render weather for the removed Daily Briefing family route", async () => {
    window.history.pushState({}, "", "/daily-briefing");

    render(<Shell />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    await Promise.resolve();

    expect(screen.queryByTestId("weather-pill")).not.toBeInTheDocument();
    expect(mockFetch.mock.calls.some(([u]) => String(u).includes("/api/weather"))).toBe(false);
  });
});

describe("WeatherPillView — modal content (PR review P1-2/P2-3)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    cleanup();
  });

  it("P1-2: the hourly list starts at the CURRENT hour, not midnight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-04T21:45:00"));

    const forecast: ForecastResult = {
      current: { conditionKey: "clear", tempC: 20, rainPct: 50 },
      hourly: fullDayHourly(),
      daily: [],
    };
    writeWeatherCache(40.4, -3.7, { fetchedAt: Date.now(), result: forecast });

    render(<WeatherPillView lat={40.4} lon={-3.7} />);

    const pill = await screen.findByTestId("weather-pill");
    fireEvent.click(pill);

    const hourRows = await screen.findAllByTestId("weather-modal-hour");
    // 24 hours total (00:00..23:00); current hour is 21 -> hours 21,22,23 remain = 3 rows,
    // the FIRST of which must be hour 21's data (rainPct 77), never hour 0's (rainPct 5) —
    // the old midnight-start bug would have rendered 22 rows starting with rainPct 5.
    expect(hourRows).toHaveLength(3);
    expect(hourRows[0]).toHaveTextContent("21:00");
    expect(hourRows[0]).toHaveTextContent("77%");
  });

  it("P2-3: renders a localized (non-ISO) day label in es, not the raw date string", async () => {
    const forecast: ForecastResult = {
      current: { conditionKey: "clear", tempC: 20, rainPct: 10 },
      hourly: [],
      daily: [
        { date: "2026-09-04", conditionKey: "clear", tempMinC: 10, tempMaxC: 20, rainPct: 5 },
      ],
    };
    writeWeatherCache(41, -4, { fetchedAt: Date.now(), result: forecast });

    const mockFetch = vi.fn((url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/settings"))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              locale: { language: "es", timezone: "Europe/Madrid", weekStartDay: 1 },
            }),
            { status: 200 }
          )
        );
      return Promise.reject(new Error(`unexpected fetch: ${u}`));
    });
    vi.stubGlobal("fetch", mockFetch);

    render(
      <LanguageProvider>
        <WeatherPillView lat={41} lon={-4} />
      </LanguageProvider>
    );

    const pill = await screen.findByTestId("weather-pill");
    fireEvent.click(pill);

    const dayRow = await screen.findByTestId("weather-modal-day");
    // "2026-09-04" is a Friday -> Spanish short weekday "vie 4" (Intl.DateTimeFormat("es",...)).
    expect(dayRow).toHaveTextContent(/vie/i);
    expect(dayRow.textContent).not.toContain("2026-09-04");
  });

  it("localizes the dialog's close-button accessible label and provides a description (Radix a11y, review P3-2)", async () => {
    const forecast: ForecastResult = {
      current: { conditionKey: "clear", tempC: 20, rainPct: 10 },
      hourly: [],
      daily: [],
    };
    writeWeatherCache(41, -4, { fetchedAt: Date.now(), result: forecast });

    const mockFetch = vi.fn((url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/settings"))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              locale: { language: "es", timezone: "Europe/Madrid", weekStartDay: 1 },
            }),
            { status: 200 }
          )
        );
      return Promise.reject(new Error(`unexpected fetch: ${u}`));
    });
    vi.stubGlobal("fetch", mockFetch);

    render(
      <LanguageProvider>
        <WeatherPillView lat={41} lon={-4} />
      </LanguageProvider>
    );

    const pill = await screen.findByTestId("weather-pill");
    fireEvent.click(pill);

    await screen.findByTestId("weather-modal");
    expect(screen.getByText("Cerrar")).toBeInTheDocument();
    expect(screen.queryByText("Close")).not.toBeInTheDocument();
  });

  it("draws a tinted condition icon and today's range, and the rain chance only from 20%", async () => {
    const dry: ForecastResult = {
      current: { conditionKey: "clear", tempC: 20, rainPct: 10, isDay: false },
      hourly: [],
      daily: [
        { date: "2026-09-04", conditionKey: "clear", tempMinC: 14.6, tempMaxC: 26.2, rainPct: 10 },
      ],
    };
    writeWeatherCache(41.1, -3.1, { fetchedAt: Date.now(), result: dry });
    const { unmount } = render(<WeatherPillView lat={41.1} lon={-3.1} />);

    const condition = await screen.findByTestId("weather-pill-condition");
    const icon = condition.querySelector("svg");
    expect(icon).toHaveAttribute("data-weather-icon", "wi-night-clear");
    expect(icon).toHaveClass("text-weather-sun");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(condition).toHaveTextContent("Clear");
    expect(screen.getByTestId("weather-pill-range")).toHaveTextContent("15–26°");
    // Still announced, not drawn.
    expect(screen.getByTestId("weather-pill-rain")).toHaveTextContent("10%");
    expect(screen.getByTestId("weather-pill-rain")).toHaveClass("sr-only");
    unmount();

    const wet: ForecastResult = {
      current: { conditionKey: "rainShowers", tempC: 12, rainPct: 20, isDay: true },
      hourly: [],
      daily: [],
    };
    writeWeatherCache(42.2, -3.2, { fetchedAt: Date.now(), result: wet });
    render(<WeatherPillView lat={42.2} lon={-3.2} />);

    const rain = await screen.findByTestId("weather-pill-rain");
    expect(rain).toHaveTextContent("20%");
    expect(rain).not.toHaveClass("sr-only");
    expect(rain.querySelector("svg")).toHaveAttribute("data-weather-icon", "wi-raindrop");
    expect(screen.getByTestId("weather-pill-condition").querySelector("svg")).toHaveClass(
      "text-weather-rain"
    );
    expect(screen.queryByTestId("weather-pill-range")).not.toBeInTheDocument();
  });

  it("shows humidity, wind and sun times only when the forecast carries them", async () => {
    const full: ForecastResult = {
      current: {
        conditionKey: "partlyCloudy",
        tempC: 19,
        rainPct: 0,
        isDay: true,
        humidityPct: 88,
        windKmh: 3.4,
        sunrise: "2026-09-04T07:41",
        sunset: "2026-09-04T20:39",
      },
      hourly: [],
      daily: [],
    };
    writeWeatherCache(43.3, -3.3, { fetchedAt: Date.now(), result: full });
    const { unmount } = render(<WeatherPillView lat={43.3} lon={-3.3} />);
    fireEvent.click(await screen.findByTestId("weather-pill"));

    const modal = await screen.findByTestId("weather-modal");
    expect(within(modal).getByText("Humidity").nextElementSibling).toHaveTextContent("88%");
    expect(within(modal).getByText("Wind").nextElementSibling).toHaveTextContent("3 km/h");
    expect(within(modal).getByText("Sunrise and sunset").nextElementSibling).toHaveTextContent(
      "07:41 – 20:39"
    );
    expect(within(modal).getByText("Rain").nextElementSibling).toHaveTextContent("0%");
    unmount();

    const bare: ForecastResult = {
      current: { conditionKey: "partlyCloudy", tempC: 19, rainPct: 0, sunrise: "2026-09-04T07:41" },
      hourly: [],
      daily: [],
    };
    writeWeatherCache(44.4, -3.4, { fetchedAt: Date.now(), result: bare });
    render(<WeatherPillView lat={44.4} lon={-3.4} />);
    fireEvent.click(await screen.findByTestId("weather-pill"));

    const bareModal = await screen.findByTestId("weather-modal");
    expect(within(bareModal).getByText("Rain")).toBeInTheDocument();
    expect(within(bareModal).queryByText("Humidity")).not.toBeInTheDocument();
    expect(within(bareModal).queryByText("Wind")).not.toBeInTheDocument();
    expect(within(bareModal).queryByText("Sunrise and sunset")).not.toBeInTheDocument();
  });

  it("caps the hourly strip at 24 hours and draws night hours with the moon icon", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-04T18:10:00"));

    const twoDays: ForecastHour[] = ["2026-09-04", "2026-09-05"].flatMap((date) =>
      fullDayHourly().map((hour, h) => ({
        ...hour,
        time: `${date}T${String(h).padStart(2, "0")}:00`,
        isDay: h >= 8 && h < 20,
      }))
    );
    const forecast: ForecastResult = {
      current: { conditionKey: "clear", tempC: 20, rainPct: 0, isDay: true },
      hourly: twoDays,
      daily: [{ date: "2026-09-04", conditionKey: "snow", tempMinC: -2, tempMaxC: 3, rainPct: 70 }],
    };
    writeWeatherCache(45.5, -3.5, { fetchedAt: Date.now(), result: forecast });
    render(<WeatherPillView lat={45.5} lon={-3.5} />);
    fireEvent.click(await screen.findByTestId("weather-pill"));

    const hourRows = await screen.findAllByTestId("weather-modal-hour");
    expect(hourRows).toHaveLength(24);
    expect(hourRows[0]).toHaveTextContent("18:00");
    expect(hourRows[23]).toHaveTextContent("17:00");
    const icons = hourRows.map((row) =>
      row.querySelector("svg")?.getAttribute("data-weather-icon")
    );
    expect(icons[1]).toBe("wi-day-sunny");
    expect(icons[2]).toBe("wi-night-clear");
    // A hidden label is absolutely positioned: unanchored, the ones scrolled out of the strip
    // would widen the dialog itself.
    for (const row of hourRows) expect(row).toHaveClass("relative");

    const dayRow = screen.getByTestId("weather-modal-day");
    expect(dayRow.querySelector("svg")).toHaveAttribute("data-weather-icon", "wi-snow");
    expect(dayRow.querySelector("svg")).toHaveClass("text-weather-frost");
    expect(dayRow).toHaveTextContent("Snow");
    expect(dayRow).toHaveTextContent("3°");
    expect(dayRow).toHaveTextContent("-2°");
    expect(within(dayRow).getByText("70%")).not.toHaveClass("sr-only");
  });
});

describe("WeatherPillView — stale in-flight response discard (PR review P2-1, mutation M3b)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
    cleanup();
  });

  it("a delayed response for OLD coordinates never overwrites a cache-hit render after an A -> B -> A sequence", async () => {
    const forecastA: ForecastResult = {
      current: { conditionKey: "clear", tempC: 20, rainPct: 10 },
      hourly: [],
      daily: [],
    };
    const forecastB: ForecastResult = {
      current: { conditionKey: "rain", tempC: 5, rainPct: 90 },
      hourly: [],
      daily: [],
    };

    // A is already cached (fresh) — every render at A's coordinates is a cache HIT, never a
    // fetch.
    writeWeatherCache(10, 10, { fetchedAt: Date.now(), result: forecastA });

    // B is NOT cached — resolving its fetch is under this test's control via a manually held
    // promise, simulating "still in flight when the household returns to A".
    let resolveB!: (res: Response) => void;
    const pendingB = new Promise<Response>((resolve) => {
      resolveB = resolve;
    });
    const mockFetch = vi.fn((url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/weather")) return pendingB;
      return Promise.reject(new Error(`unexpected fetch: ${u}`));
    });
    vi.stubGlobal("fetch", mockFetch);

    const { rerender } = render(<WeatherPillView lat={10} lon={10} />);
    await waitFor(() =>
      expect(screen.getByTestId("weather-pill-condition")).toHaveTextContent("Clear")
    );

    // A -> B: B is uncached, so this starts the (still-pending) fetch.
    rerender(<WeatherPillView lat={20} lon={20} />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    // B -> A: A is still cached and fresh, so this is a cache-HIT render — under the bug this
    // fixed, the cache-hit branch returned WITHOUT bumping the generation guard, so B's
    // still-current generation could later overwrite this render.
    rerender(<WeatherPillView lat={10} lon={10} />);
    await waitFor(() =>
      expect(screen.getByTestId("weather-pill-condition")).toHaveTextContent("Clear")
    );

    // B's delayed response finally resolves — it must be discarded (stale generation), NOT
    // overwrite the screen with B's rain/5°/90% data.
    resolveB(new Response(JSON.stringify({ forecast: forecastB }), { status: 200 }));
    // A real macrotask delay (not a chain of microtask `Promise.resolve`s, which can
    // under-count `authFetch`'s await + `res.json`'s own async body read + the effect's
    // `.then` continuation): the event loop drains EVERY pending microtask before a timer
    // fires, so this reliably observes whatever the resolved promise's continuation did.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.getByTestId("weather-pill-condition")).toHaveTextContent("Clear");
    expect(screen.getByTestId("weather-pill-temp")).toHaveTextContent("20°");
    expect(screen.getByTestId("weather-pill-rain")).toHaveTextContent("10%");
  });
});

describe("WeatherPillView — cache-miss clears stale data first (Codex review on #656, P1)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
    cleanup();
  });

  it("switching from a loaded A to an uncached B with a NEVER-RESOLVING fetch shows the empty slot, never A's stale data (WEATHER-AC-06)", async () => {
    const forecastA: ForecastResult = {
      current: { conditionKey: "clear", tempC: 20, rainPct: 10 },
      hourly: [],
      daily: [],
    };
    // A is cached (fresh) — the FIRST render is a cache hit.
    writeWeatherCache(1, 1, { fetchedAt: Date.now(), result: forecastA });

    // B is NOT cached, and its fetch never resolves — a prior version of the component would
    // keep showing A's pill forever in this scenario (the bug).
    const mockFetch = vi.fn((url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/weather")) return new Promise<Response>(() => {});
      return Promise.reject(new Error(`unexpected fetch: ${u}`));
    });
    vi.stubGlobal("fetch", mockFetch);

    const { rerender } = render(<WeatherPillView lat={1} lon={1} />);
    await waitFor(() =>
      expect(screen.getByTestId("weather-pill-condition")).toHaveTextContent("Clear")
    );

    rerender(<WeatherPillView lat={2} lon={2} />);

    // The pill must go EMPTY immediately (before B's hung fetch ever resolves) — never keep
    // rendering A's condition/temp/rain.
    await waitFor(() => expect(screen.queryByTestId("weather-pill")).not.toBeInTheDocument());
    expect(mockFetch).toHaveBeenCalled();
  });
});

describe("WeatherPillView — TTL-expiry recheck (Codex review on #656, P2)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    cleanup();
  });

  it("a mounted pill refetches once the cached entry passes its 30-minute TTL, and renders the new data", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T10:00:00"));

    const forecastOld: ForecastResult = {
      current: { conditionKey: "clear", tempC: 10, rainPct: 5 },
      hourly: [],
      daily: [],
    };
    const forecastNew: ForecastResult = {
      current: { conditionKey: "rain", tempC: 5, rainPct: 80 },
      hourly: [],
      daily: [],
    };

    writeWeatherCache(30, 30, { fetchedAt: Date.now(), result: forecastOld });

    const mockFetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ forecast: forecastNew }), { status: 200 }))
    );
    vi.stubGlobal("fetch", mockFetch);

    render(<WeatherPillView lat={30} lon={30} />);
    // Fresh cache hit at mount — no fetch yet.
    expect(screen.getByTestId("weather-pill-condition")).toHaveTextContent("Clear");
    expect(mockFetch).not.toHaveBeenCalled();

    // Cross the 30-minute TTL boundary (plus one ~1-minute recheck tick past it).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
    });

    expect(mockFetch).toHaveBeenCalled();
    expect(screen.getByTestId("weather-pill-condition")).toHaveTextContent("Rain");
    expect(screen.getByTestId("weather-pill-temp")).toHaveTextContent("5°");
    expect(screen.getByTestId("weather-pill-rain")).toHaveTextContent("80%");
  });

  it("stays a cheap no-op (no fetch) while the recheck interval fires but the cache is still fresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T10:00:00"));

    const forecast: ForecastResult = {
      current: { conditionKey: "clear", tempC: 10, rainPct: 5 },
      hourly: [],
      daily: [],
    };
    writeWeatherCache(31, 31, { fetchedAt: Date.now(), result: forecast });

    const mockFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", mockFetch);

    render(<WeatherPillView lat={31} lon={31} />);

    // A few recheck ticks (well under the 30-minute TTL) must never trigger a fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(screen.getByTestId("weather-pill-condition")).toHaveTextContent("Clear");
  });
});

/** `hour.time` is household-local wall time without an offset; the kiosk browser may run in
 * another zone, so the current hour must come from the household timezone. */
describe("sliceUpcomingHours in the household timezone", () => {
  const day = Array.from({ length: 24 }, (_, h) => ({
    time: `2026-10-21T${String(h).padStart(2, "0")}:00`,
    conditionKey: "clear" as const,
    tempC: 15,
    rainPct: 0,
  }));
  const now = Date.parse("2026-10-21T12:45:00Z");

  it.each([
    ["Europe/Madrid", "2026-10-21T14:00"],
    ["America/Los_Angeles", "2026-10-21T05:00"],
    ["Asia/Tokyo", "2026-10-21T21:00"],
    ["UTC", "2026-10-21T12:00"],
  ])("starts at the current household hour in %s, whatever the browser zone", (zone, first) => {
    const upcoming = sliceUpcomingHours(day, now, zone);
    expect(upcoming[0]?.time).toBe(first);
    expect(upcoming.at(-1)?.time).toBe("2026-10-21T23:00");
  });

  it("returns nothing once every forecast hour has passed in the household zone", () => {
    expect(sliceUpcomingHours(day, Date.parse("2026-10-22T08:00:00Z"), "Asia/Tokyo")).toEqual([]);
  });
});
