import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DayPeriodsManagement } from "@/admin/DayPeriodsManagement";
import { HouseholdSettingsProvider } from "@/lib/householdSettings";
import { LanguageProvider } from "@/i18n";
import type { DayPeriodDTO } from "../../src/shared";

/** review (P3-a): fences that DayPeriodsManagement's "active now" badge is computed
 * from the household timezone in the shared `useHouseholdSettings` context (* retrofit), not the component's own `useState<string>("Europe/Madrid")` fallback default —
 * a distinctive, non-UTC/non-"Europe/Madrid" zone (Pacific/Kiritimati, UTC+14) at an instant
 * that resolves to a DIFFERENT active period in UTC than in the household zone makes a
 * mutation that drops the context wire-up highlight the WRONG period, not one that happens
 * to coincide with the fallback.
 */
vi.mock("@/lib/adminUnlock", () => ({
  useAdminUnlock: () => ({ unlocked: true, setUnlocked: vi.fn() }),
}));

type FetchCall = Parameters<typeof globalThis.fetch>;

const HOUSEHOLD_TIMEZONE = "Pacific/Kiritimati"; // UTC+14

const PERIODS: DayPeriodDTO[] = [
  { id: "morning", labelKey: "dayPeriod.morning", start: "05:00", sortOrder: 0 },
  { id: "afternoon", labelKey: "dayPeriod.afternoon", start: "12:00", sortOrder: 1 },
  { id: "evening", labelKey: "dayPeriod.evening", start: "18:00", sortOrder: 2 },
  { id: "night", labelKey: "dayPeriod.night", start: "21:00", sortOrder: 3 },
];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function renderManagement() {
  render(
    <HouseholdSettingsProvider>
      <LanguageProvider>
        <DayPeriodsManagement />
      </LanguageProvider>
    </HouseholdSettingsProvider>
  );
}

describe("DayPeriodsManagement — household timezone drives the active-period badge (#648)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    cleanup();
  });

  it("highlights the period active in the HOUSEHOLD timezone, not the one active in UTC", async () => {
    // Freeze "now" at 20:00 UTC — evening (18:00) is the active period in UTC, but
    // Pacific/Kiritimati (UTC+14) has already wrapped to 10:00 the next day, where morning
    // (05:00) is active. Sanity-check this premise so the test can't pass vacuously.
    const FROZEN_NOW = new Date("2026-01-15T20:00:00.000Z");
    const utcMinutes = FROZEN_NOW.getUTCHours() * 60 + FROZEN_NOW.getUTCMinutes();
    const householdParts = new Intl.DateTimeFormat("en-GB", {
      timeZone: HOUSEHOLD_TIMEZONE,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(FROZEN_NOW);
    const householdHour = parseInt(householdParts.find((p) => p.type === "hour")?.value ?? "0", 10);
    const householdMinute = parseInt(
      householdParts.find((p) => p.type === "minute")?.value ?? "0",
      10
    );
    const householdMinutes = householdHour * 60 + householdMinute;
    expect(utcMinutes).toBeGreaterThanOrEqual(18 * 60); // evening in UTC
    expect(utcMinutes).toBeLessThan(21 * 60);
    expect(householdMinutes).toBeGreaterThanOrEqual(5 * 60); // morning in the household tz
    expect(householdMinutes).toBeLessThan(12 * 60);

    // Only Date is faked — setTimeout/setInterval stay real so findByTestId's internal
    // polling (and the component's own next-minute alignment timer) keep working normally
    // (meals-board.test.tsx precedent).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN_NOW);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (...args: FetchCall) => {
        const [input] = args;
        const url = String(input);
        if (url === "/api/settings") {
          return jsonResponse({
            locale: { timezone: HOUSEHOLD_TIMEZONE, language: "en", weekStartDay: 1 },
          });
        }
        if (url === "/api/day-periods") return jsonResponse(PERIODS);
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    renderManagement();

    await waitFor(() => {
      expect(screen.getByTestId("day-period-morning")).toHaveTextContent("Active now");
    });
    expect(screen.getByTestId("day-period-evening")).not.toHaveTextContent("Active now");
  });
});
