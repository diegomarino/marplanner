import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsManagement } from "@/admin/SettingsManagement";
import { LanguageProvider } from "@/i18n";
import { messages } from "@/i18n/messages";
import type { EffectiveSettings } from "../../src/shared";

/** The Settings page: language and week start as pills, a grouped time zone list, the weather
 * location, and one Save for all of them, with the day periods on the same page. The Radix select
 * is replaced by a native one so the tests can pick a value; the day periods panel is a stub, it
 * has its own suite. WeatherManagement renders for real, it is part of this page's Save.
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
    SelectGroup: ({ children }: Props) => <ul>{children}</ul>,
    SelectLabel: ({ children }: Props) => <li data-group-label="">{children}</li>,
    SelectItem: ({ value }: Props) => <li data-option={value as string} />,
  };
});

const SETTINGS: EffectiveSettings = {
  locale: { timezone: "Europe/Madrid", language: "en", weekStartDay: 1 },
  weather: { lat: 40.4168, lon: -3.7038, label: "Madrid" },
};
const NO_WEATHER: EffectiveSettings = { locale: SETTINGS.locale };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

/** The bodies of the PUTs made so far, in order. */
function puts() {
  return vi
    .mocked(globalThis.fetch)
    .mock.calls.filter(([, init]) => init?.method === "PUT")
    .map(([, init]) => JSON.parse(String(init!.body)) as { object: string; settings: unknown });
}

/** A GET that returns `initial`; each PUT echoes the object it wrote into the stored settings
 * unless `refuse` names that object.
 */
function mockApi(initial: EffectiveSettings, refuse?: "locale" | "weather") {
  let stored = initial;
  vi.mocked(globalThis.fetch).mockImplementation(async (_input, init) => {
    if (init?.method !== "PUT") return jsonResponse(stored);
    const body = JSON.parse(String(init.body)) as { object: "locale" | "weather"; settings: never };
    if (body.object === refuse) return jsonResponse({ message: "Unknown time zone" }, 400);
    stored = { ...stored, [body.object]: body.settings };
    return jsonResponse(stored);
  });
}

function renderSettings() {
  render(
    <LanguageProvider>
      <SettingsManagement />
    </LanguageProvider>
  );
}

const optionValues = () =>
  [...document.querySelectorAll("[data-option]")].map((option) =>
    option.getAttribute("data-option")
  );

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

  it("shows the stored values as pills and a time zone, with nothing to save yet", async () => {
    mockApi(SETTINGS);
    renderSettings();

    await screen.findByTestId("settings-save");
    expect(screen.getByRole("radio", { name: "English" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Español" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Monday" })).toBeChecked();
    expect(screen.getByLabelText("Time zone")).toHaveValue("Europe/Madrid");
    expect(screen.getByTestId("settings-save")).toBeDisabled();
    for (const key of [
      "admin.settings.languageDescription",
      "admin.settings.weekStartDescription",
      "admin.settings.timezoneDescription",
    ] as const) {
      expect(screen.getByText(messages.en[key])).toBeInTheDocument();
    }
  });

  it("offers UTC, the curated groups and a stored zone outside the list, each once", async () => {
    mockApi({ ...SETTINGS, locale: { ...SETTINGS.locale, timezone: "Etc/GMT+3" } });
    renderSettings();

    await screen.findByTestId("settings-save");
    const options = optionValues();
    expect(options).toEqual(expect.arrayContaining(["UTC", "Europe/Madrid", "Etc/GMT+3"]));
    for (const zone of ["UTC", "Europe/Madrid", "Etc/GMT+3"]) {
      expect(options.filter((option) => option === zone)).toHaveLength(1);
    }
    expect(
      [...document.querySelectorAll("[data-group-label]")].map((label) => label.textContent)
    ).toContain("Current setting");

    // Picking another zone keeps the original reachable until Save.
    fireEvent.change(screen.getByLabelText("Time zone"), { target: { value: "Europe/Madrid" } });
    expect(optionValues()).toContain("Etc/GMT+3");
  });

  it("puts the Settings and Weather panels in one two-column grid above a single Save", async () => {
    mockApi(SETTINGS);
    renderSettings();
    const save = await screen.findByTestId("settings-save");
    const columns = screen.getByTestId("settings-columns");
    expect(columns).toContainElement(screen.getByTestId("settings-timezone"));
    expect(columns).toContainElement(screen.getByTestId("weather-management"));
    expect(columns).not.toContainElement(save);
    expect(screen.getAllByTestId("settings-save")).toHaveLength(1);
  });

  it("enables Save on any edit and disables it again when the edit is reverted", async () => {
    mockApi(SETTINGS);
    renderSettings();
    const save = await screen.findByTestId("settings-save");
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "Español" }));
    expect(save).toBeEnabled();
    fireEvent.click(screen.getByRole("radio", { name: "English" }));
    expect(save).toBeDisabled();
    const lat = screen.getByTestId("weather-lat-input");
    const lon = screen.getByTestId("weather-lon-input");
    const originalLat = (lat as HTMLInputElement).value;
    const originalLon = (lon as HTMLInputElement).value;
    fireEvent.change(lat, { target: { value: "1.5" } });
    fireEvent.change(lon, { target: { value: "2.5" } });
    expect(save).toBeEnabled();
    fireEvent.change(lat, { target: { value: originalLat } });
    fireEvent.change(lon, { target: { value: originalLon } });
    expect(save).toBeDisabled();
  });

  it.each(["0x10", "1e3", "abc"])(
    "keeps Save blocked for the non-decimal latitude %s",
    async (bad) => {
      mockApi(SETTINGS);
      renderSettings();
      const save = await screen.findByTestId("settings-save");
      fireEvent.change(screen.getByTestId("weather-lat-input"), { target: { value: bad } });
      fireEvent.change(screen.getByTestId("weather-lon-input"), { target: { value: "2" } });
      expect(save).toBeDisabled();
      expect(screen.getByTestId("weather-hint")).toBeInTheDocument();
    }
  );

  it.each([
    ["100", "2"],
    ["-90.5", "2"],
    ["40", "180.01"],
  ])(
    "blocks the out-of-range location %s, %s before any request, even with a locale edit",
    async (lat, lon) => {
      mockApi(SETTINGS);
      renderSettings();
      const save = await screen.findByTestId("settings-save");
      fireEvent.click(screen.getByTestId("settings-week-start-0"));
      fireEvent.change(screen.getByTestId("weather-lat-input"), { target: { value: lat } });
      fireEvent.change(screen.getByTestId("weather-lon-input"), { target: { value: lon } });
      expect(save).toBeDisabled();
      expect(screen.getByTestId("weather-hint")).toHaveTextContent(
        messages.en["admin.settings.weatherRange"]
      );
      fireEvent.click(save);
      expect(puts()).toEqual([]);
    }
  );

  it("saves a pill change as one locale object and asks the app to reload", async () => {
    mockApi(SETTINGS);
    renderSettings();

    await screen.findByTestId("settings-save");
    fireEvent.click(screen.getByTestId("settings-language-es"));
    fireEvent.click(screen.getByTestId("settings-week-start-0"));
    fireEvent.click(screen.getByTestId("settings-save"));

    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    expect(puts()).toEqual([
      {
        object: "locale",
        settings: { timezone: "Europe/Madrid", language: "es", weekStartDay: 0 },
      },
    ]);
    expect(await screen.findByTestId("settings-saved")).toBeInTheDocument();
    expect(screen.getByTestId("settings-save")).toBeDisabled();
  });

  it("saves only the weather when only the weather changed", async () => {
    mockApi(SETTINGS);
    renderSettings();

    await screen.findByTestId("settings-save");
    fireEvent.change(screen.getByTestId("weather-lat-input"), { target: { value: "41" } });
    fireEvent.click(screen.getByTestId("settings-save"));

    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    expect(puts()).toEqual([
      { object: "weather", settings: { lat: 41, lon: -3.7038, label: "Madrid" } },
    ]);
  });

  it("saves locale then weather on one click", async () => {
    mockApi(SETTINGS);
    renderSettings();

    await screen.findByTestId("settings-save");
    fireEvent.click(screen.getByTestId("settings-week-start-0"));
    fireEvent.change(screen.getByTestId("weather-label-input"), { target: { value: "Home" } });
    fireEvent.click(screen.getByTestId("settings-save"));

    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    expect(puts().map((put) => put.object)).toEqual(["locale", "weather"]);
    expect(puts()[1]!.settings).toEqual({ lat: 40.4168, lon: -3.7038, label: "Home" });
    expect(await screen.findByTestId("settings-saved")).toBeInTheDocument();
  });

  it("keeps the weather edit and still reloads the app when the second request is refused", async () => {
    mockApi(SETTINGS, "weather");
    renderSettings();

    await screen.findByTestId("settings-save");
    fireEvent.click(screen.getByTestId("settings-week-start-0"));
    fireEvent.change(screen.getByTestId("weather-lat-input"), { target: { value: "41" } });
    fireEvent.click(screen.getByTestId("settings-save"));

    const error = await screen.findByTestId("settings-error");
    // Truthful: the locale write succeeded, only the weather failed.
    expect(error).toHaveTextContent(messages.en["admin.settings.partialSaved"]);
    expect(error).toHaveTextContent(messages.en["admin.settings.saveError"]);
    expect(screen.getByTestId("settings-save")).toBeEnabled();
    expect(screen.getByTestId("weather-lat-input")).toHaveValue("41");
    expect(screen.getByTestId("settings-week-start-0")).toBeChecked();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("settings-saved")).not.toBeInTheDocument();
  });

  it("announces a refused save in its own words, never the server's, and keeps the edit", async () => {
    mockApi(SETTINGS, "locale");
    renderSettings();

    await screen.findByTestId("settings-save");
    fireEvent.click(screen.getByTestId("settings-week-start-0"));
    fireEvent.click(screen.getByTestId("settings-save"));

    const error = await screen.findByTestId("settings-error");
    expect(error).toHaveTextContent(messages.en["admin.settings.saveError"]);
    expect(error).not.toHaveTextContent(messages.en["admin.settings.partialSaved"]);
    expect(screen.getByTestId("settings-week-start-0")).toBeChecked();
    expect(screen.getByTestId("settings-save")).toBeEnabled();
    expect(retry).not.toHaveBeenCalled();
  });

  it("falls back to its own message when the save never reaches the server", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (_input, init) => {
      if (init?.method === "PUT") throw new TypeError("network down");
      return jsonResponse(SETTINGS);
    });
    renderSettings();

    await screen.findByTestId("settings-save");
    fireEvent.click(screen.getByTestId("settings-week-start-0"));
    fireEvent.click(screen.getByTestId("settings-save"));

    expect(await screen.findByTestId("settings-error")).toHaveTextContent(
      messages.en["admin.settings.saveError"]
    );
  });

  it("stages Clear and writes it on Save", async () => {
    mockApi(SETTINGS);
    renderSettings();

    await screen.findByTestId("settings-save");
    fireEvent.click(screen.getByTestId("weather-clear"));
    expect(puts()).toEqual([]);
    fireEvent.click(screen.getByTestId("settings-save"));

    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    expect(puts()).toEqual([{ object: "weather", settings: { lat: null, lon: null } }]);
  });

  it("blocks Save and says why while only one coordinate is filled", async () => {
    mockApi(SETTINGS);
    renderSettings();

    await screen.findByTestId("settings-save");
    fireEvent.change(screen.getByTestId("weather-lon-input"), { target: { value: "" } });
    expect(screen.getByTestId("settings-save")).toBeDisabled();
    expect(screen.getByTestId("weather-hint")).toBeInTheDocument();
    expect(puts()).toEqual([]);
  });

  it("leaves weather out when the plugin is inactive", async () => {
    mockApi(NO_WEATHER);
    renderSettings();

    await screen.findByTestId("settings-save");
    expect(screen.queryByTestId("weather-management")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("settings-language-es"));
    fireEvent.click(screen.getByTestId("settings-save"));

    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    expect(puts().map((put) => put.object)).toEqual(["locale"]);
  });

  it('hides "Saved" by itself', { timeout: 10_000 }, async () => {
    mockApi(SETTINGS);
    renderSettings();

    await screen.findByTestId("settings-save");
    fireEvent.click(screen.getByTestId("settings-week-start-0"));
    fireEvent.click(screen.getByTestId("settings-save"));
    expect(await screen.findByTestId("settings-saved")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("settings-saved")).not.toBeInTheDocument(), {
      timeout: 5000,
    });
  });

  it('clears "Saved" as soon as the form is edited again', async () => {
    mockApi(SETTINGS);
    renderSettings();

    await screen.findByTestId("settings-save");
    fireEvent.click(screen.getByTestId("settings-week-start-0"));
    fireEvent.click(screen.getByTestId("settings-save"));
    await screen.findByTestId("settings-saved");
    fireEvent.click(screen.getByTestId("settings-language-es"));
    expect(screen.queryByTestId("settings-saved")).not.toBeInTheDocument();
  });

  it("announces a failed load and retries it", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValue(jsonResponse(SETTINGS));
    renderSettings();

    expect(await screen.findByTestId("settings-error")).toHaveTextContent(
      messages.en["admin.settings.loadError"]
    );
    expect(screen.queryByTestId("settings-save")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("settings-retry"));

    expect(await screen.findByTestId("settings-save")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-error")).not.toBeInTheDocument();
  });

  it("hosts the day periods on the same page", async () => {
    mockApi(SETTINGS);
    renderSettings();

    await screen.findByTestId("settings-save");
    expect(screen.getByTestId("day-periods-stub")).toBeInTheDocument();
  });
});
