import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/i18n";
import { messages } from "@/i18n/messages";
import { WeatherManagement } from "@/admin/WeatherManagement";
import type { EffectiveSettings } from "../../src/shared";

/** — WeatherManagement admin panel jsdom tests (house pattern:
 * useT/authFetch/controlled inputs, see `tests/client/time-announcements-management.test.tsx`).
 * `@/lib/householdSettings` is mocked so `LanguageProvider` (D3: consumes the parent
 * settings context when one exists) resolves synchronously to a fixed household language —
 * no real `/api/settings` fetch racing the panel's own GET.
 * `navigator.geolocation` is absent in jsdom by default (asserted below: the Locate button
 * degrades to disabled rather than crash); a stub is injected per-test where the prefill
 * behavior is exercised — it is NEVER a hard dependency (FR-010).
 * (Traces: WEATHER-AC-01, WEATHER-INV-02, WEATHER-INV-03; FR-005..FR-010)
 */

const currentSettings = { timezone: "Europe/Madrid", language: "en", weekStartDay: 1 };

vi.mock("@/lib/householdSettings", () => ({
  useHouseholdSettings: () => currentSettings,
  useHouseholdSettingsContext: () => currentSettings,
}));

type FetchCall = Parameters<typeof globalThis.fetch>;

const BLANK_SETTINGS: EffectiveSettings = {
  locale: { timezone: "Europe/Madrid", language: "es", weekStartDay: 1 },
  weather: { lat: null, lon: null },
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function renderManagement() {
  render(
    <LanguageProvider>
      <WeatherManagement />
    </LanguageProvider>
  );
}

describe("WeatherManagement", () => {
  beforeEach(() => {
    currentSettings.language = "en";
    vi.stubGlobal("fetch", vi.fn());
    // jsdom does not define navigator.geolocation by default — confirm the ambient state
    // each test starts from (Reflect.deleteProperty avoids TS's "operand of delete must be
    // optional" complaint about the readonly Navigator.geolocation getter), so a stubbed
    // test below is provably adding it, not finding it already present.
    Reflect.deleteProperty(navigator, "geolocation");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("reports unavailable settings when the weather plugin has no settings contribution", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse({ locale: BLANK_SETTINGS.locale }));
    renderManagement();
    expect(await screen.findByTestId("weather-error")).toHaveTextContent(
      messages.en["weather.management.loadError"]
    );
  });

  it("loads the persisted location and prefills lat/lon/label", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input, init] = args;
      if (String(input) === "/api/settings" && !init?.method) {
        return jsonResponse({
          locale: BLANK_SETTINGS.locale,
          weather: { lat: 40.4168, lon: -3.7038, label: "Madrid" },
        } satisfies EffectiveSettings);
      }
      throw new Error(`unexpected fetch: ${String(input)} ${init?.method ?? "GET"}`);
    });

    renderManagement();

    expect(await screen.findByTestId("weather-lat-input")).toHaveValue(40.4168);
    expect(screen.getByTestId("weather-lon-input")).toHaveValue(-3.7038);
    expect(screen.getByTestId("weather-label-input")).toHaveValue("Madrid");
  });

  it("renders blank inputs when the location is unset", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async () => jsonResponse(BLANK_SETTINGS));

    renderManagement();

    const latInput = await screen.findByTestId("weather-lat-input");
    expect(latInput).toHaveValue(null);
    expect(screen.getByTestId("weather-lon-input")).toHaveValue(null);
    expect(screen.getByTestId("weather-label-input")).toHaveValue("");
  });

  it("the Locate button is disabled when navigator.geolocation is absent (jsdom default)", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async () => jsonResponse(BLANK_SETTINGS));

    renderManagement();
    await screen.findByTestId("weather-lat-input");

    expect(screen.getByTestId("weather-locate")).toBeDisabled();
  });

  it("geolocation prefills lat/lon but issues NO write until Save is clicked (FR-010)", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async () => jsonResponse(BLANK_SETTINGS));

    const getCurrentPosition = vi.fn((success: (position: GeolocationPosition) => void) => {
      success({
        coords: { latitude: 51.507351234, longitude: -0.12775891 },
      } as GeolocationPosition);
    });
    Object.defineProperty(navigator, "geolocation", {
      value: { getCurrentPosition },
      configurable: true,
    });

    renderManagement();
    await screen.findByTestId("weather-lat-input");

    expect(screen.getByTestId("weather-locate")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("weather-locate"));

    await waitFor(() => {
      expect(screen.getByTestId("weather-lat-input")).toHaveValue(51.5074);
    });
    expect(screen.getByTestId("weather-lon-input")).toHaveValue(-0.1278);

    // Prefill alone never reaches the network as a write.
    expect(
      mockFetch.mock.calls.some(([, init]) => {
        const method = init?.method;
        return method !== undefined && method !== "GET";
      })
    ).toBe(false);
  });

  it("the Save button is disabled when only one of lat/lon is filled (partial pair)", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async () => jsonResponse(BLANK_SETTINGS));

    renderManagement();
    await screen.findByTestId("weather-lat-input");

    fireEvent.change(screen.getByTestId("weather-lat-input"), { target: { value: "40" } });
    expect(screen.getByTestId("weather-save")).toBeDisabled();

    fireEvent.change(screen.getByTestId("weather-lon-input"), { target: { value: "-3" } });
    expect(screen.getByTestId("weather-save")).not.toBeDisabled();
  });

  it("Save PUTs {object:'weather', settings:{lat,lon,label}} and refreshes the form from the response", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input, init] = args;
      const url = String(input);
      if (url === "/api/settings" && !init?.method) return jsonResponse(BLANK_SETTINGS);
      if (url === "/api/settings" && init?.method === "PUT") {
        return jsonResponse({
          locale: BLANK_SETTINGS.locale,
          weather: { lat: 40.4168, lon: -3.7038, label: "Madrid" },
        } satisfies EffectiveSettings);
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    });

    renderManagement();
    await screen.findByTestId("weather-lat-input");
    expect(screen.getByTestId("weather-save")).toBeDisabled();

    fireEvent.change(screen.getByTestId("weather-lat-input"), { target: { value: "40.4168" } });
    fireEvent.change(screen.getByTestId("weather-lon-input"), { target: { value: "-3.7038" } });
    fireEvent.change(screen.getByTestId("weather-label-input"), { target: { value: "Madrid" } });

    fireEvent.click(screen.getByTestId("weather-save"));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({
          method: "PUT",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            object: "weather",
            settings: { lat: 40.4168, lon: -3.7038, label: "Madrid" },
          }),
        })
      );
    });

    expect(screen.getByTestId("weather-lat-input")).toHaveValue(40.4168);
    expect(screen.getByTestId("weather-save")).toBeDisabled();
    expect(screen.getByTestId("weather-save")).toHaveTextContent("✓ Save");
  });

  it("Clear PUTs {lat:null, lon:null} with NO label key, and empties the label input too (FR-005 clear-as-unit)", async () => {
    // Seeded WITH a non-empty label: the server itself accepts
    // {lat:null, lon:null, label:"Madrid"} — clear-as-a-UNIT is enforced client-side only,
    // so a mutation that re-attaches the prior label on clear must fail this test.
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input, init] = args;
      const url = String(input);
      if (url === "/api/settings" && !init?.method) {
        return jsonResponse({
          locale: BLANK_SETTINGS.locale,
          weather: { lat: 1, lon: 2, label: "Madrid" },
        } satisfies EffectiveSettings);
      }
      if (url === "/api/settings" && init?.method === "PUT") {
        return jsonResponse(BLANK_SETTINGS);
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    });

    renderManagement();
    await waitFor(() => expect(screen.getByTestId("weather-lat-input")).toHaveValue(1));
    expect(screen.getByTestId("weather-label-input")).toHaveValue("Madrid");

    fireEvent.click(screen.getByTestId("weather-clear"));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({
          method: "PUT",
          // Exact body: {lat:null, lon:null} — no `label` key at all, not even
          // `label: undefined`/empty-string. JSON.stringify drops an `undefined` value, so
          // this also proves the request body carries no label field.
          body: JSON.stringify({ object: "weather", settings: { lat: null, lon: null } }),
        })
      );
    });
    expect(screen.getByTestId("weather-lat-input")).toHaveValue(null);
    expect(screen.getByTestId("weather-lon-input")).toHaveValue(null);
    expect(screen.getByTestId("weather-label-input")).toHaveValue("");
  });

  it("surfaces the server's error message on a failed save", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    const validationMessage = "Latitude out of range";
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input, init] = args;
      const url = String(input);
      if (url === "/api/settings" && !init?.method) return jsonResponse(BLANK_SETTINGS);
      if (url === "/api/settings" && init?.method === "PUT") {
        return jsonResponse({ error: "validation_error", message: validationMessage }, 400);
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    });

    renderManagement();
    await screen.findByTestId("weather-lat-input");

    fireEvent.change(screen.getByTestId("weather-lat-input"), { target: { value: "999" } });
    fireEvent.change(screen.getByTestId("weather-lon-input"), { target: { value: "0" } });
    fireEvent.click(screen.getByTestId("weather-save"));

    expect(await screen.findByTestId("weather-error")).toHaveTextContent(
      messages.en["weather.management.saveError"]
    );
  });

  it("a pre-response transport failure (authFetch REJECTS) renders the localized fallback, never the raw exception message (Codex PR #654 P2)", async () => {
    // es, specifically — proves the rendered text is the LOCALIZED catalogue string, not
    // merely "some English string that happens to differ from the TypeError message".
    currentSettings.language = "es";
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input, init] = args;
      const url = String(input);
      if (url === "/api/settings" && !init?.method) return jsonResponse(BLANK_SETTINGS);
      if (url === "/api/settings" && init?.method === "PUT") {
        // No response ever exists on this path — a transport/offline failure, exactly what
        // a real browser `fetch` rejects with.
        throw new TypeError("Failed to fetch");
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    });

    renderManagement();
    await screen.findByTestId("weather-lat-input");

    fireEvent.change(screen.getByTestId("weather-lat-input"), { target: { value: "40" } });
    fireEvent.change(screen.getByTestId("weather-lon-input"), { target: { value: "-3" } });
    fireEvent.click(screen.getByTestId("weather-save"));

    const errorEl = await screen.findByTestId("weather-error");
    expect(errorEl).toHaveTextContent(messages.es["weather.management.saveError"]);
    expect(errorEl).not.toHaveTextContent("Failed to fetch");
  });
});

it.each([
  ["en", "malformed"],
  ["es", "malformed"],
  ["en", "network"],
  ["es", "network"],
  ["en", "unknown"],
  ["es", "unknown"],
] as const)("localizes unknown and transport save failures (%s, %s)", async (language, failure) => {
  currentSettings.language = language;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      if (String(input) === "/api/settings" && !init?.method)
        return jsonResponse({
          ...BLANK_SETTINGS,
          locale: { timezone: "UTC", language, weekStartDay: 1 },
        });
      if (init?.method === "PUT") {
        if (failure === "network")
          throw new TypeError("Failed to fetch private English diagnostics");
        if (failure === "malformed") return new Response("not JSON", { status: 500 });
        return jsonResponse(
          { error: "toString", message: "Private English server diagnostics" },
          500
        );
      }
      throw new Error("Unexpected request");
    })
  );
  try {
    renderManagement();
    await screen.findByRole("button", { name: messages[language]["weather.management.save"] });
    fireEvent.change(screen.getByTestId("weather-lat-input"), { target: { value: "1" } });
    fireEvent.change(screen.getByTestId("weather-lon-input"), { target: { value: "2" } });
    fireEvent.click(screen.getByTestId("weather-save"));
    const notice = await screen.findByTestId("weather-error");
    expect(notice).toHaveTextContent(messages[language]["weather.management.saveError"]);
    expect(notice).not.toHaveTextContent("Private English");
  } finally {
    cleanup();
    vi.unstubAllGlobals();
  }
});

it("announces geolocation refusal in Spanish without changing or saving the location", async () => {
  currentSettings.language = "es";
  const fetch = vi.fn(async (..._args: FetchCall) => jsonResponse(BLANK_SETTINGS));
  vi.stubGlobal("fetch", fetch);
  const geolocation = vi.fn((_success, failure) => failure({ message: "Permission denied" }));
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: { getCurrentPosition: geolocation },
  });
  try {
    renderManagement();
    const lat = await screen.findByTestId("weather-lat-input");
    fireEvent.click(screen.getByTestId("weather-locate"));
    expect(await screen.findByTestId("weather-error")).toHaveTextContent(
      messages.es["weather.management.geolocationError"]
    );
    expect(lat).toHaveValue(null);
    expect(screen.getByTestId("weather-lon-input")).toHaveValue(null);
    expect(fetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  } finally {
    delete (navigator as { geolocation?: Geolocation }).geolocation;
    cleanup();
    vi.unstubAllGlobals();
  }
});
