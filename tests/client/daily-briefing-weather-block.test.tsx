import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/i18n";
import { DailyBriefingView } from "@/daily-briefing/DailyBriefingView";
import { Role, type Briefing, type BriefingReadResult, type MemberDTO } from "../../src/shared";

/** docs/features/weather.md — Daily Briefing view weather-block render tests
 * (FR-014/022). `@/lib/householdSettings` is mocked so `LanguageProvider` resolves the
 * household language synchronously (the `weather-management.test.tsx` precedent) — the
 * view's OWN `/api/settings` fetch (for the household timezone/date) still goes through
 * the mocked `fetch` below.
 */
const currentSettings = { timezone: "Europe/Madrid", language: "es", weekStartDay: 1 };

vi.mock("@/lib/householdSettings", () => ({
  useHouseholdSettings: () => currentSettings,
  useHouseholdSettingsContext: () => currentSettings,
}));

type FetchCall = Parameters<typeof globalThis.fetch>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

const MEMBER: MemberDTO = {
  id: "m1",
  displayName: "Ada",
  colorKey: "blue",
  role: Role.child,
  lifecycle: "active",
  createdAt: 1,
  updatedAt: 1,
  celebration: { preset: "confetti" },
  birthDate: null,
};

function baseBriefing(): Briefing {
  return {
    id: "b1",
    memberId: "m1",
    date: "2026-09-04",
    status: "ready",
    payload: {
      schemaVersion: 1,
      member: { id: "m1", displayName: "Ada" },
      date: "2026-09-04",
      blocks: [],
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

function briefingWithWeather(): Briefing {
  const briefing = baseBriefing();
  return {
    ...briefing,
    payload: {
      ...briefing.payload,
      blocks: [
        {
          type: "weather",
          scope: "shared",
          status: "ok",
          data: {
            date: "2026-09-04",
            conditionKey: "clear",
            tempMinC: 18,
            tempMaxC: 26,
            rainPct: 5,
          },
        },
      ],
    },
  };
}

function mockFetchFor(briefing: Briefing) {
  return vi.fn(async (...args: FetchCall) => {
    const [input] = args;
    const url = String(input);
    if (url === "/api/settings") {
      return jsonResponse({ locale: currentSettings });
    }
    if (url === "/api/members?lifecycle=all") {
      return jsonResponse([MEMBER]);
    }
    if (url.startsWith("/api/daily-briefing/")) {
      const result: BriefingReadResult = { generated: true, briefing, printedStatus: "none" };
      return jsonResponse(result);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe("DailyBriefingView weather block", () => {
  beforeEach(() => {
    currentSettings.timezone = "Europe/Madrid";
    currentSettings.language = "es";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("renders the weather block localized in Spanish, via the shared condition-key map", async () => {
    vi.stubGlobal("fetch", mockFetchFor(briefingWithWeather()));

    render(
      <LanguageProvider>
        <DailyBriefingView />
      </LanguageProvider>
    );

    const block = await screen.findByTestId("daily-briefing-block-weather");
    // "weather.condition.clear" (es) — proves the render goes through the shared map, not
    // a hardcoded English string.
    expect(block).toHaveTextContent("Despejado");
    // "dailyBriefing.block.weather" (es) title.
    expect(block).toHaveTextContent("Meteorología");
    // formatDayLabel(day.date, "es") for "2026-09-04" (a Friday) — computed once by hand via
    // `new Intl.DateTimeFormat("es", { weekday: "short", day: "numeric" }).format(...)` and
    // pinned literally, so a mutation that swaps in the raw ISO date (or drops the shared
    // Intl formatter entirely, FR-014) turns this assertion red (651-).
    expect(block).toHaveTextContent("vie 4");
  });

  it("renders NOTHING for an absent weather block — no placeholder card", async () => {
    vi.stubGlobal("fetch", mockFetchFor(baseBriefing()));

    render(
      <LanguageProvider>
        <DailyBriefingView />
      </LanguageProvider>
    );

    await screen.findByTestId("daily-briefing-view-status");
    expect(screen.queryByTestId("daily-briefing-block-weather")).not.toBeInTheDocument();
  });
});
