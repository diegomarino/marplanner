import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeviceScreenSettings } from "@/admin/DeviceScreenSettings";
import { NIGHT_PEEK_MS, ScreenAwake, wallClockMinutes } from "@/shell/ScreenAwake";
import {
  DEFAULT_SCREEN_AWAKE,
  loadScreenAwakePreferences,
  saveScreenAwakePreferences,
  SCREEN_AWAKE_CHANGE_EVENT,
  SCREEN_AWAKE_STORAGE_KEY,
  screenAwakeSupport,
} from "@/shell/screenAwake";

const PERIODS = [
  { id: "morning", labelKey: "dayPeriods.morning", start: "07:00", sortOrder: 0 },
  { id: "afternoon", labelKey: "dayPeriods.afternoon", start: "13:00", sortOrder: 1 },
  { id: "evening", labelKey: "dayPeriods.evening", start: "18:00", sortOrder: 2 },
  { id: "night", labelKey: "dayPeriods.night", start: "21:00", sortOrder: 3 },
];

interface FakeSentinel {
  released: boolean;
  release: ReturnType<typeof vi.fn>;
}

function installWakeLock() {
  const sentinels: FakeSentinel[] = [];
  const request = vi.fn(() => {
    const sentinel: FakeSentinel = {
      released: false,
      release: vi.fn(() => {
        sentinel.released = true;
        return Promise.resolve();
      }),
    };
    sentinels.push(sentinel);
    return Promise.resolve(sentinel);
  });
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
  return { request, sentinels, held: () => sentinels.filter((s) => !s.released) };
}

function stubDayPeriods(response: () => Response = () => Response.json(PERIODS)) {
  const fetchMock = vi.fn((input: RequestInfo | URL) =>
    Promise.resolve(String(input).includes("/api/day-periods") ? response() : Response.json({}))
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "wakeLock");
});

describe("screenAwake preferences", () => {
  it("defaults to off with night dimming when nothing, garbage or a non-object is stored", () => {
    expect(loadScreenAwakePreferences()).toEqual(DEFAULT_SCREEN_AWAKE);
    window.localStorage.setItem(SCREEN_AWAKE_STORAGE_KEY, "{not json");
    expect(loadScreenAwakePreferences()).toEqual(DEFAULT_SCREEN_AWAKE);
    window.localStorage.setItem(SCREEN_AWAKE_STORAGE_KEY, "42");
    expect(loadScreenAwakePreferences()).toEqual(DEFAULT_SCREEN_AWAKE);
  });

  it("round-trips a saved choice and announces it to this tab", () => {
    const heard = vi.fn();
    window.addEventListener(SCREEN_AWAKE_CHANGE_EVENT, heard);
    saveScreenAwakePreferences({ enabled: true, night: "off" });
    window.removeEventListener(SCREEN_AWAKE_CHANGE_EVENT, heard);
    expect(loadScreenAwakePreferences()).toEqual({ enabled: true, night: "off" });
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("still announces the change when storage refuses the write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const heard = vi.fn();
    window.addEventListener(SCREEN_AWAKE_CHANGE_EVENT, heard);
    saveScreenAwakePreferences({ enabled: true, night: "dim" });
    window.removeEventListener(SCREEN_AWAKE_CHANGE_EVENT, heard);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("reports support, the HTTPS requirement and a missing API", () => {
    expect(screenAwakeSupport()).toBe("unsupported");
    installWakeLock();
    expect(screenAwakeSupport()).toBe("supported");
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
    expect(screenAwakeSupport()).toBe("insecure-context");
  });

  it("reads the wall clock in the household zone or the browser zone", () => {
    const instant = new Date("2026-11-08T22:30:00Z");
    expect(wallClockMinutes(instant, "UTC")).toBe(22 * 60 + 30);
    expect(wallClockMinutes(instant, "Asia/Tokyo")).toBe(7 * 60 + 30);
    expect(typeof wallClockMinutes(instant, null)).toBe("number");
  });
});

describe("ScreenAwake service", () => {
  it("does nothing and fetches nothing while the device setting is off", async () => {
    const wakeLock = installWakeLock();
    const fetchMock = stubDayPeriods();
    render(<ScreenAwake />);
    await flush();
    expect(wakeLock.request).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("holds a lock during the day, re-acquires it on return to visible and releases it when turned off", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-08T10:00:00"));
    const wakeLock = installWakeLock();
    stubDayPeriods();
    saveScreenAwakePreferences({ enabled: true, night: "dim" });
    render(<ScreenAwake />);
    await flush();
    expect(wakeLock.held()).toHaveLength(1);
    expect(screen.queryByTestId("screen-awake-night-dim")).toBeNull();

    // Becoming visible while the lock is still held asks for nothing new.
    setVisibility("visible");
    await flush();
    expect(wakeLock.request).toHaveBeenCalledTimes(1);

    // The browser drops the lock itself when the page is hidden.
    wakeLock.sentinels[0].released = true;
    setVisibility("hidden");
    await flush();
    expect(wakeLock.request).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    await flush();
    expect(wakeLock.request).toHaveBeenCalledTimes(2);
    expect(wakeLock.held()).toHaveLength(1);

    act(() => saveScreenAwakePreferences({ enabled: false, night: "dim" }));
    await flush();
    expect(wakeLock.held()).toHaveLength(0);
  });

  it("follows a change made in another tab through the storage event", async () => {
    const wakeLock = installWakeLock();
    stubDayPeriods();
    render(<ScreenAwake />);
    await flush();
    window.localStorage.setItem(
      SCREEN_AWAKE_STORAGE_KEY,
      JSON.stringify({ enabled: true, night: "dim" })
    );
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }));
    });
    await flush();
    expect(wakeLock.request).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: SCREEN_AWAKE_STORAGE_KEY }));
    });
    await flush();
    expect(wakeLock.request).toHaveBeenCalledTimes(1);
  });

  it("dims at night while keeping the lock, and a tap lifts the dimming for a while", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-11-08T23:00:00"));
    const wakeLock = installWakeLock();
    stubDayPeriods();
    saveScreenAwakePreferences({ enabled: true, night: "dim" });
    render(<ScreenAwake />);
    await flush();
    expect(wakeLock.held()).toHaveLength(1);
    const layer = screen.getByTestId("screen-awake-night-dim");

    fireEvent.pointerDown(layer);
    expect(screen.queryByTestId("screen-awake-night-dim")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(NIGHT_PEEK_MS);
    });
    expect(screen.getByTestId("screen-awake-night-dim")).toBeTruthy();
  });

  it("lifts the dimming by itself when the morning period starts", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-11-08T06:59:00"));
    installWakeLock();
    stubDayPeriods();
    saveScreenAwakePreferences({ enabled: true, night: "dim" });
    render(<ScreenAwake />);
    await flush();
    expect(screen.getByTestId("screen-awake-night-dim")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.queryByTestId("screen-awake-night-dim")).toBeNull();
  });

  it("releases the lock at night when the night choice is off", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-08T23:00:00"));
    const wakeLock = installWakeLock();
    stubDayPeriods();
    saveScreenAwakePreferences({ enabled: true, night: "off" });
    render(<ScreenAwake />);
    await flush();
    expect(wakeLock.held()).toHaveLength(0);
    expect(screen.queryByTestId("screen-awake-night-dim")).toBeNull();
  });

  it("stays awake as daytime when the day periods cannot be read or the lock is refused", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-08T23:00:00"));
    const request = vi.fn(() => Promise.reject(new Error("NotAllowedError")));
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
    stubDayPeriods(() => new Response("nope", { status: 500 }));
    saveScreenAwakePreferences({ enabled: true, night: "dim" });
    render(<ScreenAwake />);
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("screen-awake-night-dim")).toBeNull();
  });

  it("treats a malformed day-period catalog as daytime instead of failing", async () => {
    installWakeLock();
    stubDayPeriods(() => Response.json(PERIODS.map((period) => ({ ...period, start: "late" }))));
    saveScreenAwakePreferences({ enabled: true, night: "dim" });
    render(<ScreenAwake />);
    await flush();
    expect(screen.queryByTestId("screen-awake-night-dim")).toBeNull();
  });

  it("releases a lock that resolves after the service was unmounted", async () => {
    let resolve: (sentinel: FakeSentinel) => void = () => undefined;
    const sentinel: FakeSentinel = { released: false, release: vi.fn(() => Promise.resolve()) };
    const request = vi.fn(() => new Promise<FakeSentinel>((r) => (resolve = r)));
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
    stubDayPeriods();
    saveScreenAwakePreferences({ enabled: true, night: "dim" });
    const view = render(<ScreenAwake />);
    view.unmount();
    resolve(sentinel);
    await flush();
    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });
});

describe("DeviceScreenSettings", () => {
  it("saves the keep-awake and night choices to this device at once", () => {
    installWakeLock();
    render(<DeviceScreenSettings />);
    const night = screen.getByTestId("device-screen-awake-night-off") as HTMLInputElement;
    expect(night.disabled).toBe(true);
    expect(screen.getByTestId("device-screen-awake-support").dataset.support).toBe("supported");

    fireEvent.click(screen.getByTestId("device-screen-awake-on"));
    expect(loadScreenAwakePreferences()).toEqual({ enabled: true, night: "dim" });
    fireEvent.click(screen.getByTestId("device-screen-awake-night-off"));
    expect(loadScreenAwakePreferences()).toEqual({ enabled: true, night: "off" });
    fireEvent.click(screen.getByTestId("device-screen-awake-off"));
    expect(loadScreenAwakePreferences()).toEqual({ enabled: false, night: "off" });
  });

  it("explains that plain http cannot keep the screen on", () => {
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
    render(<DeviceScreenSettings />);
    expect(screen.getByTestId("device-screen-awake-support").dataset.support).toBe(
      "insecure-context"
    );
  });
});
