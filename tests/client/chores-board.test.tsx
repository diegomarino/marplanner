/** ChoresBoard spec (FR-008/FR-009, — the most consequential
 * surface in the product: the control a child taps to say a chore is done, on a wall-mounted
 * kiosk).
 * This is the executable evidence for the verification policy (verification policy): it CALLS
 * the frozen density assertion over this surface's rendered control set with kiosk density
 * active (not merely imports it), across every reachable interaction state with a census count
 * per phase, records a deliberate negative proving the assertion can fail on THIS surface's own
 * controls, asserts every error state is announced through `ErrorNotice`'s live region
 * (SC-011), and asserts the surface's own real behaviour — never a fixture that re-implements
 * the wiring — for the two traps unique to this surface:
 * 1. The confirmation dialog guards the UN-complete direction ONLY (FR-008/DP2) — completing
 * a chore stays one tap. Both directions get their own test (verification policy: "every
 * destructive confirm path needs its own test").
 * 2. `StatusToggle`'s `busy` guard (adopted, not reimplemented) makes a double-tap fire the
 * mutation exactly once.
 * Functional read/refetch/midnight-rollover coverage already exists elsewhere
 * (`chores-board-empty-state.test.tsx`, `tests/e2e/chores-board.spec.ts`) — this file does not
 * repeat that surface area; it only proves the migration-specific guarantees exists to
 * prove.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChoresBoard } from "@/chores/ChoresBoard";
import { HouseholdSettingsProvider } from "@/lib/householdSettings";
import { LanguageProvider } from "@/i18n";
import { DensityViolationError, assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

type FetchCall = Parameters<typeof globalThis.fetch>;

/** One column, all four fixed day periods present (FR-017 — every column always shows all
 * four, even ones with nothing scheduled), two chores: one incomplete (morning), one already
 * completed (evening) — enough to exercise both toggle directions and every period label. */
const COLUMN = {
  memberId: "m1",
  displayName: "Ari",
  streak: 3,
  todayProgress: { completed: 1, total: 2 },
  dayPeriods: [
    {
      id: "morning",
      labelKey: "dayPeriod.morning",
      chores: [
        { id: "c1", name: "Brush teeth", icon: "🪥", completed: false },
        { id: "c2", name: "Read a book", icon: "📖", completed: true },
      ],
    },
    { id: "afternoon", labelKey: "dayPeriod.afternoon", chores: [] },
    { id: "evening", labelKey: "dayPeriod.evening", chores: [] },
    { id: "night", labelKey: "dayPeriod.night", chores: [] },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status });
}

/** A fully-loaded, happy-path mock backend. `overrides` lets a single test redirect one
 * endpoint to a failure, or the board response, without re-declaring the rest — mirrors
 * `meals-management.test.tsx`'s own `mockBackend` shape. */
function mockBackend(
  overrides: Partial<{
    settings: () => Response;
    board: () => Response;
    language: string;
  }> = {}
) {
  const mockFetch = vi.fn((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (overrides.settings && url.includes("/api/settings")) {
      return Promise.resolve(overrides.settings());
    }
    if (url.includes("/api/settings")) {
      return Promise.resolve(
        json({ locale: { timezone: "UTC", language: overrides.language ?? "en" } })
      );
    }

    if (overrides.board && url.startsWith("/api/chores/board")) {
      return Promise.resolve(overrides.board());
    }
    if (url.startsWith("/api/chores/board")) {
      return Promise.resolve(json([COLUMN]));
    }

    if (url.includes("/api/day-periods")) {
      return Promise.resolve(
        json([
          { id: "morning", labelKey: "dayPeriod.morning", start: "05:00", sortOrder: 0 },
          { id: "afternoon", labelKey: "dayPeriod.afternoon", start: "23:57", sortOrder: 1 },
          { id: "evening", labelKey: "dayPeriod.evening", start: "23:58", sortOrder: 2 },
          { id: "night", labelKey: "dayPeriod.night", start: "23:59", sortOrder: 3 },
        ])
      );
    }

    if (url.includes("/api/members")) {
      return Promise.resolve(
        json([{ id: "m1", displayName: "Ari", lifecycle: "active", colorKey: "blue" }])
      );
    }

    if (url.includes("/completions") && (method === "POST" || method === "DELETE")) {
      return Promise.resolve(json(null, 204));
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
        <ChoresBoard />
      </LanguageProvider>
    </HouseholdSettingsProvider>
  );
}

/** Mirrors `density.ts`'s own selector/filter — see `meals-management.test.tsx`'s identical
 * helper for why this is duplicated rather than imported (the frozen file exposes no census
 * API by design). Lets THIS spec assert an exact control count per phase, not just "compliant
 * or not". */
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

beforeEach(() => {
  // The fixture's chores are in morning; freeze the business clock, not async timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-25T06:00:00.000Z"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  cleanup();
  document.documentElement.removeAttribute("data-density");
});

describe("ChoresBoard — kiosk density (SC-001, SC-002, SC-003)", () => {
  it("meets kiosk density across every rendered control — the default board and an open ConfirmDialog, across two phases", async () => {
    mockBackend();
    const uninject = await injectDensityStyles({ extraCandidates: ["min-h-[120px]"] });
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderSurface();

      await screen.findByTestId("chores-board-column-m1");
      const uncompleteToggle = await screen.findByTestId("chore-toggle-c2");

      // Phase 1 — three page-owned date controls, two chore toggles, and the shared column's
      // next-period control. Asserted over document.body throughout, matching the frozen
      // helper's own SC-003 idiom, even before any dialog is open.
      expect(countInteractiveControls(document.body)).toBe(6);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // Phase 2 — SC-003: tapping the ALREADY-completed chore opens the un-complete
      // ConfirmDialog, portalled by Radix to document.body OUTSIDE the board's own subtree —
      // the exact case a container-scoped mechanism would miss. Radix marks the board's
      // WRAPPING div inert (`aria-hidden="true"` on the ancestor, verified against the real
      // rendered DOM), not each control individually, and both this spec's census helper and
      // the frozen helper's own `isRenderable` check only an element's OWN attribute — neither
      // walks ancestors — so all six board controls stay counted alongside the dialog's two
      // buttons.
      fireEvent.click(uncompleteToggle);
      await screen.findByRole("dialog");

      expect(countInteractiveControls(document.body)).toBe(8);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("DELIBERATE NEGATIVE — forcing this surface's own toggle below the kiosk minimum makes the assertion fail", async () => {
    mockBackend();
    const uninject = await injectDensityStyles({ extraCandidates: ["min-h-[120px]"] });
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = renderSurface();
      const toggle = await screen.findByTestId("chore-toggle-c1");

      // A real control from this surface, not a synthetic fixture.
      toggle.style.height = "10px";
      toggle.style.fontSize = "8px";

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
    } finally {
      uninject();
    }
  });
});

describe("ChoresBoard — error states are announced (SC-011)", () => {
  it("announces a board load failure through ErrorNotice's live region", async () => {
    mockBackend({ board: () => json(null, 500) });
    renderSurface();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load the board.");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  it("announces a toggle (mutation) failure through ErrorNotice's live region", async () => {
    const mockFetch = mockBackend();
    renderSurface();

    const toggle = await screen.findByTestId("chore-toggle-c1");
    // Redirect the completion POST to a failure for this one interaction, after the initial
    // board load already succeeded.
    mockFetch.mockImplementation((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      if (url.includes("/completions") && init?.method === "POST") {
        return Promise.resolve(json(null, 500));
      }
      throw new Error(`unexpected fetch after override: ${url}`);
    });

    fireEvent.click(toggle);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not update the chore. Please try again.");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });
});

describe("ChoresBoard — the ConfirmDialog guards the UN-complete direction ONLY (FR-008, DP2)", () => {
  it("completing an incomplete chore stays a single, ungated tap — no dialog, immediate POST", async () => {
    const mockFetch = mockBackend();
    renderSurface();

    const toggle = await screen.findByTestId("chore-toggle-c1");
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(toggle);

    // No dialog was ever opened for this direction.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(
        (mockFetch.mock.calls as FetchCall[]).filter(
          ([reqInput, init]) =>
            String(reqInput) === "/api/chores/c1/completions" && init?.method === "POST"
        )
      ).toHaveLength(1);
    });
  });

  it("does not un-complete an already-completed chore until the ConfirmDialog is confirmed, and un-completes on confirm", async () => {
    const mockFetch = mockBackend();
    renderSurface();

    const toggle = await screen.findByTestId("chore-toggle-c2");
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(toggle);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Undo this chore?");

    // Cancel first — no DELETE must have fired.
    fireEvent.click(screen.getByTestId("chores-uncomplete-cancel"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(
      (mockFetch.mock.calls as FetchCall[]).filter(
        ([reqInput, init]) =>
          String(reqInput).startsWith("/api/chores/c2/completions") && init?.method === "DELETE"
      )
    ).toHaveLength(0);

    // Now confirm.
    fireEvent.click(toggle);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByTestId("chores-uncomplete-confirm"));

    await waitFor(() => {
      expect(
        (mockFetch.mock.calls as FetchCall[]).filter(
          ([reqInput, init]) =>
            String(reqInput).startsWith("/api/chores/c2/completions") && init?.method === "DELETE"
        )
      ).toHaveLength(1);
    });
  });
});

describe("ChoresBoard — StatusToggle's busy guard prevents a double-tap firing twice (adopted, not reimplemented)", () => {
  it("a second tap while the first request is still in flight fires no second request", async () => {
    const mockFetch = mockBackend();
    renderSurface();

    const toggle = await screen.findByTestId("chore-toggle-c1");

    fireEvent.click(toggle);

    // (independent): the request-count assertion below is ALSO
    // satisfied by the pre-existing `pending.has(chore.id)` early return in `toggleChore`
    // alone — removing `busy={busy}` (mutation M2) survived, because a plain guard clause
    // stops the SECOND call from ever reaching `fetch` even with no `disabled` attribute at
    // all. This spec's own inline comment used to claim a mechanism ("the button is now
    // `disabled`... a native disabled control never dispatches a click") it never actually
    // checked. Asserting the real DOM state here is what makes M2 die: `busy` wires
    // `aria-busy`/`disabled` on `StatusToggle` (see StatusToggle.tsx), and losing `busy={busy}`
    // at this call site would leave the control clickable and NOT `aria-busy` while a request
    // is in flight, even though the request-count assertion alone would still pass.
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("aria-busy", "true");

    // The button is now `disabled` (StatusToggle's busy guard) — a native disabled control
    // never dispatches a click, so this is a true no-op, not a race the test happens to win.
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(
        (mockFetch.mock.calls as FetchCall[]).filter(
          ([reqInput, init]) =>
            String(reqInput) === "/api/chores/c1/completions" && init?.method === "POST"
        )
      ).toHaveLength(1);
    });

    // Busy clears once the mutation (and its refetch) settle.
    await waitFor(() => expect(toggle).not.toBeDisabled());
    expect(toggle).not.toHaveAttribute("aria-busy");
  });
});

describe("ChoresBoard — StatusToggle's accessible name is state-invariant (MEDIUM-3, independent review on PR #779)", () => {
  // A chore's own name is ALREADY state-invariant (unaffected by its completion state) — see
  // StatusToggle.tsx's own doc comment, which names this exact call site. `accessibleName` is
  // therefore the chore's plain name, unchanged across a toggle: `aria-pressed` alone carries
  // the state, never re-announced inside the name (that shape — a PREVIOUS revision's
  // `${chore.name} ${stateWord}` — made a screen reader announce the state TWICE, e.g. "Read a
  // book Done, toggle button, pressed", and re-announce the whole name on every toggle).
  it("gives a completed chore's toggle just its name as the accessible name, with aria-pressed carrying the state", async () => {
    mockBackend();
    renderSurface();

    const toggle = await screen.findByTestId("chore-toggle-c2");

    // The visible SVG check has no text node; the accessible name stays stable.
    expect(toggle).toHaveTextContent(/^Read a book$/);
    expect(toggle).toHaveAccessibleName("Read a book");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("gives an incomplete chore's toggle the SAME name — the accessible name does not change across the toggle", async () => {
    mockBackend();
    renderSurface();

    const toggle = await screen.findByTestId("chore-toggle-c1");

    expect(toggle).toHaveTextContent(/^Brush teeth$/);
    expect(toggle).toHaveAccessibleName("Brush teeth");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });
});

describe("ChoresBoard — chore presentation", () => {
  it("owns day navigation outside the shared columns and reloads the selected date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T06:00:00.000Z"));
    const fetch = mockBackend();
    renderSurface();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole("heading", { name: "Friday, September 25" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      fetch.mock.calls.some(([input]) =>
        String(input).includes("/api/chores/board?date=2026-09-24")
      )
    ).toBe(true);
    expect(screen.getByRole("heading", { name: "Thursday, September 24" })).toBeVisible();

    fireEvent.click(screen.getByTestId("chore-toggle-c1"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const selectedDateCompletion = fetch.mock.calls.find(
      ([input, init]) => String(input) === "/api/chores/c1/completions" && init?.method === "POST"
    );
    expect(selectedDateCompletion).toBeDefined();
    expect(JSON.parse(String(selectedDateCompletion?.[1]?.body))).toMatchObject({
      date: "2026-09-24",
    });
  });

  it("shows the same one-period column interaction as the dashboard", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T06:00:00.000Z"));
    mockBackend();
    renderSurface();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const column = screen.getByTestId("chores-board-column-m1");
    expect(within(column).getByRole("heading", { name: "Morning" })).toBeVisible();
    expect(within(column).queryByRole("heading", { name: "Afternoon" })).not.toBeInTheDocument();

    fireEvent.click(within(column).getByRole("button", { name: "Show next period" }));

    expect(within(column).getByRole("heading", { name: "Afternoon" })).toBeVisible();
    expect(within(column).queryByRole("heading", { name: "Morning" })).not.toBeInTheDocument();
  });

  it("renders each chore icon and visually subdues completed chores", async () => {
    mockBackend();
    renderSurface();

    // Icons are drawn from the vendored Noto set, so the emoji itself is not a text node.
    const brush = (await screen.findByTestId("chore-toggle-c1")).querySelector("[data-emoji]");
    expect(brush).toHaveAttribute("data-emoji", "🪥");
    expect(brush).not.toHaveClass("line-through");
    expect(brush?.querySelector("img")).toHaveAttribute("src", expect.stringContaining("1faa5"));
    const book = screen.getByTestId("chore-toggle-c2").querySelector("[data-emoji]");
    expect(book).toHaveAttribute("data-emoji", "📖");
    expect(book).toHaveClass("line-through");
    expect(screen.getByText("Read a book")).toHaveClass("line-through", "text-muted-foreground");
  });
});

// Independent review lesson carried from (MealsManagement, / parity):
// assert EVERY map an `as MessageKey` -> typed-map refactor creates, not just the one site
// obviously exercised — a swapped key in `DAY_PERIOD_LABEL_KEYS`, or replacing one `t(...)`
// call with an English literal, both pass a suite that only checks a single period. Rendered
// in Spanish, not English, for the same reason as MealsManagement's weekday-parity test: an
// English literal fallback would coincidentally still read wrong but not prove the label comes
// from the i18n catalogue at all.
describe("ChoresBoard — DAY_PERIOD_LABEL_KEYS maps each day period to its OWN translation key, through i18n", () => {
  it("labels every one of the four day periods with its own translated name, under a non-English household locale", async () => {
    mockBackend({ language: "es" });
    renderSurface();

    const column = await screen.findByTestId("chores-board-column-m1");
    // Order-and-content, not a set comparison — a morning<->evening swap in the map would
    // preserve the SET of labels while breaking which period gets which one.
    const periodHeadings = [within(column).getByRole("heading").textContent];
    for (let index = 0; index < 3; index += 1) {
      fireEvent.click(within(column).getByRole("button", { name: "Mostrar período siguiente" }));
      periodHeadings.push(within(column).getByRole("heading").textContent);
    }
    expect(periodHeadings).toEqual(["Mañana", "Mediodía", "Tarde", "Noche"]);
  });
});

describe("ChoresBoard — shared today-chores state extraction", () => {
  it("keeps the existing server-authoritative refresh after a direct completion", async () => {
    let boardReads = 0;
    const refreshedColumn = {
      ...COLUMN,
      dayPeriods: COLUMN.dayPeriods.map((period) =>
        period.id === "morning"
          ? {
              ...period,
              chores: [{ id: "c1", name: "Brush teeth", icon: "🪥", completed: true }],
            }
          : period
      ),
    };
    const mockFetch = vi.fn((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      if (url.includes("/api/settings")) {
        return Promise.resolve(json({ locale: { timezone: "UTC", language: "en" } }));
      }
      if (url.startsWith("/api/chores/board")) {
        return Promise.resolve(json([boardReads++ === 0 ? COLUMN : refreshedColumn]));
      }
      if (url === "/api/chores/c1/completions" && init?.method === "POST") {
        return Promise.resolve(json(null, 204));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", mockFetch);
    renderSurface();

    fireEvent.click(await screen.findByTestId("chore-toggle-c1"));

    await waitFor(() => {
      expect(screen.getByTestId("chore-toggle-c1")).toHaveAttribute("aria-pressed", "true");
      expect(boardReads).toBe(2);
    });
  });
});
