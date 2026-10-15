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
import { stubFetchRoutes, type RouteHandler } from "./helpers/fetchRoutes";

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

function printerRoutes(jobs: PrintJob[], extra: Record<string, RouteHandler> = {}) {
  return stubFetchRoutes({
    "GET /api/settings": () =>
      new Response(
        JSON.stringify({
          locale: { timezone: "Europe/Madrid", language: "en", weekStartDay: 1 },
          printer: { paperWidthDots: 576 },
          printerTransport: { deviceId: "", name: "", serviceUuid: "", characteristicUuid: "" },
        }),
        { status: 200 }
      ),
    "GET /api/daily-briefing/settings": () =>
      new Response(JSON.stringify({ autoPrintTrigger: null }), { status: 200 }),
    "GET /api/printing/jobs": () => jobsResponse(jobs),
    "GET /api/members?lifecycle=all": () => new Response("[]", { status: 200 }),
    "POST /api/printing/capability": () => jsonResponse({ registered: true }),
    "POST /api/printing/claim": () => new Response(null, { status: 204 }),
    ...extra,
  });
}

async function openDiagnostics(): Promise<void> {
  fireEvent.click(await screen.findByTestId("printing-tab-diagnostics"));
  await flushMicrotasks();
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
    printerRoutes([makeJob({ id: "job-1" })]);

    renderManagement();
    await screen.findByTestId("printer-settings");
    // The heading equals the sidebar label ("Printer").
    expect(screen.getByRole("region", { name: "Printer" })).toBeInTheDocument();
    // Region ALONE is not enough, and the re-review proved it: `AdminPanel` names its region via
    // `aria-labelledby` pointing at its own heading, so a hand-rolled `<section aria-label="Printer">`
    // with NO heading and NO description reproduces the landmark and its name and passes a
    // region-only assertion 13/13. The heading is the part a substitute would have to reproduce the
    // component to satisfy.
    expect(screen.getByRole("heading", { name: "Printer" })).toBeInTheDocument();
  });
});

describe("PrintingManagement — shared printer session", () => {
  it("uses the globally owned session for its pair action", async () => {
    const transport = createFakePrintTransport();
    const mockFetch = printerRoutes([]);

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
  it("meets kiosk density on the Settings tab", async () => {
    printerRoutes([]);
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderManagement();
      await screen.findByTestId("printer-paper-width");
      await flushMicrotasks();

      // 2 tabs, plugin link, auto-print link, paper width, name, device id, service UUID,
      // characteristic UUID, Save (no session provider, so no Pair button).
      expect(countInteractiveControls(document.body)).toBe(10);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("meets kiosk density across the jobs table (mixed healthy/unhealthy states), an in-flight trigger, and an unhealthy trigger result — three phases, five controls throughout", async () => {
    let resolveTrigger: (() => void) | undefined;
    printerRoutes(
      [
        makeJob({ id: "job-pending", derivedState: "pending" }),
        makeJob({ id: "job-dead", derivedState: "dead-letter" }),
      ],
      {
        "POST /api/printing/test-print": () =>
          new Promise<Response>((resolve) => {
            resolveTrigger = () => resolve(jsonResponse({ error: "plugin_inactive" }, 409));
          }),
      }
    );
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderManagement();
      await openDiagnostics();
      await screen.findByTestId("printing-jobs-table");

      // Phase 1 — the table renders text only: 2 tabs + test print + reset + refresh.
      expect(countInteractiveControls(document.body)).toBe(5);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // Phase 2 — the trigger fires, deliberately left UNRESOLVED so the surface renders its
      // in-flight (disabled) state: both actions stay mounted but disabled.
      fireEvent.click(screen.getByTestId("printing-trigger-test-print"));
      await flushMicrotasks();

      expect(screen.getByTestId("printing-trigger-test-print")).toBeDisabled();
      expect(screen.getByTestId("printing-reset-today")).toBeDisabled();
      expect(countInteractiveControls(document.body)).toBe(5);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // Phase 3 — the trigger resolves to an UNHEALTHY (plugin-inactive) result: the control
      // count stays five, and the result is announced through ErrorNotice (SC-011, below).
      resolveTrigger?.();
      await flushMicrotasks();

      expect(screen.getByTestId("printing-trigger-test-print")).not.toBeDisabled();
      expect(screen.getByTestId("printing-trigger-result")).toHaveTextContent(
        "The Printing plugin is inactive."
      );
      expect(countInteractiveControls(document.body)).toBe(5);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("meets kiosk density when the jobs list itself fails to load — Retry is the one added control", async () => {
    printerRoutes([], { "GET /api/printing/jobs": () => new Response(null, { status: 500 }) });
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderManagement();
      await openDiagnostics();
      await screen.findByTestId("printing-list-error");

      // 2 tabs + test print + reset + refresh + retry.
      expect(countInteractiveControls(document.body)).toBe(6);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("DELIBERATE NEGATIVE — forcing this surface's own trigger button below the kiosk minimum makes the assertion fail, and reverting restores compliance", async () => {
    printerRoutes([]);
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = renderManagement();
      await openDiagnostics();
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
    printerRoutes([], { "GET /api/printing/jobs": () => new Response(null, { status: 500 }) });

    renderManagement();
    await openDiagnostics();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load print jobs.");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  it("announces a dead-lettered job's state distinctly from a healthy job's — only the unhealthy one is an alert", async () => {
    printerRoutes([
      makeJob({ id: "job-pending", derivedState: "pending" }),
      makeJob({ id: "job-dead", derivedState: "dead-letter" }),
    ]);

    renderManagement();
    await openDiagnostics();
    await screen.findByTestId("printing-jobs-table");

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
    printerRoutes([], {
      "POST /api/printing/test-print": () => jsonResponse({ error: "plugin_inactive" }, 409),
    });

    renderManagement();
    await openDiagnostics();
    await screen.findByTestId("printing-jobs-empty");
    fireEvent.click(screen.getByTestId("printing-trigger-test-print"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The Printing plugin is inactive.");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  it("does NOT render a healthy (enqueued) trigger result as an alert", async () => {
    printerRoutes([], {
      "POST /api/printing/test-print": () => jsonResponse({ enqueued: true, jobId: "job-9" }),
    });

    renderManagement();
    await openDiagnostics();
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
