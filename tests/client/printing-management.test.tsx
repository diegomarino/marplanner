import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/i18n";
import { PrintingManagement } from "@/admin/PrintingManagement";
import { json, stubFetchRoutes } from "./helpers/fetchRoutes";

vi.mock("@/lib/householdSettings", () => ({
  useHouseholdSettingsContext: () => ({
    timezone: "Europe/Madrid",
    language: "en",
    weekStartDay: 1,
    weatherLat: null,
    weatherLon: null,
    weatherLabel: null,
  }),
}));

async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PrintingManagement", () => {
  it("is titled like the sidebar and opens on Settings; Diagnostics loads the jobs", async () => {
    const mock = stubFetchRoutes({
      "GET /api/settings": () =>
        json({
          locale: { timezone: "Europe/Madrid", language: "en", weekStartDay: 1 },
          printer: { paperWidthDots: 576 },
          printerTransport: { deviceId: "", name: "", serviceUuid: "", characteristicUuid: "" },
        }),
      "GET /api/daily-briefing/settings": () => json({ autoPrintTrigger: null }),
      "GET /api/printing/jobs": () => json({ jobs: [] }),
      "GET /api/members?lifecycle=all": () => json([]),
    });
    render(
      <LanguageProvider>
        <PrintingManagement />
      </LanguageProvider>
    );
    await flush();

    expect(screen.getByRole("heading", { name: "Printer" })).toBeInTheDocument();
    expect(screen.getByTestId("printing-tab-settings")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("printer-settings")).toBeInTheDocument();
    expect(screen.queryByTestId("printer-diagnostics")).not.toBeInTheDocument();
    expect(mock.mock.calls.some(([input]) => String(input).endsWith("/api/printing/jobs"))).toBe(
      false
    );

    fireEvent.click(screen.getByTestId("printing-tab-diagnostics"));
    await flush();
    expect(screen.getByTestId("printing-tab-diagnostics")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("printing-jobs-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("printer-settings")).not.toBeInTheDocument();
  });
});
