import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DailyMessagesManagement } from "@/admin/DailyMessagesManagement";
import { MealsManagement } from "@/admin/MealsManagement";
import { RemindersManagement } from "@/admin/RemindersManagement";
import { HouseholdSettingsProvider } from "@/lib/householdSettings";
import { LanguageProvider } from "@/i18n";

const HOUSEHOLD_TIMEZONE = "Pacific/Kiritimati";
const HOUSEHOLD_TODAY = "2026-01-16";
const FROZEN_NOW = new Date("2026-01-15T22:00:00.000Z");

const activeMember = {
  id: "member-1",
  displayName: "Ada",
  role: "parent",
  lifecycle: "active",
  birthDate: null,
  avatar: null,
  createdAt: 0,
  updatedAt: 0,
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function mockFetch(input: string | URL): Promise<Response> {
  const url = String(input);
  if (url.includes("/api/settings")) {
    return Promise.resolve(json({ locale: { language: "en", timezone: HOUSEHOLD_TIMEZONE } }));
  }
  if (url.startsWith("/api/members")) return Promise.resolve(json([activeMember]));
  if (url.startsWith("/api/daily-messages")) return Promise.resolve(json([]));
  if (url.startsWith("/api/reminders")) {
    return Promise.resolve(
      json([
        {
          id: "reminder-1",
          kind: "calendar_gated",
          targetingMode: "apply_to_all",
          text: "Pack a coat",
          weekdays: null,
          query: "coat",
          queryFields: ["title", "description"],
          active: true,
          assignments: [],
        },
      ])
    );
  }
  if (url.startsWith("/api/recipes")) return Promise.resolve(json([]));
  if (url.startsWith("/api/meal-plans")) return Promise.resolve(json([]));
  if (url.startsWith("/api/menu")) return Promise.resolve(json([]));
  throw new Error(`Unexpected fetch: ${url}`);
}

describe("admin business-date defaults", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    cleanup();
  });

  it("uses locale.timezone rather than the browser date for Daily Messages, Meals, and Reminders dry-run", async () => {
    // The browser/JSDOM timezone is deliberately not part of this expected-value
    // calculation. At this frozen instant Kiritimati has crossed midnight while
    // the UTC/browser-side date has not; each panel must obtain the business date
    // from the household IANA timezone returned by /api/settings.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN_NOW);
    const fetchSpy = vi.fn(mockFetch);
    vi.stubGlobal("fetch", fetchSpy);

    render(
      <HouseholdSettingsProvider>
        <LanguageProvider>
          <DailyMessagesManagement />
        </LanguageProvider>
      </HouseholdSettingsProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId(`daily-messages-day-${HOUSEHOLD_TODAY}`)).toBeInTheDocument();
      expect(screen.getAllByTestId(/^daily-messages-day-/)).toHaveLength(14);
    });
    cleanup();

    render(
      <LanguageProvider>
        <MealsManagement />
      </LanguageProvider>
    );
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/api/menu/week?date=${HOUSEHOLD_TODAY}`),
        expect.anything()
      );
      expect(screen.getByTestId(`meal-day-heading-${HOUSEHOLD_TODAY}`)).toBeInTheDocument();
    });
    cleanup();

    render(
      <HouseholdSettingsProvider>
        <LanguageProvider>
          <RemindersManagement />
        </LanguageProvider>
      </HouseholdSettingsProvider>
    );
    fireEvent.click(await screen.findByRole("button", { name: "Dry-run" }));
    expect(screen.getByLabelText("Date")).toHaveValue(HOUSEHOLD_TODAY);
  });
});
