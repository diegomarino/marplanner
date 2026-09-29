import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { authFetch } from "@/lib/credential";
import { log } from "@/lib/logger";
import { HouseholdSettingsProvider, useHouseholdSettings } from "@/lib/householdSettings";
import { LanguageProvider, useT, useTranslation } from "@/i18n";
import { resolveLang } from "@/i18n/messages";
import {
  applyStoredDensity,
  DENSITY_ATTRIBUTE,
  DENSITY_STORAGE_KEY,
  setDensity,
} from "@/shell/densityAttribute";
import { usePresentationMode } from "@/shell/usePresentationMode";
import { AdminUnlockProvider, isAdminPinBypassEnabled, useAdminUnlock } from "@/lib/adminUnlock";

vi.mock("@/lib/credential", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/credential")>()),
  authFetch: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ log: vi.fn() }));
const fetchSettings = vi.mocked(authFetch);
const telemetryLog = vi.mocked(log);
const reply = (body: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    json: async () => body,
  }) as Response;

function SettingsProbe() {
  const value = useHouseholdSettings();
  return (
    <div>
      <output data-testid="settings-status">{value.status}</output>
      <output data-testid="settings-locale">{`${value.timezone}|${value.language}|${value.weekStartDay}`}</output>
      <output data-testid="settings-weather">{`${value.weatherLat}|${value.weatherLon}|${value.weatherLabel}`}</output>
      <button onClick={value.retry}>Retry settings</button>
    </div>
  );
}
function LanguageProbe() {
  const { language, t } = useTranslation();
  return <output data-testid="language">{`${language}:${t("shell.nav.home")}`}</output>;
}

beforeEach(() => {
  fetchSettings.mockReset();
  telemetryLog.mockReset();
  window.localStorage.clear();
  document.documentElement.removeAttribute(DENSITY_ATTRIBUTE);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("B0 client settings and localization", () => {
  it("provides an inert fallback outside the provider", () => {
    const { result } = renderHook(() => useHouseholdSettings());
    expect(result.current).toMatchObject({ status: "loading", timezone: null, weatherLat: null });
    act(() => result.current.retry());
    expect(fetchSettings).not.toHaveBeenCalled();
  });

  it("loads core locale once, keeps absent weather blank, and shares the read with i18n", async () => {
    fetchSettings.mockResolvedValue(
      reply({ locale: { timezone: "Europe/Madrid", language: "es", weekStartDay: 1 } })
    );
    render(
      <HouseholdSettingsProvider>
        <LanguageProvider>
          <SettingsProbe />
          <LanguageProbe />
        </LanguageProvider>
      </HouseholdSettingsProvider>
    );
    await waitFor(() => expect(screen.getByTestId("settings-status")).toHaveTextContent("ready"));
    expect(screen.getByTestId("settings-locale")).toHaveTextContent("Europe/Madrid|es|1");
    expect(screen.getByTestId("settings-weather")).toHaveTextContent("null|null|null");
    await waitFor(() => expect(screen.getByTestId("language")).toHaveTextContent("es:"));
    expect(fetchSettings).toHaveBeenCalledTimes(1);
    expect(fetchSettings).toHaveBeenCalledWith("/api/settings", { credentials: "include" });
  });

  it("rejects an unusable timezone and lets a shared retry recover with a complete weather pair", async () => {
    fetchSettings
      .mockResolvedValueOnce(
        reply({
          locale: { timezone: "invalid/zone", language: "en", weekStartDay: 0 },
          weather: { lat: 1, lon: null },
        })
      )
      .mockResolvedValueOnce(
        reply({
          locale: { timezone: "UTC", language: "en", weekStartDay: 0 },
          weather: { lat: 39.78, lon: -89.64, label: "Synthetic" },
        })
      );
    render(
      <HouseholdSettingsProvider>
        <SettingsProbe />
      </HouseholdSettingsProvider>
    );
    await waitFor(() => expect(screen.getByTestId("settings-status")).toHaveTextContent("error"));
    expect(screen.getByTestId("settings-weather")).toHaveTextContent("null|null|null");
    await act(async () => screen.getByRole("button", { name: "Retry settings" }).click());
    await waitFor(() => expect(screen.getByTestId("settings-status")).toHaveTextContent("ready"));
    expect(screen.getByTestId("settings-weather")).toHaveTextContent("39.78|-89.64|Synthetic");
    expect(fetchSettings).toHaveBeenCalledTimes(2);
  });

  it("contains unauthorized and network failures without exposing invented settings", async () => {
    fetchSettings
      .mockResolvedValueOnce(reply({}, 401))
      .mockRejectedValueOnce(new Error("synthetic network failure"));
    render(
      <HouseholdSettingsProvider>
        <SettingsProbe />
      </HouseholdSettingsProvider>
    );
    await waitFor(() => expect(screen.getByTestId("settings-status")).toHaveTextContent("error"));
    expect(screen.getByTestId("settings-locale")).toHaveTextContent("null|null|null");
    await act(async () => screen.getByRole("button", { name: "Retry settings" }).click());
    await waitFor(() => expect(fetchSettings).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("settings-status")).toHaveTextContent("error");
  });

  it("uses standalone language fetch when no household provider is mounted", async () => {
    fetchSettings.mockResolvedValue(reply({ locale: { language: "es" } }));
    render(
      <LanguageProvider>
        <LanguageProbe />
      </LanguageProvider>
    );
    await waitFor(() => expect(screen.getByTestId("language")).toHaveTextContent("es:"));
    expect(fetchSettings).toHaveBeenCalledTimes(1);
  });

  it("falls back to English when standalone language fetch fails", async () => {
    fetchSettings.mockRejectedValue(new Error("synthetic outage"));
    render(
      <LanguageProvider>
        <LanguageProbe />
      </LanguageProvider>
    );
    await waitFor(() => expect(fetchSettings).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("language")).toHaveTextContent("en:Home");
  });

  it("reports an unknown translation only once per locale and returns its key outside a provider", () => {
    fetchSettings.mockResolvedValue(reply({ locale: { language: "en" } }));
    const Missing = () => {
      const t = useT();
      t("__synthetic_missing__" as never);
      t("__synthetic_missing__" as never);
      return <span>{t("shell.nav.home")}</span>;
    };
    render(
      <LanguageProvider>
        <Missing />
      </LanguageProvider>
    );
    expect(screen.getByText("Home")).toBeVisible();
    expect(telemetryLog).toHaveBeenCalledWith("warn", "i18n", "missing_key", {
      translationId: "__synthetic_missing__",
      locale: "en",
    });
    expect(telemetryLog).toHaveBeenCalledTimes(1);
    expect(resolveLang("fr")).toBe("en");
    expect(resolveLang("es")).toBe("es");
    const { result } = renderHook(() => useTranslation());
    expect(result.current.t("__another_synthetic_missing__" as never)).toBe(
      "__another_synthetic_missing__"
    );
  });
});

describe("B0 device presentation state", () => {
  it("applies stored density without persisting a default and persists only a user choice", () => {
    applyStoredDensity();
    expect(document.documentElement).not.toHaveAttribute(DENSITY_ATTRIBUTE);
    expect(window.localStorage.getItem(DENSITY_STORAGE_KEY)).toBeNull();
    setDensity("kiosk");
    expect(document.documentElement).toHaveAttribute(DENSITY_ATTRIBUTE, "kiosk");
    expect(window.localStorage.getItem(DENSITY_STORAGE_KEY)).toBe("kiosk");
    document.documentElement.removeAttribute(DENSITY_ATTRIBUTE);
    applyStoredDensity();
    expect(document.documentElement).toHaveAttribute(DENSITY_ATTRIBUTE, "kiosk");
    setDensity("comfortable");
    expect(document.documentElement).not.toHaveAttribute(DENSITY_ATTRIBUTE);
  });

  it("tracks display-mode changes and removes its listeners on unmount", () => {
    const listeners = new Map<string, Set<() => void>>();
    const standalone = {
      matches: false,
      addEventListener: vi.fn((_: string, fn: () => void) => {
        const set = listeners.get("standalone") ?? new Set();
        set.add(fn);
        listeners.set("standalone", set);
      }),
      removeEventListener: vi.fn(),
    };
    const fullscreen = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => (query.includes("standalone") ? standalone : fullscreen))
    );
    const { result, unmount } = renderHook(() => usePresentationMode());
    expect(result.current).toBe(false);
    standalone.matches = true;
    act(() => {
      for (const listener of listeners.get("standalone") ?? []) listener();
    });
    expect(result.current).toBe(true);
    unmount();
    expect(standalone.removeEventListener).toHaveBeenCalled();
    expect(fullscreen.removeEventListener).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("keeps admin unlock client-local and bypass disabled under tests", () => {
    expect(isAdminPinBypassEnabled()).toBe(false);
    const { result } = renderHook(() => useAdminUnlock(), { wrapper: AdminUnlockProvider });
    expect(result.current.unlocked).toBe(false);
    act(() => result.current.setUnlocked(true));
    expect(result.current.unlocked).toBe(true);
  });

  it("boots the B1 provisioning gate, enters the real shell, and captures global failures", async () => {
    window.localStorage.setItem(DENSITY_STORAGE_KEY, "kiosk");
    fetchSettings.mockResolvedValue(
      reply({ locale: { timezone: "Europe/Madrid", language: "en", weekStartDay: 1 } })
    );
    const provisionFetch = vi.fn().mockResolvedValue(reply({ provisioned: true }));
    vi.stubGlobal("fetch", provisionFetch);
    document.cookie = "mp_provisioned=; Max-Age=0; Path=/";
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    try {
      await import("@/main");
      await waitFor(() => expect(screen.getByTestId("provisioning-gate-panel")).toBeVisible());
      expect(fetchSettings).not.toHaveBeenCalled();
      fireEvent.change(screen.getByTestId("provisioning-gate-input"), {
        target: { value: "synthetic-key" },
      });
      fireEvent.click(screen.getByTestId("provisioning-gate-submit"));
      await waitFor(() => expect(screen.getByTestId("home-surface")).toBeVisible());
      expect(provisionFetch).toHaveBeenCalledWith(
        "/api/auth/provision",
        expect.objectContaining({ method: "POST" })
      );
      expect(root.querySelector("main h1")?.textContent).toBe("Marplanner");
      expect(document.documentElement).toHaveAttribute(DENSITY_ATTRIBUTE, "kiosk");
      window.dispatchEvent(
        new ErrorEvent("error", { error: new Error("synthetic script failure") })
      );
      const rejection = new Event("unhandledrejection") as Event & { reason: unknown };
      rejection.reason = new Error("synthetic promise failure");
      window.dispatchEvent(rejection);
      expect(telemetryLog).toHaveBeenCalledWith(
        "error",
        "client.global",
        "unhandled_error",
        expect.objectContaining({ message: "synthetic script failure" })
      );
      expect(telemetryLog).toHaveBeenCalledWith(
        "error",
        "client.global",
        "unhandled_rejection",
        expect.objectContaining({ message: "synthetic promise failure" })
      );
    } finally {
      root.remove();
      vi.unstubAllGlobals();
    }
  });
});
