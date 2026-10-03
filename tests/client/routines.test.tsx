/** RoutinesManagement spec (FR-005/FR-009, — routines, chores and
 * per-child weekday assignments, the fourth of five call sites names for the
 * pre-migration `WEEKDAYS` literal).
 * This is the executable evidence for the verification policy (verification policy): it CALLS
 * the frozen density assertion over this surface's rendered control set with kiosk density
 * active (not merely imports it) — across the collapsed state, the expanded chores/assignments
 * state (which is where the shared `WeekdayPicker`, SC-009, actually renders), and an open
 * `ConfirmDialog` portalled outside this surface's own subtree (SC-003) — records a deliberate
 * negative proving the assertion can fail on THIS surface's own controls, asserts every one of
 * the three distinct error messages this surface can render is announced through the shared
 * `ErrorNotice` live region (SC-011), and proves the surface's own new behaviour: every
 * streak-affecting action now opens a themed `ConfirmDialog` instead of `window.confirm`
 * (FR-005, mirroring `MealsManagement.tsx`'s precedent).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RoutinesManagement } from "@/admin/RoutinesManagement";
import { LanguageProvider } from "@/i18n";
import { DensityViolationError, assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

type FetchCall = Parameters<typeof globalThis.fetch>;

const DAY_PERIOD = { id: "morning", labelKey: "dayPeriod.morning", start: "06:00", sortOrder: 0 };
const DAY_PERIOD_EVENING = {
  id: "evening",
  labelKey: "dayPeriod.evening",
  start: "17:00",
  sortOrder: 2,
};
const ROUTINE = { id: "r1", name: "Morning Routine", dayPeriodId: "morning", active: true };
const ROUTINE_EVENING = {
  id: "r2",
  name: "Evening Routine",
  dayPeriodId: "evening",
  active: true,
};
const CHORE = {
  id: "c1",
  routineId: "r1",
  name: "Brush teeth",
  icon: "🪥",
  sortOrder: 0,
  active: true,
};
const CHILD = {
  id: "m1",
  displayName: "Ari",
  role: "child",
  lifecycle: "active",
  createdAt: 0,
  updatedAt: 0,
};

function json(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status });
}

/** A fully-loaded, happy-path mock backend: one day period, one routine, one chore, one active
 * child with no assignment yet. `overrides.assignments` seeds an existing assignment for the
 * reassign-confirmation test; `overrides.routines`/`overrides.language` redirect one endpoint or
 * the household locale without re-declaring the rest — mirrors `chores-board.test.tsx`'s own
 * `mockBackend` shape. */
function mockBackend(
  overrides: Partial<{
    routines: () => Response;
    dayPeriods: unknown[];
    assignments: Array<{ id: string; memberId: string; weekdays: string[]; active: boolean }>;
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

    if (url === "/api/day-periods") {
      return Promise.resolve(json(overrides.dayPeriods ?? [DAY_PERIOD]));
    }

    if (overrides.routines && url === "/api/routines" && method === "GET") {
      return Promise.resolve(overrides.routines());
    }
    if (url === "/api/routines" && method === "GET") {
      return Promise.resolve(json([ROUTINE]));
    }
    if (url === "/api/routines" && method === "POST") {
      return Promise.resolve(json(null, 201));
    }

    if (url === "/api/members") {
      return Promise.resolve(json([CHILD]));
    }

    if (/\/api\/routines\/[^/]+\/chores$/.test(url) && method === "GET") {
      return Promise.resolve(json([CHORE]));
    }
    if (/\/api\/routines\/[^/]+\/chores$/.test(url) && method === "POST") {
      return Promise.resolve(json(null, 201));
    }

    if (/\/api\/routines\/[^/]+\/assignments$/.test(url) && method === "GET") {
      return Promise.resolve(json(overrides.assignments ?? []));
    }
    if (
      /\/api\/routines\/[^/]+\/assignments\/[^/]+$/.test(url) &&
      (method === "PUT" || method === "DELETE")
    ) {
      return Promise.resolve(json(null, method === "PUT" ? 200 : 204));
    }

    if (/\/api\/routines\/[^/]+$/.test(url) && (method === "PATCH" || method === "DELETE")) {
      return Promise.resolve(json(null, method === "DELETE" ? 204 : 200));
    }

    if (/\/api\/chores\/[^/]+$/.test(url) && (method === "PATCH" || method === "DELETE")) {
      return Promise.resolve(json(null, method === "DELETE" ? 204 : 200));
    }

    throw new Error(`unexpected fetch: ${url} (${method})`);
  });

  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

function renderSurface() {
  return render(
    <LanguageProvider>
      <RoutinesManagement />
    </LanguageProvider>
  );
}

/** Mirrors `density.ts`'s own selector/filter — see `chores-board.test.tsx`'s identical helper
 * for why this is duplicated rather than imported (the frozen file exposes no census API by
 * design). Lets THIS spec assert an exact control count per phase, not just "compliant or not" —
 * a phase that silently stopped rendering a control would otherwise still pass. */
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

describe("RoutinesManagement — chore icon editing", () => {
  it("submits a selected icon on create and null when clearing an existing icon", async () => {
    const mockFetch = mockBackend();
    renderSurface();
    const card = await screen.findByTestId("routine-r1");
    fireEvent.click(within(card).getByRole("button", { name: "View Chores" }));

    fireEvent.click(within(card).getByRole("button", { name: "Select chore icon" }));
    fireEvent.click(screen.getByRole("button", { name: "Select Backpack" }));
    fireEvent.change(within(card).getByPlaceholderText("Chore name"), {
      target: { value: "Pack backpack" },
    });
    fireEvent.click(within(card).getByRole("button", { name: "Add Chore" }));

    await waitFor(() => {
      const create = (mockFetch.mock.calls as FetchCall[]).find(
        ([input, init]) => String(input) === "/api/routines/r1/chores" && init?.method === "POST"
      );
      expect(JSON.parse(String(create?.[1]?.body))).toEqual({ name: "Pack backpack", icon: "🎒" });
    });

    const row = await screen.findByTestId("chore-c1");
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    fireEvent.click(within(row).getByRole("button", { name: "Selected icon: 🪥. Change icon" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear icon" }));
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const edit = (mockFetch.mock.calls as FetchCall[]).find(
        ([input, init]) => String(input) === "/api/chores/c1" && init?.method === "PATCH"
      );
      expect(JSON.parse(String(edit?.[1]?.body))).toEqual({ name: "Brush teeth", icon: null });
    });
  });

  it("renders the chore's vendored Noto SVG instead of the literal emoji glyph", async () => {
    mockBackend();
    renderSurface();
    const card = await screen.findByTestId("routine-r1");
    fireEvent.click(within(card).getByRole("button", { name: "View Chores" }));

    const row = await screen.findByTestId("chore-c1");
    const icon = row.querySelector("img");
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute("src", expect.stringContaining("emoji_u1faa5"));
  });
});

describe("RoutinesManagement — kiosk density (SC-001, SC-002, SC-003, SC-009)", () => {
  it("meets kiosk density collapsed, with chores expanded, with an ACTIVE assignment expanded, and with both inline-edit modes open", async () => {
    // An ACTIVE assignment — not the default empty list — so the Deactivate button
    // (RoutinesManagement.tsx, AssignmentRow's `isActive` branch) is actually in the measured
    // control set. With zero assignments (the previous version of this test) that button is
    // never rendered, so a `className="h-6 text-xs"` on it would pass this spec, eslint AND
    // count-ui-debt (the raw-scale-class pattern is palette-only — sizing classes are outside
    // its definition) without ever being measured against the kiosk minimum.
    mockBackend({ assignments: [{ id: "a1", memberId: "m1", weekdays: ["mon"], active: true }] });
    // The shared WeekdayPicker's multi-select mode is built on CheckboxField, which renders a
    // `size-[var(--control-height)]` utility — outside the density helper's base candidate list
    // (`densityStyles.ts` header), same as `meals-management.test.tsx`'s own extraCandidates.
    const uninject = await injectDensityStyles({
      extraCandidates: ["size-[var(--control-height)]"],
    });
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderSurface();
      const card = await screen.findByTestId("routine-r1");

      // Phase 1 — collapsed: the create-routine form + the routine card's own edit/delete/
      // view toggles.
      expect(countInteractiveControls(document.body)).toBe(7);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // Phase 2 — chores expanded: adds the create-chore input/button, the chore row's edit/
      // delete buttons, and ChoreOrderControls' own reorder trigger (already token-migrated,
      //).
      fireEvent.click(within(card).getByRole("button", { name: "View Chores" }));
      const choreRow = await screen.findByTestId("chore-c1");
      expect(countInteractiveControls(document.body)).toBe(13);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // Phase 3 — assignments expanded, with the ACTIVE assignment seeded above: adds the
      // shared WeekdayPicker's seven checkboxes (SC-009 — the reason this module exists), the
      // Save Assignment button, AND (because the assignment is active) the Deactivate button.
      fireEvent.click(within(card).getByRole("button", { name: "Members with assignments" }));
      await screen.findByTestId("routine-assignment-m1");
      expect(countInteractiveControls(document.body)).toBe(22);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // Phase 4 — both inline-edit modes open: the routine-name trio (Input/Save/Cancel,
      // RoutinesManagement.tsx:444-473) and the chore-name trio (537-563) — neither is
      // reachable from the collapsed/expanded-but-not-editing states above, so nothing before
      // this phase ever measured them.
      const heading = within(card).getByRole("heading", { name: /Morning Routine/ });
      fireEvent.click(within(heading).getByRole("button", { name: "Edit" }));
      fireEvent.click(within(choreRow).getByRole("button", { name: "Edit" }));

      expect(countInteractiveControls(document.body)).toBe(26);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("meets kiosk density with the chore emoji picker open", async () => {
    mockBackend();
    const uninject = await injectDensityStyles({
      extraCandidates: ["size-[var(--control-height)]"],
    });
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderSurface();
      const card = await screen.findByTestId("routine-r1");
      fireEvent.click(within(card).getByRole("button", { name: "View Chores" }));
      await screen.findByTestId("chore-c1");

      fireEvent.click(within(card).getByRole("button", { name: "Select chore icon" }));
      const picker = await screen.findByRole("dialog", { name: "Choose a chore icon" });
      expect(within(picker).getAllByRole("button", { pressed: false }).length).toBeGreaterThan(0);
      expect(() => assertKioskDensityCompliant(picker)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("meets kiosk density with the delete ConfirmDialog open, portalled OUTSIDE this surface's own subtree (SC-003)", async () => {
    mockBackend();
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderSurface();
      const card = await screen.findByTestId("routine-r1");

      fireEvent.click(within(card).getByRole("button", { name: "Delete" }));
      await screen.findByRole("dialog");

      // Asserted over document.body — the one shape that reaches a control Radix mounted
      // outside `card`'s own DOM subtree.
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("DELIBERATE NEGATIVE — forcing this surface's own Create Routine button below the kiosk minimum makes the assertion fail", async () => {
    mockBackend();
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = renderSurface();
      const createButton = await screen.findByRole("button", { name: "Create Routine" });

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

describe("RoutinesManagement — error states are announced (SC-011)", () => {
  it("announces a data-load failure through ErrorNotice's live region", async () => {
    mockBackend({ routines: () => json(null, 500) });
    renderSurface();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load data.");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  it("announces a chore-creation failure through ErrorNotice's live region", async () => {
    const mockFetch = mockBackend();
    renderSurface();

    const card = await screen.findByTestId("routine-r1");
    fireEvent.click(within(card).getByRole("button", { name: "View Chores" }));
    await screen.findByTestId("chore-c1");

    // Redirect the chore-creation POST to a failure for this one interaction, after the
    // initial load already succeeded.
    mockFetch.mockImplementation((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      if (/\/api\/routines\/[^/]+\/chores$/.test(url) && init?.method === "POST") {
        return Promise.resolve(json(null, 500));
      }
      throw new Error(`unexpected fetch after override: ${url}`);
    });

    fireEvent.change(within(card).getByPlaceholderText("Chore name"), {
      target: { value: "New chore" },
    });
    fireEvent.click(within(card).getByRole("button", { name: "Add Chore" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load chores.");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  it("announces an assignment-save failure through ErrorNotice's live region", async () => {
    const mockFetch = mockBackend();
    renderSurface();

    const card = await screen.findByTestId("routine-r1");
    fireEvent.click(within(card).getByRole("button", { name: "Members with assignments" }));
    const row = await screen.findByTestId("routine-assignment-m1");

    fireEvent.click(within(row).getByRole("checkbox", { name: "Mon" }));

    // A brand-new assignment saves immediately (no ConfirmDialog) — redirect the PUT to a
    // failure so the save itself is what fails.
    mockFetch.mockImplementation((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      if (/\/api\/routines\/[^/]+\/assignments\/[^/]+$/.test(url) && init?.method === "PUT") {
        return Promise.resolve(json(null, 500));
      }
      throw new Error(`unexpected fetch after override: ${url}`);
    });

    fireEvent.click(within(row).getByRole("button", { name: "Save Assignment" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to update assignment.");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });
});

describe("RoutinesManagement — every streak-affecting action opens a themed ConfirmDialog instead of window.confirm (research D3/FR-005)", () => {
  it("does not delete a routine until the ConfirmDialog is confirmed, and deletes on confirm", async () => {
    const mockFetch = mockBackend();
    renderSurface();

    const card = await screen.findByTestId("routine-r1");
    fireEvent.click(within(card).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("This will change the live streak.");

    // Cancel first — no DELETE must have fired.
    fireEvent.click(screen.getByTestId("routine-delete-cancel-r1"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(
      (mockFetch.mock.calls as FetchCall[]).filter(
        ([reqInput, init]) => String(reqInput) === "/api/routines/r1" && init?.method === "DELETE"
      )
    ).toHaveLength(0);

    // Now confirm.
    fireEvent.click(within(card).getByRole("button", { name: "Delete" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByTestId("routine-delete-confirm-r1"));

    await waitFor(() => {
      expect(
        (mockFetch.mock.calls as FetchCall[]).filter(
          ([reqInput, init]) => String(reqInput) === "/api/routines/r1" && init?.method === "DELETE"
        )
      ).toHaveLength(1);
    });
  });

  it("does not delete a chore until the ConfirmDialog is confirmed, and deletes on confirm", async () => {
    const mockFetch = mockBackend();
    renderSurface();

    const card = await screen.findByTestId("routine-r1");
    fireEvent.click(within(card).getByRole("button", { name: "View Chores" }));
    const choreRow = await screen.findByTestId("chore-c1");

    fireEvent.click(within(choreRow).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("This will change the live streak.");

    // No DELETE must have fired yet — the click above only opened the dialog.
    expect(
      (mockFetch.mock.calls as FetchCall[]).filter(
        ([reqInput, init]) => String(reqInput) === "/api/chores/c1" && init?.method === "DELETE"
      )
    ).toHaveLength(0);

    // Cancel first — still no DELETE.
    fireEvent.click(screen.getByTestId("routine-r1-chore-delete-cancel"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(
      (mockFetch.mock.calls as FetchCall[]).filter(
        ([reqInput, init]) => String(reqInput) === "/api/chores/c1" && init?.method === "DELETE"
      )
    ).toHaveLength(0);

    // Now confirm.
    fireEvent.click(within(choreRow).getByRole("button", { name: "Delete" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByTestId("routine-r1-chore-delete-confirm"));

    await waitFor(() => {
      expect(
        (mockFetch.mock.calls as FetchCall[]).filter(
          ([reqInput, init]) => String(reqInput) === "/api/chores/c1" && init?.method === "DELETE"
        )
      ).toHaveLength(1);
    });
  });

  it("a brand-new assignment saves immediately, with no confirmation", async () => {
    const mockFetch = mockBackend();
    renderSurface();

    const card = await screen.findByTestId("routine-r1");
    fireEvent.click(within(card).getByRole("button", { name: "Members with assignments" }));
    const row = await screen.findByTestId("routine-assignment-m1");

    fireEvent.click(within(row).getByRole("checkbox", { name: "Mon" }));
    fireEvent.click(within(row).getByRole("button", { name: "Save Assignment" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(
        (mockFetch.mock.calls as FetchCall[]).filter(
          ([reqInput, init]) =>
            String(reqInput) === "/api/routines/r1/assignments/m1" && init?.method === "PUT"
        )
      ).toHaveLength(1);
    });
  });

  it("reassigning an already-active assignment requires confirmation before the PUT fires", async () => {
    const mockFetch = mockBackend({
      assignments: [{ id: "a1", memberId: "m1", weekdays: ["mon"], active: true }],
    });
    renderSurface();

    const card = await screen.findByTestId("routine-r1");
    fireEvent.click(within(card).getByRole("button", { name: "Members with assignments" }));
    const row = await screen.findByTestId("routine-assignment-m1");

    fireEvent.click(within(row).getByRole("checkbox", { name: "Tue" }));
    fireEvent.click(within(row).getByRole("button", { name: "Save Assignment" }));

    await screen.findByRole("dialog");
    expect(
      (mockFetch.mock.calls as FetchCall[]).filter(
        ([reqInput, init]) =>
          String(reqInput) === "/api/routines/r1/assignments/m1" && init?.method === "PUT"
      )
    ).toHaveLength(0);

    fireEvent.click(screen.getByTestId("routines-assignment-m1-save-confirm"));

    await waitFor(() => {
      expect(
        (mockFetch.mock.calls as FetchCall[]).filter(
          ([reqInput, init]) =>
            String(reqInput) === "/api/routines/r1/assignments/m1" && init?.method === "PUT"
        )
      ).toHaveLength(1);
    });
  });

  it("does not deactivate an assignment until the ConfirmDialog is confirmed, and deactivates on confirm", async () => {
    const mockFetch = mockBackend({
      assignments: [{ id: "a1", memberId: "m1", weekdays: ["mon"], active: true }],
    });
    renderSurface();

    const card = await screen.findByTestId("routine-r1");
    fireEvent.click(within(card).getByRole("button", { name: "Members with assignments" }));
    const row = await screen.findByTestId("routine-assignment-m1");

    fireEvent.click(within(row).getByRole("button", { name: "Deactivate" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByTestId("routines-assignment-m1-deactivate-cancel"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(
      (mockFetch.mock.calls as FetchCall[]).filter(
        ([reqInput, init]) =>
          String(reqInput) === "/api/routines/r1/assignments/m1" && init?.method === "DELETE"
      )
    ).toHaveLength(0);

    fireEvent.click(within(row).getByRole("button", { name: "Deactivate" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByTestId("routines-assignment-m1-deactivate-confirm"));

    await waitFor(() => {
      expect(
        (mockFetch.mock.calls as FetchCall[]).filter(
          ([reqInput, init]) =>
            String(reqInput) === "/api/routines/r1/assignments/m1" && init?.method === "DELETE"
        )
      ).toHaveLength(1);
    });
  });
});

// retrofit (verification policy — re-audited 2026-09-10 late): merged before
// the panel-adoption clause existed and asserted NEITHER half for `RoutinesManagement.tsx`'s own
// `AdminPanel` — a bare `<div><h2>` (title and description deleted) would have passed this
// file's entire suite. `RoutinesManagement.tsx` DOES render through `AdminPanel` in both its
// `loading` and loaded branches (same title in each), so this is a missing assertion, not a
// missing adoption.
describe("RoutinesManagement — adopts the AdminPanel L2 frame (c retrofit)", () => {
  it("wraps the surface in a landmark region labelled by its own title, with a heading of the same name", async () => {
    mockBackend();
    renderSurface();

    // Anchor on LOADED content FIRST — this surface's OWN `loading` branch also renders through
    // `AdminPanel` with the identical title, so asserting region/heading from the very first
    // render would not, by itself, prove the assertion runs against the real, loaded surface.
    await screen.findByTestId("routine-r1");

    expect(screen.getByRole("region", { name: "Routines Management" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Routines Management" })).toBeInTheDocument();
  });
});

// Independent review lesson carried from /: assert EVERY key a typed-map replaces a
// literal `as MessageKey` cast with, not just the one obviously exercised — rendered in Spanish,
// not English, so an accidental English-literal fallback would not coincidentally still read
// wrong.
describe("RoutinesManagement — WEEKDAY_LABEL_KEYS maps each weekday to its OWN translation key, through the shared WeekdayPicker", () => {
  it("labels the WeekdayPicker with the household's own Spanish weekday abbreviations, in canonical mon..sun order", async () => {
    mockBackend({ language: "es" });
    renderSurface();

    const card = await screen.findByTestId("routine-r1");
    fireEvent.click(within(card).getByRole("button", { name: "Miembros con asignaciones" }));
    const row = await screen.findByTestId("routine-assignment-m1");

    const dayLabels = within(row)
      .getAllByRole("checkbox")
      .map((checkbox) => checkbox.closest("label")?.textContent?.trim());
    expect(dayLabels).toEqual(["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]);
  });
});

//: the last two `as MessageKey` casts this file carried (`dayPeriodLabel`'s card render and
// RoutineCreateForm's SelectItem) are replaced by indexing the shared `DAY_PERIOD_LABEL_KEYS` map
// (`DailyBriefingView.tsx`) with the closed `PeriodId` union. A single-period fixture can't
// distinguish "the correct key was picked" from "any key was picked" — two day periods, each
// feeding a DIFFERENT routine card, rendered in Spanish so an accidental English literal
// fallback would not coincidentally still read right.
describe("RoutinesManagement — DAY_PERIOD_LABEL_KEYS indexes each routine's OWN day period, through the shared map (#814)", () => {
  it("renders the morning routine's card with 'Mañana' and the evening routine's card with 'Tarde'", async () => {
    mockBackend({
      language: "es",
      dayPeriods: [DAY_PERIOD, DAY_PERIOD_EVENING],
      routines: () => json([ROUTINE, ROUTINE_EVENING]),
    });
    renderSurface();

    // Anchor on loaded content from BOTH routines first — under the applied es locale — before
    // asserting the day-period text each card renders (the /api/settings locale fetch races the
    // day-periods/routines fetches, so a synchronous getBy* here would be flaky).
    const morningCard = await screen.findByTestId("routine-r1");
    const eveningCard = await screen.findByTestId("routine-r2");

    expect(await within(morningCard).findByText("Mañana")).toBeInTheDocument();
    expect(await within(eveningCard).findByText("Tarde")).toBeInTheDocument();
  });

  it("the create form's day-period Select lists each period under its OWN label (the second changed call site — a Radix popover no other test ever opens)", async () => {
    // jsdom 30 ships no Element.prototype.scrollIntoView and Radix's open-popover focus effect
    // calls it unconditionally — same shim-and-really-restore dance as
    // select-item-density.test.tsx's beforeAll/afterAll (see its header), scoped to this one
    // test because it is the only popover this file opens.
    const originalScrollIntoView = Element.prototype.scrollIntoView as
      typeof Element.prototype.scrollIntoView | undefined;
    Element.prototype.scrollIntoView = vi.fn();
    try {
      // Independent review on the: a wrong-key mutation at the SelectItem call site
      // survived the whole suite, because SelectContent renders nothing until the trigger is
      // clicked. Open it (the members-admin.test.tsx combobox precedent) and assert both options
      // carry DISTINCT per-period labels — the same falsifier the card test provides for the
      // first call site.
      mockBackend({
        language: "es",
        dayPeriods: [DAY_PERIOD, DAY_PERIOD_EVENING],
        routines: () => json([ROUTINE, ROUTINE_EVENING]),
      });
      renderSurface();
      await screen.findByTestId("routine-r1");

      const trigger = await screen.findByRole("combobox", { name: "Seleccionar período diario" });
      fireEvent.click(trigger);

      // findAllByRole + textContent array, not per-name queries: RTL's accessible-name matching
      // does not resolve these portalled Radix options' names in jsdom (the elements exist with
      // the right text — verified by direct DOM inspection — but role+name queries miss them; the
      // members-admin precedent happens to work on its own portal, this one does not). Asserting
      // the mapped textContent pins BOTH per-period content and order, which kills the same
      // wrong-key mutation: the mutant renders ["Noche", "Noche"].
      const options = await screen.findAllByRole("option");
      expect(options.map((o) => o.textContent)).toEqual(["Mañana", "Tarde"]);
    } finally {
      if (originalScrollIntoView) {
        Element.prototype.scrollIntoView = originalScrollIntoView;
      } else {
        delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      }
    }
  });
});
