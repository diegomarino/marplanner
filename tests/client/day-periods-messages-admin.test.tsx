/** DayPeriodsManagement + DailyMessagesManagement spec (FR-009) —
 * the two surfaces that configure what the household sees each day.
 * This is the executable evidence for the verification policy (verification policy): it CALLS
 * the frozen density assertion over each surface's rendered control set with kiosk density
 * active (not merely imports it), across every reachable interaction state with an exact
 * control-count census per phase, proves the census actually fires on a real control REMOVAL,
 * records a deliberate negative per surface proving the assertion can fail on THAT surface's own
 * controls, asserts every error state either surface can render is announced through the shared
 * `ErrorNotice` live region AND carries `ErrorNotice`'s own token class (identity, not just
 * behaviour), asserts the shared `AdminPanel` L2 frame was actually adopted (region + heading,
 * not region alone), and pins `DayPeriodsManagement`'s `DAY_PERIOD_LABEL_KEYS` label map.
 * * `ConfirmDialog` is adopted by `DailyMessagesManagement` for its one destructive action* * (deleting a daily message) — this REPLACES the previous `window.confirm(...)` synchronous
 * browser dialog. The falsifying assertion (verification policy): the delete fetch does not fire until
 * the dialog is confirmed, and cancelling leaves the message undone/still present.
 * * `ConfirmDialog` is deliberately NOT adopted by `DayPeriodsManagement`* — it has no
 * destructive action at all (only an in-place start-time edit, saved per card).
 * * `WeekdayPicker`/`StatusToggle`/`CheckboxField`/`RadioField` do not apply to either surface* —
 * neither renders a weekday list, a pressed-state toggle, a checkbox or a radio control.
 * Functional CRUD coverage already exists (`tests/client/day-periods-management.test.tsx`,
 * `tests/client/day-periods-i18n-parity.test.ts`, `tests/client/daily-messages-i18n-parity.test.ts`,
 * plus `tests/e2e/day-periods.spec.ts` and `tests/e2e/daily-messages.spec.ts`) — this file does not
 * repeat that surface area; it only proves the migration-specific guarantees exists to prove.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DAY_PERIOD_LABEL_KEYS, DayPeriodsManagement } from "@/admin/DayPeriodsManagement";
import { DailyMessagesManagement } from "@/admin/DailyMessagesManagement";
import { HouseholdSettingsProvider } from "@/lib/householdSettings";
import { LanguageProvider } from "@/i18n";
import { messages } from "@/i18n/messages";
import {
  Role,
  type DailyMessage,
  type DayPeriodDTO,
  type Member,
  type PeriodId,
} from "../../src/shared";
import { DensityViolationError, assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

// DayPeriodsManagement's own admin-unlock double-gate (see the file's exported wrapper) — every
// spec in this file exercises the always-rendering `DayPeriodsManagementContent`, mirroring
// `day-periods-management.test.tsx`'s existing mock.
vi.mock("@/lib/adminUnlock", () => ({
  useAdminUnlock: () => ({ unlocked: true, setUnlocked: vi.fn() }),
}));

vi.mock("@/lib/household-date", () => ({
  todayInHouseholdTimezone: () => "2026-01-15",
}));

/** Mirrors `density.ts`'s own selector/filter — see `backups-telemetry-admin.test.tsx`'s * identical helper for why this is duplicated rather than imported (the frozen file exposes no
 * census API by design). Lets THIS spec assert an exact control count per phase, not just
 * "compliant or not". Asserted against `document.body` throughout (not the render `container`):
 * `ConfirmDialog` portals outside the rendering surface's own subtree (Radix `Dialog`), the exact
 * "outside the page subtree" case FR-001/ exists to prove density reaches. */
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status });
}

/* ------------------------------------------------------------------ */
/* DayPeriodsManagement fixtures */
/* ------------------------------------------------------------------ */

const PERIODS: DayPeriodDTO[] = [
  { id: "morning", labelKey: "dayPeriod.morning", start: "05:00", sortOrder: 0 },
  { id: "afternoon", labelKey: "dayPeriod.afternoon", start: "12:00", sortOrder: 1 },
  { id: "evening", labelKey: "dayPeriod.evening", start: "18:00", sortOrder: 2 },
  { id: "night", labelKey: "dayPeriod.night", start: "21:00", sortOrder: 3 },
];

function mockDayPeriodsBackend(
  overrides: Partial<{
    list: () => Response;
    patch: (id: string, body: unknown) => Response;
    language: string;
  }> = {}
) {
  const mockFetch = vi.fn((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url === "/api/settings") {
      return Promise.resolve(
        jsonResponse({ locale: { timezone: "UTC", language: overrides.language ?? "en" } })
      );
    }
    if (url === "/api/day-periods" && method === "GET") {
      return Promise.resolve(overrides.list ? overrides.list() : jsonResponse(PERIODS));
    }
    const patchMatch = /^\/api\/day-periods\/([^/]+)$/.exec(url);
    if (patchMatch && method === "PATCH") {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      return Promise.resolve(
        overrides.patch
          ? overrides.patch(patchMatch[1], body)
          : jsonResponse({ ...PERIODS.find((p) => p.id === patchMatch[1]), ...body })
      );
    }

    throw new Error(`unexpected fetch: ${url} (${method})`);
  });

  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

function renderDayPeriods() {
  return render(
    <HouseholdSettingsProvider>
      <LanguageProvider>
        <DayPeriodsManagement />
      </LanguageProvider>
    </HouseholdSettingsProvider>
  );
}

/* ------------------------------------------------------------------ */
/* DailyMessagesManagement fixtures */
/* ------------------------------------------------------------------ */

function makeMember(overrides: Partial<Member> = {}): Member {
  return {
    id: "member-1",
    displayName: "Alex",
    colorKey: "blue",
    role: Role.child,
    lifecycle: "active",
    createdAt: 0,
    updatedAt: 0,
    celebration: { preset: "confetti" },
    ...overrides,
  };
}

function makeMessage(overrides: Partial<DailyMessage> = {}): DailyMessage {
  return {
    id: "msg-1",
    memberId: "member-1",
    date: "2026-01-15",
    text: "Have a great day!",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function mockDailyMessagesBackend(
  overrides: Partial<{
    members: () => Response;
    list: () => Response;
    put: () => Response;
    del: () => Response;
    language: string;
  }> = {}
) {
  const mockFetch = vi.fn((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url === "/api/settings") {
      return Promise.resolve(
        jsonResponse({ locale: { timezone: "UTC", language: overrides.language ?? "en" } })
      );
    }
    if (url === "/api/members" && method === "GET") {
      return Promise.resolve(
        overrides.members ? overrides.members() : jsonResponse([makeMember()])
      );
    }
    if (url.startsWith("/api/daily-messages") && method === "GET") {
      return Promise.resolve(overrides.list ? overrides.list() : jsonResponse([]));
    }
    if (url === "/api/daily-messages" && method === "PUT") {
      return Promise.resolve(overrides.put ? overrides.put() : jsonResponse(makeMessage()));
    }
    if (url.startsWith("/api/daily-messages") && method === "DELETE") {
      return Promise.resolve(overrides.del ? overrides.del() : jsonResponse({}, 200));
    }

    throw new Error(`unexpected fetch: ${url} (${method})`);
  });

  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

function renderDailyMessages() {
  return render(
    <HouseholdSettingsProvider>
      <LanguageProvider>
        <DailyMessagesManagement />
      </LanguageProvider>
    </HouseholdSettingsProvider>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  document.documentElement.removeAttribute("data-density");
});

describe("DayPeriodsManagement / DailyMessagesManagement — the shared AdminPanel L2 frame was ADOPTED (FR-009)", () => {
  it("DayPeriodsManagement wraps the surface in a landmark region labelled by its own title", async () => {
    mockDayPeriodsBackend();
    renderDayPeriods();

    // A bare `<div>` in place of AdminPanel passes every functional test in this file — this is
    // the only assertion that would catch it (verification policy).
    expect(await screen.findByRole("region", { name: "Day Periods" })).toBeInTheDocument();
    // Region alone is bypassable: AdminPanel names its region via `aria-labelledby` pointing at
    // its own heading, so a hand-rolled `<section aria-label="Day Periods">` with NO heading
    // reproduces the landmark and its name and passes. The heading is the half a substitute
    // would have to reproduce the component to satisfy.
    expect(screen.getByRole("heading", { name: "Day Periods" })).toBeInTheDocument();
  });

  it("DailyMessagesManagement wraps the surface in a landmark region labelled by its own title", async () => {
    mockDailyMessagesBackend();
    renderDailyMessages();

    expect(await screen.findByRole("region", { name: "Messages" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Messages" })).toBeInTheDocument();
  });
});

describe("DayPeriodsManagement — kiosk density across every reachable state (SC-001, SC-002)", () => {
  it("renders the DELIBERATE zero-control census while the initial /api/day-periods fetch is unresolved", async () => {
    let resolveList: (() => void) | undefined;
    const mockFetch = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url === "/api/settings") {
        return Promise.resolve(jsonResponse({ locale: { timezone: "UTC", language: "en" } }));
      }
      if (url === "/api/day-periods") {
        return new Promise<Response>((resolve) => {
          resolveList = () => resolve(jsonResponse(PERIODS));
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", mockFetch);
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderDayPeriods();
      await screen.findByText("Loading…");

      // No button/input exists anywhere while the list is unresolved — zero is the correct,
      // DELIBERATE value (the frozen helper fails closed on an empty set by design,
      // obligation 2 — it CANNOT be called here), which is exactly why the verification policy asks
      // for an explicit census alongside the density assertion, not the density assertion alone.
      expect(countInteractiveControls(document.body)).toBe(0);

      resolveList?.();
      await screen.findByTestId("day-period-morning");
    } finally {
      uninject();
    }
  });

  it("meets kiosk density with all four periods editable (4 inputs + 4 Save buttons = 8 controls)", async () => {
    mockDayPeriodsBackend();
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderDayPeriods();
      await screen.findByTestId("day-period-morning");

      expect(countInteractiveControls(document.body)).toBe(8);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("census fires on change: editing a time does not add or remove controls", async () => {
    mockDayPeriodsBackend();
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderDayPeriods();
      await screen.findByTestId("day-period-morning");

      fireEvent.change(screen.getByTestId("day-periods-start-input-afternoon"), {
        target: { value: "11:30" },
      });

      expect(countInteractiveControls(document.body)).toBe(8);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("DELIBERATE NEGATIVE — forcing this surface's own Save button below the kiosk minimum makes the assertion fail, and reverting restores compliance", async () => {
    mockDayPeriodsBackend();
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = renderDayPeriods();
      const saveButton = await screen.findByTestId("day-periods-save-morning");

      // A real control from this surface, not a synthetic fixture.
      saveButton.style.height = "16px";
      saveButton.style.fontSize = "10px";

      let thrown: unknown;
      try {
        assertKioskDensityCompliant(container);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(DensityViolationError);
      const message = (thrown as DensityViolationError).message;
      expect(message).toMatch(/height 16px is below the kiosk minimum 48px/);
      expect(message).toMatch(/font-size 10px is below the kiosk minimum 18px/);

      // Revert — compliance returns.
      saveButton.style.height = "";
      saveButton.style.fontSize = "";
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });
});

describe("DailyMessagesManagement — kiosk density across every reachable state (SC-001, SC-002)", () => {
  it("renders the DELIBERATE zero-control census while the initial /api/members fetch is unresolved", async () => {
    let resolveMembers: (() => void) | undefined;
    const mockFetch = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url === "/api/settings") {
        return Promise.resolve(jsonResponse({ locale: { timezone: "UTC", language: "en" } }));
      }
      if (url === "/api/members") {
        return new Promise<Response>((resolve) => {
          resolveMembers = () => resolve(jsonResponse([makeMember()]));
        });
      }
      if (url.startsWith("/api/daily-messages")) {
        return Promise.resolve(jsonResponse([]));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", mockFetch);
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderDailyMessages();
      await screen.findByText("Loading…");

      expect(countInteractiveControls(document.body)).toBe(0);

      // "Loading…" is present on the VERY FIRST render (before `/api/settings` even resolves),
      // so it proves nothing about whether `/api/members` has actually been requested yet — wait
      // for that explicitly before resolving it, or this race intermittently resolves nothing.
      await waitFor(() => expect(resolveMembers).toBeDefined());
      resolveMembers?.();
      await screen.findByTestId("daily-messages-select-member");
    } finally {
      uninject();
    }
  });

  it("meets kiosk density with NO active members (still 0 — just the empty-state message)", async () => {
    mockDailyMessagesBackend({ members: () => jsonResponse([]) });
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderDailyMessages();
      await screen.findByTestId("daily-messages-no-members");

      expect(countInteractiveControls(document.body)).toBe(0);
    } finally {
      uninject();
    }
  });

  it("meets kiosk density with an active member and an empty 14-day editor (2 navigation buttons + 1 member pill + 14 textareas)", async () => {
    mockDailyMessagesBackend();
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderDailyMessages();
      expect(await screen.findAllByTestId(/^daily-messages-day-/)).toHaveLength(14);

      expect(countInteractiveControls(document.body)).toBe(17);
      expect(document.body.querySelector("select")).toBeNull();
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("meets kiosk density with two saved messages (17 base + 2 delete controls)", async () => {
    mockDailyMessagesBackend({
      list: () =>
        jsonResponse([
          makeMessage({ id: "msg-1", date: "2026-01-15" }),
          makeMessage({ id: "msg-2", date: "2026-01-16" }),
        ]),
    });
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderDailyMessages();
      await screen.findByTestId("daily-messages-delete-2026-01-15");
      await screen.findByTestId("daily-messages-delete-2026-01-16");

      expect(countInteractiveControls(document.body)).toBe(19);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("keeps the same compliant control census when a message textarea expands on focus", async () => {
    mockDailyMessagesBackend({
      list: () =>
        jsonResponse([
          makeMessage({ id: "msg-1", date: "2026-01-15" }),
          makeMessage({ id: "msg-2", date: "2026-01-16" }),
        ]),
    });
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderDailyMessages();
      const textarea = await screen.findByTestId("daily-messages-text-2026-01-15");

      fireEvent.focus(textarea);

      expect(textarea).toHaveAttribute("rows", "3");
      expect(countInteractiveControls(document.body)).toBe(19);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("meets kiosk density with the delete-confirmation ConfirmDialog open outside the surface", async () => {
    mockDailyMessagesBackend({
      list: () =>
        jsonResponse([
          makeMessage({ id: "msg-1", date: "2026-01-15" }),
          makeMessage({ id: "msg-2", date: "2026-01-16" }),
        ]),
    });
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = renderDailyMessages();
      await screen.findByTestId("daily-messages-delete-2026-01-15");
      expect(countInteractiveControls(document.body)).toBe(19);

      fireEvent.click(screen.getByTestId("daily-messages-delete-2026-01-15"));
      await screen.findByTestId("daily-messages-delete-confirm");

      // Proves the dialog is NOT inside `container` (the rendering surface's own subtree) — the
      // exact "outside the page subtree" case FR-001/ exists to prove density reaches (Radix
      // portals `DialogContent` to `document.body`).
      expect(container.querySelector('[data-testid="daily-messages-delete-confirm"]')).toBeNull();

      // Radix hides two background controls while the two dialog actions are exposed.
      expect(countInteractiveControls(document.body)).toBe(19);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("CENSUS FIRES ON REMOVAL — deleting a message removes its delete control but preserves the date textarea", async () => {
    mockDailyMessagesBackend({
      list: () =>
        jsonResponse([
          makeMessage({ id: "msg-1", date: "2026-01-15" }),
          makeMessage({ id: "msg-2", date: "2026-01-16" }),
        ]),
    });
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderDailyMessages();
      await screen.findByTestId("daily-messages-delete-2026-01-15");
      expect(countInteractiveControls(document.body)).toBe(19);

      fireEvent.click(screen.getByTestId("daily-messages-delete-2026-01-15"));
      await screen.findByTestId("daily-messages-delete-confirm");
      fireEvent.click(screen.getByTestId("daily-messages-delete-confirm"));

      await waitFor(() =>
        expect(screen.queryByTestId("daily-messages-delete-2026-01-15")).not.toBeInTheDocument()
      );

      expect(screen.getByTestId("daily-messages-text-2026-01-15")).toHaveValue("");
      expect(countInteractiveControls(document.body)).toBe(18);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("DELIBERATE NEGATIVE — forcing a date textarea below the kiosk minimum makes the assertion fail, and reverting restores compliance", async () => {
    mockDailyMessagesBackend();
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = renderDailyMessages();
      const textarea = await screen.findByTestId("daily-messages-text-2026-01-15");

      textarea.style.height = "20px";
      textarea.style.fontSize = "11px";

      let thrown: unknown;
      try {
        assertKioskDensityCompliant(container);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(DensityViolationError);
      const message = (thrown as DensityViolationError).message;
      expect(message).toMatch(/height 20px is below the kiosk minimum 48px/);
      expect(message).toMatch(/font-size 11px is below the kiosk minimum 18px/);

      textarea.style.height = "";
      textarea.style.fontSize = "";
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });
});

/** Every `ErrorNotice` identity assertion below checks BOTH the live-region behaviour (role +
 * aria-live, already required by SC-011) AND the component's own token class
 * (`text-destructive`) — a hand-rolled `<p role="alert" className="text-red-600">` would satisfy
 * the behaviour half alone; the class assertion is what proves the SHARED component was actually
 * used, not a lookalike (verification policy, "ErrorNotice identity (token classes), not just
 * behaviour"). */
function expectErrorNoticeIdentity(alert: HTMLElement, expectedAriaLive: "assertive" | "polite") {
  expect(alert).toHaveAttribute("role", "alert");
  expect(alert).toHaveAttribute("aria-live", expectedAriaLive);
  expect(alert).toHaveClass("text-destructive");
}

describe("DayPeriodsManagement — every error state is announced through ErrorNotice, with its own identity (SC-011)", () => {
  it("a load failure", async () => {
    mockDayPeriodsBackend({ list: () => new Response(null, { status: 500 }) });
    renderDayPeriods();

    const alert = await screen.findByTestId("day-periods-error");
    expect(alert).toHaveTextContent("Failed to load day periods.");
    expectErrorNoticeIdentity(alert, "assertive");
  });

  it("a save-ordering validation error (client-side, no round-trip)", async () => {
    mockDayPeriodsBackend();
    renderDayPeriods();
    await screen.findByTestId("day-period-morning");

    const timeInput = await screen.findByTestId("day-periods-start-input-afternoon");
    fireEvent.change(timeInput, { target: { value: "04:00" } }); // before morning's 05:00
    fireEvent.click(screen.getByTestId("day-periods-save-afternoon"));

    const alert = await screen.findByTestId("day-periods-error");
    expect(alert).toHaveTextContent("must start after");
    expectErrorNoticeIdentity(alert, "assertive");
  });

  it("a save API failure", async () => {
    mockDayPeriodsBackend({ patch: () => new Response(null, { status: 500 }) });
    renderDayPeriods();
    await screen.findByTestId("day-period-morning");

    const timeInput = await screen.findByTestId("day-periods-start-input-morning");
    fireEvent.change(timeInput, { target: { value: "06:00" } });
    fireEvent.click(screen.getByTestId("day-periods-save-morning"));

    const alert = await screen.findByTestId("day-periods-error");
    expect(alert).toHaveTextContent("Couldn't save the change. Please try again.");
    expectErrorNoticeIdentity(alert, "assertive");
  });
});

describe("DailyMessagesManagement — every error state is announced through ErrorNotice, with its own identity (SC-011)", () => {
  it("a members load failure", async () => {
    mockDailyMessagesBackend({ members: () => new Response(null, { status: 500 }) });
    renderDailyMessages();

    const alert = await screen.findByTestId("daily-messages-error");
    expect(alert).toHaveTextContent("Failed to load daily messages.");
    expectErrorNoticeIdentity(alert, "assertive");
  });

  it("a create/save failure", async () => {
    mockDailyMessagesBackend({ put: () => new Response(null, { status: 500 }) });
    renderDailyMessages();
    const textarea = await screen.findByTestId("daily-messages-text-2026-01-15");

    fireEvent.change(textarea, { target: { value: "Hello there" } });
    fireEvent.blur(textarea);

    const alert = await screen.findByTestId("daily-messages-error");
    expect(alert).toHaveTextContent("Failed to save the message.");
    expectErrorNoticeIdentity(alert, "assertive");
  });

  it("a delete failure (AFTER confirming)", async () => {
    mockDailyMessagesBackend({
      list: () => jsonResponse([makeMessage({ id: "msg-1", date: "2026-01-15" })]),
      del: () => new Response(null, { status: 500 }),
    });
    renderDailyMessages();
    await screen.findByTestId("daily-messages-delete-2026-01-15");

    fireEvent.click(screen.getByTestId("daily-messages-delete-2026-01-15"));
    await screen.findByTestId("daily-messages-delete-confirm");
    fireEvent.click(screen.getByTestId("daily-messages-delete-confirm"));

    const alert = await screen.findByTestId("daily-messages-error");
    expect(alert).toHaveTextContent("Failed to delete the message.");
    expectErrorNoticeIdentity(alert, "assertive");
  });
});

describe("DailyMessagesManagement — ConfirmDialog guards delete: no fetch until confirmed, cancel leaves it undone (per-batch DoD falsifier)", () => {
  it("does NOT fire the DELETE fetch merely by clicking Delete — only Confirm does", async () => {
    const mockFetch = mockDailyMessagesBackend({
      list: () => jsonResponse([makeMessage({ id: "msg-1", date: "2026-01-15" })]),
    });
    renderDailyMessages();
    await screen.findByTestId("daily-messages-delete-2026-01-15");

    fireEvent.click(screen.getByTestId("daily-messages-delete-2026-01-15"));
    await screen.findByTestId("daily-messages-delete-confirm");

    // The saved message control is still present and NO DELETE request was ever sent — a call site that
    // dropped the dialog and fired immediately would fail this.
    expect(screen.getByTestId("daily-messages-delete-2026-01-15")).toBeInTheDocument();
    expect(
      mockFetch.mock.calls.some(
        ([, init]) => (init as Parameters<typeof fetch>[1])?.method === "DELETE"
      )
    ).toBe(false);

    fireEvent.click(screen.getByTestId("daily-messages-delete-confirm"));
    await waitFor(() =>
      expect(screen.queryByTestId("daily-messages-delete-2026-01-15")).not.toBeInTheDocument()
    );
    expect(screen.getByTestId("daily-messages-text-2026-01-15")).toHaveValue("");
    expect(
      mockFetch.mock.calls.some(
        ([, init]) => (init as Parameters<typeof fetch>[1])?.method === "DELETE"
      )
    ).toBe(true);
  });

  it("CANCELLING the dialog leaves the message undone — no fetch, row still present, dialog closes", async () => {
    const mockFetch = mockDailyMessagesBackend({
      list: () => jsonResponse([makeMessage({ id: "msg-1", date: "2026-01-15" })]),
    });
    renderDailyMessages();
    await screen.findByTestId("daily-messages-delete-2026-01-15");

    fireEvent.click(screen.getByTestId("daily-messages-delete-2026-01-15"));
    await screen.findByTestId("daily-messages-delete-confirm");

    fireEvent.click(screen.getByTestId("daily-messages-delete-cancel"));
    await waitFor(() =>
      expect(screen.queryByTestId("daily-messages-delete-confirm")).not.toBeInTheDocument()
    );

    expect(screen.getByTestId("daily-messages-delete-2026-01-15")).toBeInTheDocument();
    expect(screen.getByTestId("daily-messages-text-2026-01-15")).toHaveValue("Have a great day!");
    expect(
      mockFetch.mock.calls.some(
        ([, init]) => (init as Parameters<typeof fetch>[1])?.method === "DELETE"
      )
    ).toBe(false);
  });
});

// Independent review lesson carried from (ChoresBoard, DAY_PERIOD_LABEL_KEYS) and
// (MealsManagement): assert EVERY map an `as MessageKey` -> typed-map refactor creates, ITERATING
// the map rather than hand-writing the expectations — a hand-written list carries the same
// transcription problem it is meant to solve.
describe("DayPeriodsManagement — DAY_PERIOD_LABEL_KEYS maps each day period to its OWN translation key (SC-007)", () => {
  it("ITERATES all four mechanically-derivable keys against the `dayPeriod.${id}` template", () => {
    for (const id of Object.keys(DAY_PERIOD_LABEL_KEYS) as PeriodId[]) {
      expect(DAY_PERIOD_LABEL_KEYS[id]).toBe(`dayPeriod.${id}`);
    }
  });

  it("every key resolves in BOTH locale catalogues", () => {
    for (const id of Object.keys(DAY_PERIOD_LABEL_KEYS) as PeriodId[]) {
      const key = DAY_PERIOD_LABEL_KEYS[id];
      expect(messages.en[key]).toBeTruthy();
      expect(messages.es[key]).toBeTruthy();
    }
  });

  it("renders every one of the four periods' OWN localized label, under a non-English household locale — order-and-content, not a set comparison (a swap would preserve the SET while breaking which period gets which label)", async () => {
    mockDayPeriodsBackend({ language: "es" });
    renderDayPeriods();

    await screen.findByTestId("day-period-morning");
    // Anchor on the LOCALIZED text before the per-row assertions: the panel can mount with the
    // default (English) locale before the /api/settings fetch resolves and "es" applies — the
    // same await-the-state-you-assert lesson as the loading-skeleton anchor.
    await screen.findByText("Mañana");
    expect(screen.getByTestId("day-period-morning")).toHaveTextContent("Mañana");
    expect(screen.getByTestId("day-period-afternoon")).toHaveTextContent("Mediodía");
    expect(screen.getByTestId("day-period-evening")).toHaveTextContent("Tarde");
    expect(screen.getByTestId("day-period-night")).toHaveTextContent("Noche");
  });
});
