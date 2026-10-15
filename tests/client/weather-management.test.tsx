/**
 * WeatherManagement is a controlled panel: the Settings page owns the values and the single Save.
 * Geolocation only prefills fields; nothing here touches the network (FR-010).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/i18n";
import { messages } from "@/i18n/messages";
import {
  EMPTY_WEATHER_FORM,
  WeatherManagement,
  toWeatherFormState,
  weatherFormDirty,
  weatherFormProblem,
  weatherPayload,
  type WeatherFormState,
} from "@/admin/WeatherManagement";

const household = { timezone: "Europe/Madrid", language: "en", weekStartDay: 1 };
vi.mock("@/lib/householdSettings", () => ({
  useHouseholdSettings: () => household,
  useHouseholdSettingsContext: () => household,
}));

function Harness({ initial = EMPTY_WEATHER_FORM }: { initial?: WeatherFormState }) {
  const [value, setValue] = useState(initial);
  return (
    <LanguageProvider>
      <WeatherManagement
        value={value}
        onChange={(patch) => setValue((c) => ({ ...c, ...patch }))}
      />
    </LanguageProvider>
  );
}

describe("weather form helpers", () => {
  it("maps settings to strings and back to a payload without a blank label", () => {
    const form = toWeatherFormState({ lat: 40.4168, lon: -3.7038, label: "Madrid" });
    expect(form).toEqual({ lat: "40.4168", lon: "-3.7038", label: "Madrid" });
    expect(weatherPayload(form)).toEqual({ lat: 40.4168, lon: -3.7038, label: "Madrid" });
    expect(weatherPayload({ lat: "1", lon: "2", label: "  " })).toEqual({ lat: 1, lon: 2 });
    expect(weatherPayload(EMPTY_WEATHER_FORM)).toEqual({ lat: null, lon: null });
  });
  it("flags a partial or non-numeric pair", () => {
    expect(weatherFormProblem(EMPTY_WEATHER_FORM)).toBeNull();
    expect(weatherFormProblem({ lat: "1", lon: "2", label: "" })).toBeNull();
    expect(weatherFormProblem({ lat: "1", lon: "", label: "" })).toBe("partial");
    expect(weatherFormProblem({ lat: "1", lon: "x", label: "" })).toBe("invalid");
  });
  it("compares forms field by field", () => {
    expect(weatherFormDirty(EMPTY_WEATHER_FORM, { ...EMPTY_WEATHER_FORM })).toBe(false);
    expect(weatherFormDirty(EMPTY_WEATHER_FORM, { ...EMPTY_WEATHER_FORM, label: "x" })).toBe(true);
  });
});

describe("WeatherManagement", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    Reflect.deleteProperty(navigator, "geolocation");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("shows the values it is given and blank inputs when unset", () => {
    render(<Harness initial={{ lat: "40.4168", lon: "-3.7038", label: "Madrid" }} />);
    expect(screen.getByTestId("weather-lat-input")).toHaveValue(40.4168);
    expect(screen.getByTestId("weather-label-input")).toHaveValue("Madrid");
    cleanup();
    render(<Harness />);
    expect(screen.getByTestId("weather-lat-input")).toHaveValue(null);
    expect(screen.getByTestId("weather-label-input")).toHaveValue("");
  });

  it("reports edits through onChange and never touches the network", () => {
    render(<Harness />);
    fireEvent.change(screen.getByTestId("weather-lat-input"), { target: { value: "10" } });
    expect(screen.getByTestId("weather-lat-input")).toHaveValue(10);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("disables Locate when geolocation is absent", () => {
    render(<Harness />);
    expect(screen.getByTestId("weather-locate")).toBeDisabled();
  });

  it("geolocation prefills rounded lat/lon and writes nothing (FR-010)", async () => {
    const getCurrentPosition = vi.fn((ok: (p: GeolocationPosition) => void) =>
      ok({ coords: { latitude: 51.507351234, longitude: -0.12775891 } } as GeolocationPosition)
    );
    Object.defineProperty(navigator, "geolocation", {
      value: { getCurrentPosition },
      configurable: true,
    });
    render(<Harness />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("weather-locate"));
    });
    expect(screen.getByTestId("weather-lat-input")).toHaveValue(51.5074);
    expect(screen.getByTestId("weather-lon-input")).toHaveValue(-0.1278);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("announces a refused geolocation without changing the fields", async () => {
    Object.defineProperty(navigator, "geolocation", {
      value: { getCurrentPosition: (_ok: unknown, fail: () => void) => fail() },
      configurable: true,
    });
    render(<Harness initial={{ lat: "1", lon: "2", label: "" }} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("weather-locate"));
    });
    expect(screen.getByTestId("weather-error")).toHaveTextContent(
      messages.en["weather.management.geolocationError"]
    );
    expect(screen.getByTestId("weather-lat-input")).toHaveValue(1);
  });

  it("Clear empties all three fields locally and is disabled once blank", () => {
    render(<Harness initial={{ lat: "1", lon: "2", label: "Home" }} />);
    fireEvent.click(screen.getByTestId("weather-clear"));
    expect(screen.getByTestId("weather-lat-input")).toHaveValue(null);
    expect(screen.getByTestId("weather-label-input")).toHaveValue("");
    expect(screen.getByTestId("weather-clear")).toBeDisabled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("explains a half-filled pair", () => {
    render(<Harness initial={{ lat: "1", lon: "", label: "" }} />);
    expect(screen.getByTestId("weather-hint")).toHaveTextContent(
      messages.en["admin.settings.weatherIncomplete"]
    );
  });
});
