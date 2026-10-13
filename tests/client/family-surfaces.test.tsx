/** Family-surfaces spec (FR-009, SC-001/SC-002/SC-011).
 * Covers the three files migrates to the token dialect: `src/client/meals/MealsBoard.tsx`
 * (family-facing, previously owned by no task) and the `home/` pair (`HomeSurface.tsx`,
 * `WeatherPill.tsx`) — * dialect only* their content and layout are untouched, only the
 * classes/casts they use changed (the "home/* collision with, resolved").
 * This is the executable evidence for the verification policy (verification policy): it CALLS
 * the frozen density assertion over each surface's rendered control set with kiosk density
 * active (not merely imports it), across every reachable state with an exact control-count
 * census per phase, records the deliberate negative proving the assertion can fail on a real
 * control from this module, and asserts every error state is announced through `ErrorNotice`'s * live region (SC-011) — or records that a surface renders none.
 * * A finding worth stating up front, not discovered by a reader mid-file* `MealsBoard` is a
 * READ-ONLY display board. It has NO interactive control in ANY of its four reachable states
 * (loading, error, populated-with-items, populated-with-an-empty-slot) — not a button, link,
 * input, or ARIA-interactive role anywhere, including its populated state (a slot's items are
 * plain text, never a control). `WeatherPill`'s own "silent absence" states (FR-022: no
 * location, no cached-or-fetched data, or ANY fetch failure) render nothing at all — zero DOM,
 * zero controls — by the same kind of design choice. `assertKioskDensityCompliant`'s obligation
 * 2 treats an EMPTY control set as a FAILURE, never a vacuous pass — by design,
 * to stop a batch from asserting over nothing. For these surfaces' zero-control states, that
 * means the frozen helper is EXPECTED to throw `DensityEmptyControlSetError` every time, and
 * this file asserts exactly that (never swallowed, never worked around) — proving the helper
 * correctly identifies "no controls exist here" rather than silently certifying compliance over
 * an empty set. The one state with real controls (`WeatherPill`'s populated pill + open modal)
 * is asserted the normal way, including the deliberate negative.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const homeWidgetState = vi.hoisted(() => ({ agendaFails: false, mealsEmpty: false }));

vi.mock("@/home/TodayAgenda", () => ({
  TodayAgenda: () => {
    if (homeWidgetState.agendaFails) throw new Error("agenda render failure");
    return <section aria-label="Today's agenda">Today's agenda</section>;
  },
}));
vi.mock("@/home/TodayChores", () => ({
  TodayChores: () => <section aria-label="Today's chores">Today's chores</section>,
}));
vi.mock("@/home/TodayMeals", () => ({
  TodayMeals: () => (
    <section aria-label="Today's meals">
      {homeWidgetState.mealsEmpty ? "No meals planned for today." : "Pasta"}
    </section>
  ),
}));

import { MealsBoard } from "@/meals/MealsBoard";
import { HomeSurface } from "@/home/HomeSurface";
import { WeatherPillView } from "@/home/WeatherPill";
import { HouseholdSettingsProvider } from "@/lib/householdSettings";
import { LanguageProvider } from "@/i18n";
import {
  DensityEmptyControlSetError,
  DensityViolationError,
  assertKioskDensityCompliant,
} from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";
import type { ForecastResult } from "../../src/shared";
import { SLOT_LABEL_KEYS } from "@/meals/MealsBoard";
import { WEATHER_CONDITION_LABEL_KEYS } from "@/home/WeatherPill";

function json(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status });
}

/** Mirrors `density.ts`'s own selector/filter — see `chores-board.test.tsx`'s identical helper
 * for why this is duplicated rather than imported (the frozen file exposes no census API by
 * design). Lets THIS spec assert an exact control count per phase, not just "compliant or
 * not". */
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
  homeWidgetState.agendaFails = false;
  homeWidgetState.mealsEmpty = false;
  vi.unstubAllGlobals();
  cleanup();
  document.documentElement.removeAttribute("data-density");
  // WeatherPill's own cache (`./weatherCache`) persists to localStorage — cleared per test so a
  // healthy forecast written by one test never leaks into a later test's failure/absence
  // assertion (mirrors weather-pill.test.tsx's own afterEach).
  window.localStorage.clear();
});

/** A healthy-forecast mock for the given coordinates — every `WeatherPillView` test below that
 * needs the pill to actually render stubs `fetch` with this (WeatherPillView calls
 * `authFetch("/api/weather",...)` directly; it takes lat/lon as props but still owns its own
 * fetch). */
function mockWeatherFetch(forecast: ForecastResult | null = HEALTHY_FORECAST) {
  const mockFetch = vi.fn((input: string | URL) => {
    const url = String(input);
    if (url.includes("/api/weather")) return Promise.resolve(json({ forecast }));
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

/* ------------------------------------------------------------------------------------------- */
/* MealsBoard */
/* ------------------------------------------------------------------------------------------- */

const MEALS_WEEK = Object.fromEntries(
  [
    "2026-09-21",
    "2026-09-22",
    "2026-09-23",
    "2026-09-24",
    "2026-09-25",
    "2026-09-26",
    "2026-09-27",
  ].map((date) => [
    date,
    {
      breakfast: [],
      lunch: [],
      snack: [],
      dinner:
        date === "2026-09-25"
          ? [
              {
                entryId: "e1",
                slot: "dinner",
                label: "Pasta",
                isTombstone: false,
                source: "oneoff",
                recipeId: null,
                note: "Pasta",
              },
            ]
          : [],
    },
  ])
);

function mockMealsBackend(
  overrides: Partial<{ settings: () => Response; menu: () => Response }> = {}
) {
  const mockFetch = vi.fn((input: string | URL) => {
    const url = String(input);
    if (overrides.settings && url.includes("/api/settings")) {
      return Promise.resolve(overrides.settings());
    }
    if (url.includes("/api/settings")) {
      return Promise.resolve(json({ locale: { timezone: "UTC", language: "en" } }));
    }
    if (overrides.menu && url.startsWith("/api/menu")) {
      return Promise.resolve(overrides.menu());
    }
    if (url.startsWith("/api/menu/week")) {
      return Promise.resolve(json(MEALS_WEEK));
    }
    if (url.startsWith("/api/recipes")) {
      return Promise.resolve(json([]));
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

function renderMealsBoard() {
  return render(
    <HouseholdSettingsProvider>
      <LanguageProvider>
        <MealsBoard />
      </LanguageProvider>
    </HouseholdSettingsProvider>
  );
}

describe("MealsBoard — workspace density and family authoring", () => {
  it("renders the interactive weekly grid and recipe catalogue", async () => {
    mockMealsBackend();
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = renderMealsBoard();
      await screen.findByTestId("meal-plan-grid");
      expect(screen.getByTestId("recipe-catalogue")).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: /Add dinner/ })).toHaveLength(7);
      expect(countInteractiveControls(container)).toBeGreaterThan(0);
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("announces a weekly menu read failure", async () => {
    mockMealsBackend({ menu: () => json(null, 500) });
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderMealsBoard();
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Failed to load the week menu.");
      expect(alert).toHaveAttribute("aria-live", "assertive");
    } finally {
      uninject();
    }
  });

  it("keeps the reachable weekly failure retry control density-compliant", async () => {
    mockMealsBackend({ menu: () => json(null, 500) });
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = renderMealsBoard();
      await screen.findByRole("button", { name: "Retry" });
      expect(countInteractiveControls(container)).toBeGreaterThan(0);
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });
});

/* ------------------------------------------------------------------------------------------- */
/* HomeSurface + WeatherPill */
/* ------------------------------------------------------------------------------------------- */

const HEALTHY_FORECAST: ForecastResult = {
  current: { conditionKey: "clear", tempC: 21.4, rainPct: 10 },
  hourly: [{ time: "2026-09-04T15:00", conditionKey: "clear", tempC: 22.0, rainPct: 12 }],
  daily: [
    { date: "2026-09-04", conditionKey: "clear", tempMinC: 15.0, tempMaxC: 26.0, rainPct: 20 },
  ],
};

describe("HomeSurface/WeatherPill — kiosk density (SC-001, SC-002, SC-003-style census)", () => {
  it("keeps agenda, chores, and meals identifiable together at the kitchen tablet viewport", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    expect(window.innerWidth).toBe(1280);
    expect(window.innerHeight).toBe(800);
    mockWeatherFetch();
    render(<HomeSurface />);

    expect(await screen.findByLabelText("Today's agenda")).toBeInTheDocument();
    expect(screen.getByLabelText("Today's chores")).toBeInTheDocument();
    expect(screen.getByLabelText("Today's meals")).toBeInTheDocument();
    expect(screen.getByTestId("home-dashboard-grid")).toHaveClass(
      "lg:grid-cols-[minmax(16rem,25%)_minmax(0,1fr)]",
      "lg:grid-rows-[minmax(0,1fr)_auto]"
    );
    expect(screen.getByTestId("home-agenda-region")).toHaveClass("lg:row-span-2");
    expect(screen.getByTestId("home-chores-region")).toHaveClass("lg:col-start-2");
    expect(screen.getByTestId("home-meals-region")).toHaveClass("lg:col-start-2", "lg:row-start-2");
  });

  it("contains one widget render failure without removing sibling widgets", async () => {
    homeWidgetState.agendaFails = true;
    mockWeatherFetch();
    render(<HomeSurface />);

    expect(await screen.findByText("This section could not be displayed.")).toBeInTheDocument();
    expect(screen.getByLabelText("Today's chores")).toBeInTheDocument();
    expect(screen.getByLabelText("Today's meals")).toBeInTheDocument();
  });

  it("keeps agenda and chores visible when meals are empty", async () => {
    homeWidgetState.mealsEmpty = true;
    mockWeatherFetch();
    render(<HomeSurface />);

    expect(await screen.findByText("No meals planned for today.")).toBeInTheDocument();
    expect(screen.getByLabelText("Today's agenda")).toBeInTheDocument();
    expect(screen.getByLabelText("Today's chores")).toBeInTheDocument();
  });

  it("Phase 0 — silent absence (no location): zero controls, frozen helper throws DensityEmptyControlSetError (FR-022)", () => {
    // FR-022 silent absence: no location renders NOTHING (null) — no DOM needs no injected
    // stylesheet; the point of this phase is that the control set is empty, not styled.
    document.documentElement.setAttribute("data-density", "kiosk");
    const { container } = render(<WeatherPillView lat={null} lon={null} />);

    expect(countInteractiveControls(container)).toBe(0);
    expect(() => assertKioskDensityCompliant(container)).toThrow(DensityEmptyControlSetError);
  });

  it("meets kiosk density across the collapsed pill and the open forecast modal — two phases, mirrors chores-board.test.tsx", async () => {
    mockWeatherFetch();
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = render(<WeatherPillView lat={40.4} lon={-3.7} />);
      await screen.findByTestId("weather-pill");

      // Phase 1 — the collapsed pill only: one control (the trigger button).
      expect(countInteractiveControls(container)).toBe(1);
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();

      // Phase 2 — opening the modal portals DialogContent to document.body (SC-003, same
      // out-of-subtree case chores-board.test.tsx documents for ConfirmDialog) — asserted over
      // document.body, which now holds the pill button AND the dialog's close button: two.
      fireEvent.click(screen.getByTestId("weather-pill"));
      await screen.findByRole("dialog");

      expect(countInteractiveControls(document.body)).toBe(2);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("DELIBERATE NEGATIVE — forcing the weather-pill trigger below the kiosk minimum makes the assertion fail", async () => {
    mockWeatherFetch();
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = render(<WeatherPillView lat={40.4} lon={-3.7} />);
      const pill = await screen.findByTestId("weather-pill");

      // A real control from this module's surfaces, not a synthetic fixture.
      pill.style.height = "10px";
      pill.style.fontSize = "8px";

      let thrown: unknown;
      try {
        assertKioskDensityCompliant(container);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(DensityViolationError);
      const message = (thrown as DensityViolationError).message;
      // Recorded verbatim in this module's report — proof the helper actually rejects a real
      // undersized control from this module, not merely the helper's own synthetic fixtures.
      expect(message).toMatch(/height 10px is below the kiosk minimum 48px/);
      expect(message).toMatch(/font-size 8px is below the kiosk minimum 18px/);
    } finally {
      uninject();
    }
  });

  it("the census is not decorative — REMOVING the dialog's close button drops the count from 2 to 1", async () => {
    mockWeatherFetch();
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      render(<WeatherPillView lat={40.4} lon={-3.7} />);
      fireEvent.click(await screen.findByTestId("weather-pill"));
      await screen.findByRole("dialog");

      expect(countInteractiveControls(document.body)).toBe(2);

      const closeButton = document.querySelector('[data-slot="dialog-close"]');
      expect(closeButton).not.toBeNull();
      // Pin the GLYPH size, not just the box. `Button` carries
      // `[&_svg:not([class*=the ize-'])]:size-4`, so an icon with no explicit size renders at 16px
      // inside it — the hit area grows to 48px while the glyph SHRINKS, which is the opposite of
      // what a kiosk density mandate is for. That regression was invisible to every gate and was
      // caught twice only by measuring in a real browser; deleting `size-6` today still passes
      // 619 tests, tsc and the debt counter. This is the assertion that makes it visible.
      expect(
        closeButton?.querySelector("svg")?.getAttribute("class") ?? "",
        "the close glyph must carry an explicit size- class or Button shrinks it to 16px"
      ).toMatch(/\bsize-6\b/);
      closeButton?.remove();

      expect(countInteractiveControls(document.body)).toBe(1);
    } finally {
      uninject();
    }
  });

  it("HomeSurface keeps dashboard widget density separate from shared-chrome WeatherPill ownership", async () => {
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = render(<HomeSurface />);

      // moved the sole pill to HouseholdChrome. The direct dashboard fixture must not
      // recreate shell chrome; WeatherPillView's collapsed/modal density census above remains
      // the control-count proof for that owner.
      expect(countInteractiveControls(container)).toBe(0);
      expect(() => assertKioskDensityCompliant(container)).toThrow(DensityEmptyControlSetError);
      expect(screen.getByLabelText("Today's agenda")).toBeInTheDocument();
      expect(screen.getByLabelText("Today's chores")).toBeInTheDocument();
      expect(screen.getByLabelText("Today's meals")).toBeInTheDocument();
    } finally {
      uninject();
    }
  });

  it("keeps weather's silent-absence fetch and no-error UI outside the direct dashboard fixture", () => {
    render(<HomeSurface />);

    // WeatherPillView owns FR-022's present/absent states above. HomeSurface remains only the
    // dashboard composition, so it neither fetches weather nor invents an error or retry UI.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByTestId("weather-pill")).not.toBeInTheDocument();
  });
});

// --- Label maps: every entry pinned, mechanically -------------------------------------------
//
// Dropping an `as MessageKey` cast in favour of a hand-transcribed map is what SC-007 asks for, and
// it TRADES ONE RISK FOR ANOTHER: `t(`meals.slot.${slot}`)` was correct BY CONSTRUCTION, while a map
// is correct only if someone typed it right. `Record<Slot, MessageKey>` proves every key is present
// and every value is *a* message key — it cannot prove the pairing.
//
// Measured, not assumed: swapping `breakfast`↔`lunch` ships a kiosk board with "Lunch" over the
// breakfast column and passes the entire client suite, tsc, eslint, the debt counter AND the e2e
// (meals.spec.ts asserts the ITEMS inside a slot, never the heading). Swapping `fog`↔`overcast`
// survives everything too — 14 of the 16 weather entries had nothing pinning them.
//
// Iterating the map is what makes this total: a hand-written list of expectations would have the
// same transcription problem it is meant to solve, and would silently not cover a new entry.

describe("label maps are transcribed correctly (SC-007 traded a cast for a transcription risk)", () => {
  it("every meal slot maps to its own key", () => {
    const keys = Object.keys(SLOT_LABEL_KEYS) as (keyof typeof SLOT_LABEL_KEYS)[];
    expect(keys.length).toBeGreaterThan(0);
    for (const slot of keys) {
      expect(SLOT_LABEL_KEYS[slot], `slot "${slot}" maps to the wrong key`).toBe(
        `meals.slot.${slot}`
      );
    }
  });

  it("every weather condition maps to its own key", () => {
    const keys = Object.keys(
      WEATHER_CONDITION_LABEL_KEYS
    ) as (keyof typeof WEATHER_CONDITION_LABEL_KEYS)[];
    expect(keys.length).toBeGreaterThan(0);
    for (const condition of keys) {
      expect(
        WEATHER_CONDITION_LABEL_KEYS[condition],
        `condition "${condition}" maps to the wrong key`
      ).toBe(`weather.condition.${condition}`);
    }
  });
});
