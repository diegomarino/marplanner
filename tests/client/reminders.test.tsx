/** RemindersManagement spec (FR-005/FR-009, — scheduled and
 * calendar_gated reminders, the fifth of five call sites names for the
 * pre-migration `WEEKDAYS` literal, and the one with a WeekdayPicker holdout —
 * `AssignmentMatrixGrid` deliberately keeps its own table markup, per `WeekdayPicker`'s own
 * file-header doc comment).
 * This is the executable evidence for the verification policy (verification policy): it CALLS
 * the frozen density assertion over this surface's rendered control set with kiosk density
 * active (not merely imports it) — across the collapsed state, both reminders' assignment
 * panels open (one scheduled/apply_to_all matrix, one calendar_gated membership checklist), the
 * dry-run panel open, and an inline edit open — records a deliberate negative proving the
 * assertion can fail on THIS surface's own controls, asserts every one of the three distinct
 * error states this surface can render is announced through the shared `ErrorNotice` live region
 * (SC-011: top-level load/mutation errors, the per-card matrix validation error, and the dry-run
 * network error), asserts the panel's own region+heading (the L2-adoption clause), and proves the
 * surface's own new behaviour: deleting a reminder now opens a themed `ConfirmDialog` instead of
 * `window.confirm` (FR-005, mirroring `RoutinesManagement.tsx`'s precedent).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RemindersManagement } from "@/admin/RemindersManagement";
import { HouseholdSettingsProvider } from "@/lib/householdSettings";
import { LanguageProvider } from "@/i18n";
import { DensityViolationError, assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";
import {
  WEEKDAY_LABEL_KEYS,
  QUERY_FIELD_LABEL_KEYS,
  DRY_RUN_REASON_LABEL_KEYS,
} from "@/admin/RemindersManagement";

type FetchCall = Parameters<typeof globalThis.fetch>;

const MEMBER = {
  id: "m1",
  displayName: "Ari",
  role: "child",
  lifecycle: "active",
  createdAt: 0,
  updatedAt: 0,
};

const REMINDER_SCHEDULED = {
  id: "r1",
  kind: "scheduled",
  targetingMode: "apply_to_all",
  text: "Take out the trash",
  weekdays: ["mon"],
  query: null,
  queryFields: null,
  active: true,
  assignments: [],
};

const REMINDER_CALENDAR_GATED = {
  id: "r2",
  kind: "calendar_gated",
  targetingMode: "specific",
  text: "Vet appointment prep",
  weekdays: null,
  query: "vet",
  queryFields: ["title", "description"],
  active: true,
  assignments: [{ id: "a1", memberId: "m1", weekdays: [], active: true }],
};

function json(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status });
}

/** A fully-loaded, happy-path mock backend: one active member, one scheduled/apply_to_all
 * reminder and one calendar_gated/specific reminder. `overrides.reminders`/`overrides.language`
 * redirect one endpoint or the household locale without re-declaring the rest — mirrors
 * `routines.test.tsx`'s own `mockBackend` shape. */
function mockBackend(
  overrides: Partial<{
    reminders: () => Response;
    language: string;
  }> = {}
) {
  const mockFetch = vi.fn((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url.includes("/api/settings")) {
      return Promise.resolve(
        json({ locale: { timezone: "UTC", language: overrides.language ?? "en" } })
      );
    }

    if (overrides.reminders && url === "/api/reminders" && method === "GET") {
      return Promise.resolve(overrides.reminders());
    }
    if (url === "/api/reminders" && method === "GET") {
      return Promise.resolve(json([REMINDER_SCHEDULED, REMINDER_CALENDAR_GATED]));
    }
    if (url === "/api/reminders" && method === "POST") {
      return Promise.resolve(json(null, 201));
    }

    if (url === "/api/members") {
      return Promise.resolve(json([MEMBER]));
    }

    if (/\/api\/reminders\/[^/]+\/assignments$/.test(url) && method === "PUT") {
      return Promise.resolve(json(null, 200));
    }
    if (/\/api\/reminders\/[^/]+\/dry-run$/.test(url) && method === "POST") {
      return Promise.resolve(json({ wouldEmit: true }));
    }
    if (/\/api\/reminders\/[^/]+$/.test(url) && (method === "PATCH" || method === "DELETE")) {
      return Promise.resolve(json(null, method === "DELETE" ? 204 : 200));
    }

    throw new Error(`unexpected fetch: ${url} (${method})`);
  });

  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

function renderSurface() {
  return render(
    <HouseholdSettingsProvider>
      <LanguageProvider>
        <RemindersManagement />
      </LanguageProvider>
    </HouseholdSettingsProvider>
  );
}

/** Mirrors `density.ts`'s own selector/filter — see `routines.test.tsx`'s identical helper for
 * why this is duplicated rather than imported (the frozen file exposes no census API by design).
 * Lets THIS spec assert an exact control count per phase, not just "compliant or not" — a phase
 * that silently stopped rendering a control would otherwise still pass. */
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

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  document.documentElement.removeAttribute("data-density");
});

describe("RemindersManagement — the panel is a real landmark (FR-009 L2-adoption clause)", () => {
  it("exposes an AdminPanel region AND heading, both named for the panel title", async () => {
    mockBackend();
    renderSurface();
    // The LOADED panel, not the loading skeleton: RemindersManagement renders a second
    // AdminPanel with the SAME title while loading, and findByRole resolves synchronously
    // against that skeleton — so without this anchor, replacing the loaded panel with a bare
    // <section aria-label> (the DoD's own measured failure case) stayed green. Sixth batch with
    // a non-biting adoption assertion; first where the loading skeleton is the cause.
    await screen.findByText("Take out the trash");

    const region = await screen.findByRole("region", { name: "Reminders Management" });
    const heading = within(region).getByRole("heading", { name: "Reminders Management" });
    expect(heading).toBeInTheDocument();
  });
});

describe("RemindersManagement — kiosk density (SC-001, SC-002, SC-003, SC-009)", () => {
  it("meets kiosk density collapsed, with both reminders' assignment panels open, the dry-run panel open, and an inline edit open", async () => {
    mockBackend();
    const uninject = await injectDensityStyles({
      extraCandidates: ["size-[var(--control-height)]"],
    });
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderSurface();
      await screen.findByText("Take out the trash");
      await screen.findByText("Vet appointment prep");

      // Phase 1 — collapsed: the create-form (kind/targeting-mode radios, text input, the
      // apply_to_all WeekdayPicker's 7 checkboxes, and the Create button) + each reminder card's
      // own collapsed action row (scheduled: Edit/Assignments/Activate.Deactivate/Delete;
      // calendar_gated+specific additionally gets a Dry-run toggle).
      expect(countInteractiveControls(document.body)).toBe(22);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // Phase 2 — the scheduled reminder's (apply_to_all) assignment matrix open: adds
      // AssignmentMatrixGrid's one-member-by-seven-day checkboxes plus its Save button.
      const scheduledCard = await screen.findByTestId("reminder-r1");
      fireEvent.click(within(scheduledCard).getByRole("button", { name: "Assignments" }));
      await screen.findByText("Assignment matrix");
      expect(countInteractiveControls(document.body)).toBe(30);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // Phase 3 — the calendar_gated reminder's membership-checklist matrix open (one member
      // checkbox) AND its dry-run panel open (member select, date input, Run button).
      const cgCard = await screen.findByTestId("reminder-r2");
      fireEvent.click(within(cgCard).getByRole("button", { name: "Assignments" }));
      await screen.findByText("Assigned members");
      fireEvent.click(within(cgCard).getByRole("button", { name: "Dry-run" }));
      await screen.findByText("Dry-run / explain");
      expect(countInteractiveControls(document.body)).toBe(35);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // Phase 4 — the scheduled reminder's inline edit open: swaps its collapsed action row
      // (Edit/Assignments/Activate/Delete) for the edit form (text input, its own WeekdayPicker,
      // Save, Cancel) while its assignment matrix (opened in Phase 2) stays open underneath.
      fireEvent.click(within(scheduledCard).getByRole("button", { name: "Edit" }));
      expect(countInteractiveControls(document.body)).toBe(41);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("meets kiosk density with the delete ConfirmDialog open, portalled OUTSIDE this surface's own subtree (SC-003)", async () => {
    mockBackend();
    const uninject = await injectDensityStyles({
      extraCandidates: ["size-[var(--control-height)]"],
    });
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderSurface();
      const card = await screen.findByTestId("reminder-r1");

      fireEvent.click(within(card).getByRole("button", { name: "Delete" }));
      await screen.findByRole("dialog");

      // Asserted over document.body — the one shape that reaches a control Radix mounted
      // outside `card`'s own DOM subtree.
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("DELIBERATE NEGATIVE — forcing this surface's own Create Reminder button below the kiosk minimum makes the assertion fail", async () => {
    mockBackend();
    const uninject = await injectDensityStyles({
      extraCandidates: ["size-[var(--control-height)]"],
    });
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = renderSurface();
      const createButton = await screen.findByRole("button", { name: "Create Reminder" });

      // A real control from this surface, not a synthetic fixture.
      createButton.style.height = "10px";
      createButton.style.fontSize = "8px";

      let thrown: unknown;
      try {
        assertKioskDensityCompliant(container);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(DensityViolationError);
      const message = (thrown as DensityViolationError).message;
      // Recorded verbatim in this module's report — proof the helper actually rejects a real
      // undersized control on THIS surface, not merely on the helper's own synthetic fixtures.
      expect(message).toMatch(/height 10px is below the kiosk minimum 48px/);
      expect(message).toMatch(/font-size 8px is below the kiosk minimum 18px/);

      // Revert — the control returns to token-driven sizing, proven compliant again.
      createButton.style.height = "";
      createButton.style.fontSize = "";
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });
});

describe("RemindersManagement — error states are announced (SC-011)", () => {
  it("announces a data-load failure through ErrorNotice's live region", async () => {
    mockBackend({ reminders: () => json(null, 500) });
    renderSurface();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load reminders.");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  it("announces a create-reminder failure through ErrorNotice's live region", async () => {
    const mockFetch = mockBackend();
    renderSurface();

    await screen.findByText("Take out the trash");

    mockFetch.mockImplementation((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      if (url === "/api/reminders" && init?.method === "POST") {
        return Promise.resolve(json(null, 500));
      }
      throw new Error(`unexpected fetch after override: ${url}`);
    });

    fireEvent.change(screen.getByPlaceholderText("Reminder text"), {
      target: { value: "New reminder" },
    });
    fireEvent.click(screen.getByLabelText("Mon"));
    fireEvent.click(screen.getByRole("button", { name: "Create Reminder" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load reminders.");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  it("announces a matrix validation error (empty weekday set) through ErrorNotice's live region", async () => {
    mockBackend();
    renderSurface();

    const card = await screen.findByTestId("reminder-r1");
    fireEvent.click(within(card).getByRole("button", { name: "Assignments" }));
    await screen.findByText("Assignment matrix");

    // The shared apply_to_all set starts pre-populated with the reminder's own "mon" — clear it
    // so the save click below hits the "select at least one weekday" validation path.
    fireEvent.click(within(card).getByRole("checkbox", { name: "Ari — Mon" }));
    fireEvent.click(within(card).getByRole("button", { name: "Save Assignments" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Select at least one weekday.");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  it("announces a dry-run failure through ErrorNotice's live region", async () => {
    const mockFetch = mockBackend();
    renderSurface();

    const card = await screen.findByTestId("reminder-r2");
    fireEvent.click(within(card).getByRole("button", { name: "Dry-run" }));
    await screen.findByText("Dry-run / explain");

    mockFetch.mockImplementation((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      if (/\/api\/reminders\/[^/]+\/dry-run$/.test(url) && init?.method === "POST") {
        return Promise.resolve(json(null, 500));
      }
      throw new Error(`unexpected fetch after override: ${url}`);
    });

    fireEvent.change(within(card).getByRole("combobox"), { target: { value: "m1" } });
    fireEvent.click(within(card).getByRole("button", { name: "Run" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to run dry-run.");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });
});

describe("RemindersManagement — deleting a reminder opens a themed ConfirmDialog instead of window.confirm (research D3/FR-005)", () => {
  it("does not delete until the ConfirmDialog is confirmed, and deletes on confirm", async () => {
    const mockFetch = mockBackend();
    renderSurface();

    const card = await screen.findByTestId("reminder-r1");
    fireEvent.click(within(card).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Delete this reminder?");

    // Cancel first — no DELETE must have fired.
    fireEvent.click(screen.getByTestId("reminder-delete-cancel-r1"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(
      (mockFetch.mock.calls as FetchCall[]).filter(
        ([reqInput, init]) => String(reqInput) === "/api/reminders/r1" && init?.method === "DELETE"
      )
    ).toHaveLength(0);

    // Now confirm.
    fireEvent.click(within(card).getByRole("button", { name: "Delete" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByTestId("reminder-delete-confirm-r1"));

    await waitFor(() => {
      expect(
        (mockFetch.mock.calls as FetchCall[]).filter(
          ([reqInput, init]) =>
            String(reqInput) === "/api/reminders/r1" && init?.method === "DELETE"
        )
      ).toHaveLength(1);
    });
  });
});

// Independent review lesson carried from /: assert EVERY key a typed-map replaces a
// literal `as MessageKey` cast with, not just the one obviously exercised — rendered in Spanish,
// not English, so an accidental English-literal fallback would not coincidentally still read
// wrong.
describe("RemindersManagement — WEEKDAY_LABEL_KEYS maps each weekday to its OWN translation key, through the shared WeekdayPicker", () => {
  it("labels the create form's WeekdayPicker with the household's own Spanish weekday abbreviations, in canonical mon..sun order", async () => {
    mockBackend({ language: "es" });
    renderSurface();

    await screen.findByText("Take out the trash");

    const group = screen.getByRole("group", { name: "Días de la semana" });
    const dayLabels = within(group)
      .getAllByRole("checkbox")
      .map((checkbox) => checkbox.closest("label")?.textContent?.trim());
    expect(dayLabels).toEqual(["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]);
  });
});

// --- Label maps: every entry pinned, mechanically, by ITERATING (verification policy) -----------------
//
// Dropping `as MessageKey` casts traded compiler-verified correctness for hand-transcription:
// `Record<K, MessageKey>` proves every key is present and every value EXISTS in the catalogue — it
// cannot prove the PAIRING. Measured in: swapping two entries shipped wrong kiosk labels and
// passed the whole suite, tsc, eslint, the counter and the e2e. Iterating (never hand-writing the
// expectations) is what makes this total and keeps a future entry covered automatically.

describe("WeekdayPicker adoption — the CANONICAL emission order is what separates the shared component from a replica (per-batch DoD, SC-009)", () => {
  it("toggling Wed then Mon emits mon..wed in canonical order, not click order", async () => {
    // A hand-rolled replica that renders labels in canonical order but APPENDS on click passes
    // every render-only assertion — this was proven against this very spec before the test
    // existed (13/13 green on the replica). What only the shared picker guarantees is that the
    // EMITTED array is canonicalized: WeekdayPicker re-derives it from CANONICAL_WEEKDAY_ORDER
    // on every toggle. So the falsifier is the POST body, not the DOM.
    const mockFetch = mockBackend();
    renderSurface();
    await screen.findByText("Take out the trash");

    fireEvent.change(screen.getByPlaceholderText("Reminder text"), {
      target: { value: "Order test" },
    });
    // Click order deliberately REVERSED from canonical order.
    fireEvent.click(screen.getByLabelText("Wed"));
    fireEvent.click(screen.getByLabelText("Mon"));
    fireEvent.click(screen.getByRole("button", { name: "Create Reminder" }));

    await waitFor(() => {
      const post = mockFetch.mock.calls.find(
        ([input, init]) => String(input) === "/api/reminders" && init?.method === "POST"
      );
      expect(post, "the create POST must have fired").toBeTruthy();
      const body = JSON.parse(String(post![1]!.body));
      expect(body.weekdays, "emission must be canonical mon..sun, not click order").toEqual([
        "mon",
        "wed",
      ]);
    });
  });
});

describe("label maps are transcribed correctly (SC-007's cast removal, pinned)", () => {
  it("every weekday maps to its own key", () => {
    const keys = Object.keys(WEEKDAY_LABEL_KEYS) as (keyof typeof WEEKDAY_LABEL_KEYS)[];
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(WEEKDAY_LABEL_KEYS[k], `weekday "${k}" maps to the wrong key`).toBe(
        `reminders.weekday.${k}`
      );
    }
  });

  it("every query field maps to its own key", () => {
    const keys = Object.keys(QUERY_FIELD_LABEL_KEYS) as (keyof typeof QUERY_FIELD_LABEL_KEYS)[];
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(QUERY_FIELD_LABEL_KEYS[k], `query field "${k}" maps to the wrong key`).toBe(
        `reminders.calendarGated.queryField.${k}`
      );
    }
  });

  it("every dry-run reason maps to its own key", () => {
    const keys = Object.keys(
      DRY_RUN_REASON_LABEL_KEYS
    ) as (keyof typeof DRY_RUN_REASON_LABEL_KEYS)[];
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(DRY_RUN_REASON_LABEL_KEYS[k], `dry-run reason "${k}" maps to the wrong key`).toBe(
        `reminders.dryRun.reason.${k}`
      );
    }
  });
});
