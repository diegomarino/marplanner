/** Printing surfaces spec (FR-001/FR-009) — `PrintingManagement.tsx`
 * (the admin test-print trigger + jobs list, nested inside `AdminGate`'s menu).
 * This is the executable evidence for the verification policy (verification policy): it CALLS
 * the frozen density assertion over each surface's rendered control set with kiosk density
 * active (not merely imports it), across every reachable interaction state with an exact
 * control-count census per phase, records a deliberate negative per surface proving the
 * assertion can fail on THAT surface's own controls, and asserts every error state each surface
 * renders is announced through the shared `ErrorNotice` live region (SC-011).
 * * Exception-list note:* neither file has any counted UI debt (their old
 * `text-red`/hex hits were all GitHub issue references, per the correction) — this
 * batch's `node tools/dev/count-ui-debt.mjs` count is therefore UNCHANGED before/after (167 71 30
 * 66 in both cases, verified). That is the expected outcome, not a miss; this module's real work
 * is density verification, L2 (`AdminPanel`/`ErrorNotice`) adoption, and retiring the three
 * `eslint-disable-next-line` sites (`PrintingManagement.tsx:122,158`).
 * `useHouseholdSettingsContext`
 * is mocked so `LanguageProvider` never performs its own `/api/settings` self-fetch, which would
 * otherwise race each surface's own mocked `fetch` queue; `usePrintingPluginActive` is mocked
 * `true` so the session owner is available for the management pairing-path test.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/i18n";
import { PrintingManagement } from "@/admin/PrintingManagement";
import { PrinterSessionProvider } from "@/printing/PrinterSession";
import { createFakePrintTransport } from "@/printing/transport";
import type { JobsListResponse, PrintJob } from "../../src/shared";
import { DensityViolationError, assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

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

vi.mock("@/printing/pluginStatus", () => ({
  usePrintingPluginActive: () => true,
}));

/** Mirrors `density.ts`'s own selector/filter — see `chores-board.test.tsx`'s identical helper
 * for why this is duplicated rather than imported (the frozen file exposes no census API by
 * design). Lets THIS spec assert an exact control count per phase, not just "compliant or not". */
const CENSUS_CONTROL_SELECTOR = [
  "button",
  "input",
  "select",
  "textarea",
  "a[href]",
  '[role="button"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="option"]',
  '[role="tab"]',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function countInteractiveControls(container: Document | Element): number {
  return Array.from(container.querySelectorAll(CENSUS_CONTROL_SELECTOR)).filter((element) => {
    if (element instanceof HTMLElement && element.hidden) return false;
    return element.getAttribute("aria-hidden") !== "true";
  }).length;
}

/** Flushes the microtask queue several times over — enough for a multi-hop `fetch ->.then ->
 * fetch ->.then` chain to settle before an assertion (mirrors `printing-executor.test.tsx`'s * own helper). */
async function flushMicrotasks(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status });
}

function jobsResponse(jobs: PrintJob[]): Response {
  const body: JobsListResponse = { jobs };
  return new Response(JSON.stringify(body), { status: 200 });
}

function makeJob(overrides: Partial<PrintJob> = {}): PrintJob {
  return {
    id: "job-1",
    recordKey: "test-printable",
    outputRef: "ref-1",
    targetDate: "2026-09-07",
    memberId: null,
    state: "claimed",
    derivedState: "claimed",
    attempts: 0,
    failureReason: null,
    claimedAt: 1000,
    printedAt: null,
    createdAt: 900,
    updatedAt: 1000,
    ...overrides,
  };
}

function renderManagement() {
  return render(
    <LanguageProvider>
      <PrintingManagement />
    </LanguageProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.documentElement.removeAttribute("data-density");
});

describe("PrintingManagement — the shared L2 panel was actually ADOPTED (FR-009)", () => {
  it("renders through AdminPanel, not a hand-rolled wrapper", async () => {
    // A bare <div> in place of AdminPanel passes every functional test in this file — this is the
    // only assertion that would catch it. Verified: reverting to a <div>, even with the title and
    // description deleted outright, leaves 78 files and 618 tests green.
    //
    // The same one-line gap has now been caught by review in FOUR batches of this module
    // (meals-management.test.tsx:493 and calendar-view.test.tsx:345 on main; members-admin in the unmerged; and here), because
    // the verification policy mandates the density assertion and the announcement assertion but never
    // this one. The DoD clause is being added separately; this is the local fix.
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(jobsResponse([makeJob({ id: "job-1" })]));

    renderManagement();
    await screen.findByTestId("printing-jobs-list");
    expect(screen.getByRole("region", { name: "Printing" })).toBeInTheDocument();
    // Region ALONE is not enough, and the re-review proved it: `AdminPanel` names its region via
    // `aria-labelledby` pointing at its own heading, so a hand-rolled `<section aria-label="Printing">`
    // with NO heading and NO description reproduces the landmark and its name and passes a
    // region-only assertion 13/13. The heading is the part a substitute would have to reproduce the
    // component to satisfy.
    expect(screen.getByRole("heading", { name: "Printing" })).toBeInTheDocument();
  });
});

describe("PrintingManagement — shared printer session", () => {
  it("uses the globally owned session for its pair action", async () => {
    const transport = createFakePrintTransport();
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    mockFetch
      .mockResolvedValueOnce(jobsResponse([]))
      .mockResolvedValueOnce(jsonResponse({ registered: true }))
      .mockResolvedValue(new Response(null, { status: 204 }));

    render(
      <LanguageProvider>
        <PrinterSessionProvider transport={transport}>
          <PrintingManagement />
        </PrinterSessionProvider>
      </LanguageProvider>
    );

    await screen.findByTestId("printing-management-pair");
    fireEvent.click(screen.getByTestId("printing-management-pair"));
    await flushMicrotasks();

    expect(mockFetch.mock.calls.map((call) => String(call[0]))).toContain(
      "/api/printing/capability"
    );
  });
});

describe("PrintingManagement — kiosk density across every reachable state (SC-001, SC-002)", () => {
  it("meets kiosk density across the jobs list (mixed healthy/unhealthy states), an in-flight trigger, and an unhealthy trigger result — three phases, one control throughout", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      // initial load: one healthy (pending) job, one unhealthy (dead-letter) job.
      mockFetch.mockResolvedValueOnce(
        jobsResponse([
          makeJob({ id: "job-pending", derivedState: "pending" }),
          makeJob({ id: "job-dead", derivedState: "dead-letter" }),
        ])
      );

      renderManagement();
      await screen.findByTestId("printing-jobs-list");

      // Phase 1 — the default list: the test-print trigger button is this surface's ONLY
      // control (the jobs list renders text only, never a button/input) — one control whether
      // the list holds zero, one, or many jobs.
      expect(countInteractiveControls(document.body)).toBe(1);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // Phase 2 — the trigger fires, deliberately left UNRESOLVED so the surface renders its
      // in-flight (disabled) state: the button stays mounted (still one control) but disabled.
      let resolveTrigger: (() => void) | undefined;
      mockFetch.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveTrigger = () => resolve(jsonResponse({ error: "plugin_inactive" }, 409));
          })
      );
      fireEvent.click(screen.getByTestId("printing-trigger-test-print"));
      await flushMicrotasks();

      expect(screen.getByTestId("printing-trigger-test-print")).toBeDisabled();
      expect(countInteractiveControls(document.body)).toBe(1);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // Phase 3 — the trigger resolves to an UNHEALTHY (plugin-inactive) result: the control
      // count stays one (the button never disappears), and the result is now announced through
      // ErrorNotice (SC-011, asserted in its own describe block below).
      resolveTrigger?.();
      await flushMicrotasks();

      expect(screen.getByTestId("printing-trigger-test-print")).not.toBeDisabled();
      expect(screen.getByTestId("printing-trigger-result")).toHaveTextContent(
        "The Printing plugin is inactive."
      );
      expect(countInteractiveControls(document.body)).toBe(1);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("meets kiosk density when the jobs list itself fails to load — the trigger button is still the surface's only control", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 500 }));
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderManagement();
      await screen.findByTestId("printing-list-error");

      expect(countInteractiveControls(document.body)).toBe(1);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("DELIBERATE NEGATIVE — forcing this surface's own trigger button below the kiosk minimum makes the assertion fail, and reverting restores compliance", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(jobsResponse([]));
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = renderManagement();
      const button = await screen.findByTestId("printing-trigger-test-print");

      // A real control from this surface, not a synthetic fixture.
      button.style.height = "12px";
      button.style.fontSize = "9px";

      let thrown: unknown;
      try {
        assertKioskDensityCompliant(container);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(DensityViolationError);
      const message = (thrown as DensityViolationError).message;
      expect(message).toMatch(/height 12px is below the kiosk minimum 48px/);
      expect(message).toMatch(/font-size 9px is below the kiosk minimum 18px/);

      // Revert — compliance returns.
      button.style.height = "";
      button.style.fontSize = "";
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });
});

describe("PrintingManagement — error states are announced through ErrorNotice's live region (SC-011)", () => {
  it("announces a jobs-list load failure", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 500 }));

    renderManagement();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load print jobs.");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  it("announces a dead-lettered job's state distinctly from a healthy job's — only the unhealthy one is an alert", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(
      jobsResponse([
        makeJob({ id: "job-pending", derivedState: "pending" }),
        makeJob({ id: "job-dead", derivedState: "dead-letter" }),
      ])
    );

    renderManagement();
    await screen.findByTestId("printing-jobs-list");

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Dead-lettered");
    expect(alert).toHaveAttribute("data-testid", "printing-job-state-job-dead");

    // The healthy job's own state label carries no alert role.
    expect(screen.getByTestId("printing-job-state-job-pending")).not.toHaveAttribute(
      "role",
      "alert"
    );
  });

  it("announces a plugin-inactive test-print trigger result", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(jobsResponse([]));
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: "plugin_inactive" }, 409));

    renderManagement();
    await screen.findByTestId("printing-jobs-empty");
    fireEvent.click(screen.getByTestId("printing-trigger-test-print"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The Printing plugin is inactive.");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  it("does NOT render a healthy (enqueued) trigger result as an alert", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(jobsResponse([]));
    mockFetch.mockResolvedValueOnce(jsonResponse({ enqueued: true, jobId: "job-9" }));
    mockFetch.mockResolvedValueOnce(jobsResponse([makeJob({ id: "job-9" })]));

    renderManagement();
    await screen.findByTestId("printing-jobs-empty");
    fireEvent.click(screen.getByTestId("printing-trigger-test-print"));

    await waitFor(() =>
      expect(screen.getByTestId("printing-trigger-result")).toHaveTextContent(
        "Test print enqueued."
      )
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
