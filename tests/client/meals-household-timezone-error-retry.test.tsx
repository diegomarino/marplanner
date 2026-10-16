import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MealsManagement } from "@/admin/MealsManagement";

const HOUSEHOLD_TODAY = "2026-01-16";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("MealsManagement — household timezone setup error", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    cleanup();
  });

  it("shows a retry action when settings fail, then loads the household week after retry succeeds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-15T22:00:00.000Z"));

    let settingsAttempts = 0;
    const mockFetch = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.includes("/api/settings")) {
        settingsAttempts += 1;
        return Promise.resolve(
          settingsAttempts === 1
            ? json(null, 503)
            : json({ locale: { timezone: "Pacific/Kiritimati" } })
        );
      }
      if (url.startsWith("/api/recipes")) return Promise.resolve(json([]));
      if (url.startsWith("/api/meal-plans")) return Promise.resolve(json([]));
      if (url.startsWith("/api/menu")) return Promise.resolve(json([]));
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", mockFetch);

    render(<MealsManagement />);

    expect(await screen.findByText("Failed to load meals data.")).toBeInTheDocument();
    const retryButton = screen.getByRole("button", { name: "Retry" });
    expect(screen.queryByTestId("meal-plan-grid")).not.toBeInTheDocument();

    fireEvent.click(retryButton);

    // The week is requested for the household date (Kiritimati is already on the 16th while
    // UTC is still on the 15th), and the grid marks that date's column.
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(`/api/menu/week?date=${HOUSEHOLD_TODAY}`),
        expect.anything()
      );
      expect(screen.getByTestId(`meal-day-heading-${HOUSEHOLD_TODAY}`)).toBeInTheDocument();
    });
    expect(settingsAttempts).toBe(2);
  });
});
