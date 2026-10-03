import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/i18n";
import { PrintingManagement } from "@/admin/PrintingManagement";
import type { JobsListResponse, PrintJob } from "../../src/shared";

/** (FR-012/FR-013/FR-018, SC-003). `derivedState` rendering is the load-bearing
 * assertion: dead-letter/retrying must show their OWN distinct label, never the "pending"
 * label (the trap-sweep's named false-green for this module).
 * `useHouseholdSettingsContext` is mocked so `LanguageProvider` never performs its own
 * `/api/settings` self-fetch — without this, that call races the panel's own `loadJobs` for
 * the SAME mocked `fetch` queue (both fire on mount) and steals a queued response meant for a
 * `/api/printing/*` call (the executor test's precedent for this exact mock).
 */
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

async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function renderPanel() {
  return render(
    <LanguageProvider>
      <PrintingManagement />
    </LanguageProvider>
  );
}

function makeJob(overrides: Partial<PrintJob> = {}): PrintJob {
  return {
    id: "job-1",
    recordKey: "test-printable",
    outputRef: "ref-1",
    targetDate: "2026-09-07",
    memberId: null,
    state: "pending",
    derivedState: "pending",
    attempts: 0,
    failureReason: null,
    claimedAt: null,
    printedAt: null,
    createdAt: 900,
    updatedAt: 900,
    ...overrides,
  };
}

function jobsResponse(jobs: PrintJob[]): Response {
  const body: JobsListResponse = { jobs };
  return new Response(JSON.stringify(body), { status: 200 });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("PrintingManagement", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the empty state when there are no jobs", async () => {
    mockFetch.mockResolvedValueOnce(jobsResponse([]));
    renderPanel();
    await flushMicrotasks();

    expect(screen.getByTestId("printing-jobs-empty")).toBeInTheDocument();
  });

  it("shows a load error and suppresses the empty-state text on a failed list read", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 500 }));
    renderPanel();
    await flushMicrotasks();

    expect(screen.getByTestId("printing-list-error")).toBeInTheDocument();
    expect(screen.queryByTestId("printing-jobs-empty")).not.toBeInTheDocument();
  });

  it("renders dead-letter and retrying DISTINCTLY from pending — never collapsed (SC-003)", async () => {
    mockFetch.mockResolvedValueOnce(
      jobsResponse([
        makeJob({ id: "job-pending", derivedState: "pending" }),
        makeJob({ id: "job-dead", derivedState: "dead-letter" }),
        makeJob({ id: "job-retry", derivedState: "retrying", attempts: 2 }),
      ])
    );
    renderPanel();
    await flushMicrotasks();

    const pendingLabel = screen.getByTestId("printing-job-state-job-pending").textContent;
    const deadLabel = screen.getByTestId("printing-job-state-job-dead").textContent;
    const retryLabel = screen.getByTestId("printing-job-state-job-retry").textContent;

    expect(pendingLabel).toBe("Pending");
    expect(deadLabel).toBe("Dead-lettered");
    expect(retryLabel).toBe("Retrying");
    expect(deadLabel).not.toBe(pendingLabel);
    expect(retryLabel).not.toBe(pendingLabel);
    expect(deadLabel).not.toBe(retryLabel);
  });

  it("test-print trigger: enqueued response shows the enqueued message and refreshes the list", async () => {
    mockFetch.mockResolvedValueOnce(jobsResponse([])); // initial load
    mockFetch.mockResolvedValueOnce(jsonResponse({ enqueued: true, jobId: "job-9" })); // trigger
    mockFetch.mockResolvedValueOnce(jobsResponse([makeJob({ id: "job-9" })])); // refresh

    renderPanel();
    await flushMicrotasks();

    fireEvent.click(screen.getByTestId("printing-trigger-test-print"));
    await flushMicrotasks();

    expect(screen.getByTestId("printing-trigger-result")).toHaveTextContent("Test print enqueued.");
    expect(screen.getByTestId("printing-job-job-9")).toBeInTheDocument();
  });

  it("test-print trigger: alreadyPrinted response shows the dedup message (FR-012)", async () => {
    mockFetch.mockResolvedValueOnce(jobsResponse([]));
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ enqueued: false, jobId: null, alreadyPrinted: true })
    );
    mockFetch.mockResolvedValueOnce(jobsResponse([]));

    renderPanel();
    await flushMicrotasks();
    fireEvent.click(screen.getByTestId("printing-trigger-test-print"));
    await flushMicrotasks();

    expect(screen.getByTestId("printing-trigger-result")).toHaveTextContent(
      "Already printed for today — not re-enqueued."
    );
  });

  it("test-print trigger: plugin-inactive (409) shows that message distinctly (FR-013)", async () => {
    mockFetch.mockResolvedValueOnce(jobsResponse([]));
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "plugin_inactive" }), {
        status: 409,
      })
    );

    renderPanel();
    await flushMicrotasks();
    fireEvent.click(screen.getByTestId("printing-trigger-test-print"));
    await flushMicrotasks();

    expect(screen.getByTestId("printing-trigger-result")).toHaveTextContent(
      "The Printing plugin is inactive."
    );
  });

  it("test-print trigger: a generic failure shows the error message", async () => {
    mockFetch.mockResolvedValueOnce(jobsResponse([]));
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 500 }));

    renderPanel();
    await flushMicrotasks();
    fireEvent.click(screen.getByTestId("printing-trigger-test-print"));
    await flushMicrotasks();

    expect(screen.getByTestId("printing-trigger-result")).toHaveTextContent(
      "Failed to trigger the test print."
    );
  });
});
