import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HouseholdSettingsProvider } from "@/lib/householdSettings";
import { useMealsWorkspace } from "@/meals/useMealsWorkspace";

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <HouseholdSettingsProvider>{children}</HouseholdSettingsProvider>
);

function response(value: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(value), { status }));
}

describe("useMealsWorkspace", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("anchors the initial week to the household timezone and configured week start", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-25T23:30:00.000Z"));
    const fetchMock = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/api/settings"))
        return response({ locale: { timezone: "Pacific/Auckland", weekStartDay: 1 } });
      if (url.includes("/api/recipes")) return response([]);
      if (url.includes("/api/menu/week"))
        return response(
          Object.fromEntries(
            [
              "2026-09-21",
              "2026-09-22",
              "2026-09-23",
              "2026-09-24",
              "2026-09-25",
              "2026-09-26",
              "2026-09-27",
            ].map((date) => [date, { breakfast: [], lunch: [], snack: [], dinner: [] }])
          )
        );
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useMealsWorkspace(), { wrapper });
    await waitFor(() => expect(result.current.anchorDate).toBe("2026-09-26"));
    expect(result.current.weekDates).toEqual([
      "2026-09-21",
      "2026-09-22",
      "2026-09-23",
      "2026-09-24",
      "2026-09-25",
      "2026-09-26",
      "2026-09-27",
    ]);
  });

  it("moves seven days and retains the last valid menu when the next read fails", async () => {
    let weekReads = 0;
    const validWeek = { "2026-09-21": { breakfast: [], lunch: [], snack: [], dinner: [] } };
    const fetchMock = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/api/settings"))
        return response({ locale: { timezone: "UTC", weekStartDay: 1 } });
      if (url.includes("/api/recipes")) return response([]);
      if (url.includes("/api/menu/week"))
        return ++weekReads === 1 ? response(validWeek) : response({}, 500);
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));

    const { result } = renderHook(() => useMealsWorkspace(), { wrapper });
    await waitFor(() => expect(result.current.weekMenu).toEqual(validWeek));
    result.current.goNextWeek();
    await waitFor(() => expect(result.current.weekError).not.toBeNull());
    expect(result.current.anchorDate).toBe("2026-10-02");
    expect(result.current.weekMenu).toEqual(validWeek);
  });
});
