import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/i18n";
import { PrinterDiagnosticsTab, RECENT_PRINTS_LIMIT } from "@/admin/printer/PrinterDiagnosticsTab";
import type { PrintJob } from "../../src/shared";
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

function makeJob(overrides: Partial<PrintJob> = {}): PrintJob {
  return {
    id: "job-1",
    recordKey: "test-print",
    outputRef: "test-print:2026-10-15",
    targetDate: "2026-10-15",
    memberId: null,
    state: "printed",
    derivedState: "printed",
    attempts: 0,
    failureReason: null,
    claimedAt: null,
    printedAt: null,
    createdAt: Date.UTC(2026, 9, 15, 6, 30),
    updatedAt: Date.UTC(2026, 9, 15, 6, 30),
    ...overrides,
  };
}

const MEMBERS = [{ id: "m-lisa", displayName: "Lisa" }];

function routes(jobs: PrintJob[], extra: Record<string, () => Response> = {}) {
  return stubFetchRoutes({
    "GET /api/printing/jobs": () => json({ jobs }),
    "GET /api/members?lifecycle=all": () => json(MEMBERS),
    ...extra,
  });
}

function renderTab() {
  return render(
    <LanguageProvider>
      <PrinterDiagnosticsTab />
    </LanguageProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PrinterDiagnosticsTab — recent prints", () => {
  it("renders member, source, status, attempts and failure reason per job", async () => {
    routes([
      makeJob({
        id: "j-brief",
        recordKey: "daily-briefing:m-lisa",
        memberId: "m-lisa",
        state: "failed",
        derivedState: "dead-letter",
        attempts: 2,
        failureReason: "render_failure: provider error",
      }),
      makeJob({ id: "j-test" }),
      makeJob({ id: "j-other", recordKey: "custom-producer:1", memberId: "m-gone" }),
    ]);
    renderTab();
    await flush();

    const brief = screen.getByTestId("printing-job-j-brief");
    expect(within(brief).getByText("Lisa")).toBeInTheDocument();
    expect(within(brief).getByText("Daily briefing")).toBeInTheDocument();
    expect(within(brief).getByText("2")).toBeInTheDocument();
    expect(within(brief).getByText("render_failure: provider error")).toBeInTheDocument();
    expect(screen.getByTestId("printing-job-state-j-brief")).toHaveTextContent("Dead-lettered");
    expect(screen.getByTestId("printing-job-state-j-brief")).toHaveAttribute("role", "alert");
    expect(
      within(screen.getByTestId("printing-job-j-test")).getByText("Test print")
    ).toBeInTheDocument();
    const other = screen.getByTestId("printing-job-j-other");
    expect(within(other).getByText("custom-producer:1")).toBeInTheDocument();
    expect(within(other).getByText("—")).toBeInTheDocument(); // unknown member
  });

  it("still renders the table with '—' when the members read fails", async () => {
    stubFetchRoutes({
      "GET /api/printing/jobs": () => json({ jobs: [makeJob({ memberId: "m-lisa" })] }),
      "GET /api/members?lifecycle=all": () => json({ error: "boom" }, 500),
    });
    renderTab();
    await flush();
    expect(within(screen.getByTestId("printing-job-job-1")).getByText("—")).toBeInTheDocument();
  });

  it("shows at most RECENT_PRINTS_LIMIT rows and says so", async () => {
    const many = Array.from({ length: RECENT_PRINTS_LIMIT + 5 }, (_, i) =>
      makeJob({ id: `j${i}` })
    );
    routes(many);
    renderTab();
    await flush();
    expect(screen.getAllByTestId(/^printing-job-j\d+$/)).toHaveLength(RECENT_PRINTS_LIMIT);
    expect(screen.getByText("Showing the latest 50.")).toBeInTheDocument();
  });

  it("shows the empty state", async () => {
    routes([]);
    renderTab();
    await flush();
    expect(screen.getByTestId("printing-jobs-empty")).toBeInTheDocument();
  });

  it("offers Retry after a jobs load failure and recovers", async () => {
    let fail = true;
    stubFetchRoutes({
      "GET /api/printing/jobs": () =>
        fail ? json({ error: "x" }, 500) : json({ jobs: [makeJob()] }),
      "GET /api/members?lifecycle=all": () => json(MEMBERS),
    });
    renderTab();
    await flush();
    expect(screen.getByTestId("printing-list-error")).toHaveTextContent(
      "Failed to load print jobs."
    );
    fail = false;
    fireEvent.click(screen.getByTestId("printing-jobs-retry"));
    await flush();
    expect(screen.getByTestId("printing-job-job-1")).toBeInTheDocument();
  });

  it("Refresh reloads the jobs", async () => {
    const mock = routes([]);
    renderTab();
    await flush();
    fireEvent.click(screen.getByTestId("printing-jobs-refresh"));
    await flush();
    const jobReads = mock.mock.calls.filter(([input]) =>
      String(input).endsWith("/api/printing/jobs")
    );
    expect(jobReads).toHaveLength(2);
  });
});

describe("PrinterDiagnosticsTab — test print", () => {
  it.each([
    [json({ enqueued: true, jobId: "j9" }), "Test print enqueued.", false],
    [
      json({ enqueued: false, jobId: "j9", alreadyPrinted: true }),
      "Already printed for today — not re-enqueued.",
      false,
    ],
    [json({ error: "plugin_inactive" }, 409), "The Printing plugin is inactive.", true],
    [json({ error: "x" }, 500), "Failed to trigger the test print.", true],
  ])("shows the trigger outcome (%#)", async (response, message, isAlert) => {
    routes([], { "POST /api/printing/test-print": () => response });
    renderTab();
    await flush();
    fireEvent.click(screen.getByTestId("printing-trigger-test-print"));
    await flush();
    const result = screen.getByTestId("printing-trigger-result");
    expect(result).toHaveTextContent(message);
    if (isAlert) expect(result).toHaveAttribute("role", "alert");
    else expect(result).not.toHaveAttribute("role", "alert");
  });
});

describe("PrinterDiagnosticsTab — reset today's print", () => {
  async function openAndConfirm() {
    fireEvent.click(screen.getByTestId("printing-reset-today"));
    fireEvent.click(await screen.findByTestId("printing-reset-today-confirm"));
    await flush();
  }

  it("confirms, posts, reports the counts and reloads the table", async () => {
    const mock = routes([], {
      "POST /api/printing/reset-today": () =>
        json({ targetDate: "2026-10-15", resetRecords: 2, cancelledJobs: 1 }),
    });
    renderTab();
    await flush();
    await openAndConfirm();
    expect(screen.getByTestId("printing-reset-today-result")).toHaveTextContent(
      "Today's print was reset: 2 record(s) can print again, 1 queued job(s) cancelled."
    );
    const jobReads = mock.mock.calls.filter(([input]) =>
      String(input).endsWith("/api/printing/jobs")
    );
    expect(jobReads).toHaveLength(2);
  });

  it("says when there was nothing to reset", async () => {
    routes([], {
      "POST /api/printing/reset-today": () =>
        json({ targetDate: "2026-10-15", resetRecords: 0, cancelledJobs: 0 }),
    });
    renderTab();
    await flush();
    await openAndConfirm();
    expect(screen.getByTestId("printing-reset-today-result")).toHaveTextContent(
      "Nothing was printed or queued today."
    );
  });

  it.each([
    [409, "The Printing plugin is inactive."],
    [500, "Could not reset today's print."],
  ])("announces a %s failure", async (status, message) => {
    routes([], { "POST /api/printing/reset-today": () => json({ error: "x" }, status) });
    renderTab();
    await flush();
    await openAndConfirm();
    const result = screen.getByTestId("printing-reset-today-result");
    expect(result).toHaveTextContent(message);
    expect(result).toHaveAttribute("role", "alert");
  });

  it("Cancel closes the dialog without posting", async () => {
    const mock = routes([]);
    renderTab();
    await flush();
    fireEvent.click(screen.getByTestId("printing-reset-today"));
    fireEvent.click(await screen.findByTestId("printing-reset-today-cancel"));
    await flush();
    expect(mock.mock.calls.some(([input]) => String(input).includes("reset-today"))).toBe(false);
  });
});
