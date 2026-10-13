import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsManagement } from "@/admin/SettingsManagement";
import { LanguageProvider } from "@/i18n";
import { messages } from "@/i18n/messages";
import type { EffectiveSettings } from "../../src/shared";

/** The Settings page: the household's language, time zone and week start, with the day periods
 * and the weather location on the same page. The Radix select is replaced by a native one so
 * the tests can pick a value; the two hosted panels are stubs, each has its own suite.
 */

const retry = vi.fn();
const household = { timezone: "Europe/Madrid", language: "en", weekStartDay: 1, retry };

vi.mock("@/lib/householdSettings", () => ({
  useHouseholdSettings: () => household,
  useHouseholdSettingsContext: () => household,
}));

vi.mock("@/admin/DayPeriodsManagement", () => ({
  DayPeriodsManagement: () => <div data-testid="day-periods-stub" />,
}));
vi.mock("@/admin/WeatherManagement", () => ({
  WeatherManagement: () => <div data-testid="weather-stub" />,
}));

vi.mock("@/components/ui/select", async () => {
  const { createContext, useContext } = await import("react");
  type Props = { children?: ReactNode } & Record<string, unknown>;
  const Ctx = createContext<{ value: string; onValueChange: (value: string) => void } | null>(null);
  return {
    Select: ({ value, onValueChange, children }: Props) => (
      <Ctx.Provider
        value={{ value: value as string, onValueChange: onValueChange as (v: string) => void }}
      >
        {children}
      </Ctx.Provider>
    ),
    // The trigger carries the label association and the test id, as the real one does.
    SelectTrigger: ({ id, "data-testid": testId }: Props) => {
      const select = useContext(Ctx)!;
      return (
        <input
          id={id as string}
          data-testid={testId as string}
          value={select.value}
          onChange={(event) => select.onValueChange(event.target.value)}
        />
      );
    },
    SelectValue: () => null,
    SelectContent: ({ children }: Props) => <ul>{children}</ul>,
    SelectItem: ({ value }: Props) => <li data-option={value as string} />,
  };
});

const SETTINGS: EffectiveSettings = {
  locale: { timezone: "Europe/Madrid", language: "en", weekStartDay: 1 },
  weather: { lat: null, lon: null },
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function renderSettings() {
  render(
    <LanguageProvider>
      <SettingsManagement />
    </LanguageProvider>
  );
}

describe("SettingsManagement", () => {
  beforeEach(() => {
    retry.mockClear();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    cleanup();
  });

  it("shows the stored language, time zone and week start, with nothing to save yet", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse(SETTINGS));
    renderSettings();

    expect(await screen.findByLabelText("Language")).toHaveValue("en");
    expect(screen.getByLabelText("Time zone")).toHaveValue("Europe/Madrid");
    expect(screen.getByLabelText("Week starts on")).toHaveValue("1");
    expect(screen.getByTestId("settings-save")).toBeDisabled();
  });

  it("offers UTC and the stored zone even when the runtime's list has neither", async () => {
    vi.spyOn(Intl, "supportedValuesOf").mockReturnValue(["Europe/Lisbon", "Europe/Madrid"]);
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse({ ...SETTINGS, locale: { ...SETTINGS.locale, timezone: "Etc/GMT+3" } })
    );
    renderSettings();

    await screen.findByTestId("settings-save");
    const options = [...document.querySelectorAll("[data-option]")].map((option) =>
      option.getAttribute("data-option")
    );
    expect(options).toEqual(expect.arrayContaining(["UTC", "Etc/GMT+3", "Europe/Lisbon"]));
    expect(options.filter((option) => option === "UTC")).toHaveLength(1);
  });

  it("hosts the day periods and the weather location on the same page", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse(SETTINGS));
    renderSettings();

    await screen.findByTestId("settings-save");
    expect(screen.getByTestId("day-periods-stub")).toBeInTheDocument();
    expect(screen.getByTestId("weather-stub")).toBeInTheDocument();
  });

  it("saves the three values as one locale object and asks the app to reload them", async () => {
    const saved = { timezone: "Europe/Lisbon", language: "es", weekStartDay: 0 };
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (_input, init) =>
      init?.method === "PUT" ? jsonResponse({ ...SETTINGS, locale: saved }) : jsonResponse(SETTINGS)
    );
    renderSettings();

    fireEvent.change(await screen.findByLabelText("Language"), { target: { value: "es" } });
    fireEvent.change(screen.getByLabelText("Time zone"), { target: { value: "Europe/Lisbon" } });
    fireEvent.change(screen.getByLabelText("Week starts on"), { target: { value: "0" } });
    fireEvent.click(screen.getByTestId("settings-save"));

    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    const put = mockFetch.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(put[0]).toBe("/api/settings");
    expect(JSON.parse(String(put[1]!.body))).toEqual({ object: "locale", settings: saved });
    expect(screen.getByTestId("settings-save")).toHaveTextContent("✓ Save");
    expect(screen.getByTestId("settings-save")).toBeDisabled();
  });

  it("announces a refused save in its own words, never the server's, and keeps the edit", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (_input, init) =>
      init?.method === "PUT"
        ? jsonResponse({ message: "Unknown time zone" }, 400)
        : jsonResponse(SETTINGS)
    );
    renderSettings();

    fireEvent.change(await screen.findByLabelText("Week starts on"), { target: { value: "0" } });
    fireEvent.click(screen.getByTestId("settings-save"));

    expect(await screen.findByTestId("settings-error")).toHaveTextContent(
      messages.en["admin.settings.saveError"]
    );
    expect(screen.getByLabelText("Week starts on")).toHaveValue("0");
    expect(screen.getByTestId("settings-save")).toBeEnabled();
    expect(retry).not.toHaveBeenCalled();
  });

  it("falls back to its own message when the save never reaches the server", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (_input, init) => {
      if (init?.method === "PUT") throw new TypeError("network down");
      return jsonResponse(SETTINGS);
    });
    renderSettings();

    fireEvent.change(await screen.findByLabelText("Week starts on"), { target: { value: "0" } });
    fireEvent.click(screen.getByTestId("settings-save"));

    expect(await screen.findByTestId("settings-error")).toHaveTextContent(
      messages.en["admin.settings.saveError"]
    );
  });

  it("announces a failed load and offers no form to save", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse({}, 500));
    renderSettings();

    expect(await screen.findByTestId("settings-error")).toHaveTextContent(
      messages.en["admin.settings.loadError"]
    );
    expect(screen.queryByTestId("settings-save")).not.toBeInTheDocument();
  });
});
