/** CalendarView spec (FR-013/FR-009, SC-001/SC-002/SC-011/SC-012).
 * This is the executable evidence for the verification policy (verification policy): it CALLS
 * the frozen density assertion over this surface's rendered control set with kiosk density
 * active (not merely imports it), records a deliberate negative proving the assertion can fail
 * on THIS surface's own controls, asserts every error state the surface renders is announced
 * through the shared `ErrorNotice` live region (SC-011), and proves the assignment row — the
 * product's one known keyboard-unreachable control (FR-013) — is now a real, keyboard-operable,
 * accessibly-named control (SC-012).
 * Functional/wiring regressions already have dedicated coverage in the sibling
 * `calendar-window.test.tsx` (28-day window bounding, DST, timezone) and
 * `calendar-members-error-retry.test.tsx` (members-error retry) — this file does not repeat that
 * surface area; it only proves the migration-specific guarantees exists to prove.
 * * Deliberate scope decision, recorded per the style guide's "encountering a fork" convention* * unlike (MealsManagement), the delete confirmation here stays an INLINE panel rather than
 * adopting the portalled `ConfirmDialog` L2 component. `tests/e2e/calendar.spec.ts` scopes
 * `calendar-delete-confirm-btn` to the SAME testid'd row as `calendar-delete-btn`
 * (`rowOf(editedTitle).getByTestId("calendar-delete-confirm-btn")`) — a Radix `Dialog` portals to
 * `document.body`, OUTSIDE that row, which would silently break that existing e2e's scoping (the
 * exact "no behaviour change" this module's DoD forbids). `ConfirmDialog` remains the right
 * component for a NEW surface; an already-testid-scoped inline panel is left as-is here rather
 * than risking a live e2e regression for a purely cosmetic swap.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CalendarView } from "@/calendar/CalendarView";
import { LanguageProvider } from "@/i18n";
import { DensityViolationError, assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

const adminUnlock = vi.hoisted(() => ({ unlocked: true }));

vi.mock("@/lib/adminUnlock", () => ({
  useAdminUnlock: () => ({ unlocked: adminUnlock.unlocked, setUnlocked: vi.fn() }),
}));

type FetchCall = Parameters<typeof globalThis.fetch>;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const NOW = Date.now();
const TOMORROW = ymd(new Date(NOW + 24 * 60 * 60 * 1000));
const DAY_AFTER = ymd(new Date(NOW + 2 * 24 * 60 * 60 * 1000));

const EVENT = {
  id: "evt-1",
  title: "Team Meeting",
  allDay: true,
  occurrenceStart: TOMORROW,
  occurrenceEnd: DAY_AFTER,
  source: "local" as const,
  assignedTo: [] as string[],
};

const MEMBERS = [
  { id: "m1", displayName: "Alice", lifecycle: "active", colorKey: "blue" },
  { id: "m2", displayName: "Bob", lifecycle: "archived", colorKey: "violet" },
];

function json(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status });
}

/** A fully-loaded, happy-path mock backend — one event, two members. `overrides` lets a single
 * test redirect one endpoint to a failure without re-declaring the rest. */
function mockBackend(overrides: Partial<Record<string, () => Response>> = {}) {
  const mockFetch = vi.fn((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (overrides.events && url.includes("/api/calendar/events") && method === "GET") {
      return Promise.resolve(overrides.events());
    }
    if (url.includes("/api/calendar/events") && /\/assignments$/.test(url) === false) {
      if (method === "GET") return Promise.resolve(json([EVENT]));
    }
    if (overrides.assignments && /\/assignments$/.test(url) && method === "PUT") {
      return Promise.resolve(overrides.assignments());
    }
    if (/\/assignments$/.test(url) && method === "PUT") {
      return Promise.resolve(json(null, 200));
    }
    if (overrides.editEvent && /\/api\/calendar\/events\/[^/]+$/.test(url) && method === "PATCH") {
      return Promise.resolve(overrides.editEvent());
    }
    if (/\/api\/calendar\/events\/[^/]+$/.test(url) && method === "PATCH") {
      return Promise.resolve(json(null, 200));
    }
    if (
      overrides.deleteEvent &&
      /\/api\/calendar\/events\/[^/]+$/.test(url) &&
      method === "DELETE"
    ) {
      return Promise.resolve(overrides.deleteEvent());
    }
    if (/\/api\/calendar\/events\/[^/]+$/.test(url) && method === "DELETE") {
      return Promise.resolve(json(null, 200));
    }
    if (overrides.createEvent && url.endsWith("/api/calendar/events") && method === "POST") {
      return Promise.resolve(overrides.createEvent());
    }
    if (url.endsWith("/api/calendar/events") && method === "POST") {
      return Promise.resolve(json(null, 201));
    }
    if (overrides.members && url.includes("/api/members") && method === "GET") {
      return Promise.resolve(overrides.members());
    }
    if (url.includes("/api/members") && method === "GET") {
      return Promise.resolve(json(MEMBERS));
    }

    throw new Error(`unexpected fetch: ${url} (${method})`);
  });

  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

function renderSurface() {
  return render(
    <LanguageProvider>
      <CalendarView />
    </LanguageProvider>
  );
}

async function activateFirstEvent(): Promise<void> {
  fireEvent.click(await screen.findByTestId("calendar-event-row"));
  await screen.findByTestId("calendar-event-detail");
}

/** Census helper (mirrors `density.ts`'s own `INTERACTIVE_CONTROL_SELECTOR` + `isRenderable`
 * filter, duplicated here rather than imported — the frozen helper deliberately exposes no census
 * API; see `meals-management.test.tsx`'s own copy of this helper for the full rationale). This is
 * NOT a weakening of the frozen file: it adds nothing to what `assertKioskDensityCompliant`
 * checks, it only lets THIS spec assert an exact control count at each phase.
 */
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
  adminUnlock.unlocked = true;
  vi.unstubAllGlobals();
  cleanup();
  document.documentElement.removeAttribute("data-density");
});

describe("CalendarView — provisioned Calendar authoring", () => {
  it("shows ephemeral filters for active members only with the approved defaults", async () => {
    mockBackend();
    renderSurface();

    expect(await screen.findByRole("checkbox", { name: "All-day events" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Alice" })).not.toBeChecked();
    expect(screen.queryByRole("checkbox", { name: "Bob" })).not.toBeInTheDocument();
  });

  it("restores ephemeral filter defaults after the component remounts", async () => {
    mockBackend();
    const first = renderSurface();

    const allDay = await screen.findByRole("checkbox", { name: "All-day events" });
    const alice = screen.getByRole("checkbox", { name: "Alice" });
    fireEvent.click(allDay);
    fireEvent.click(alice);
    expect(allDay).not.toBeChecked();
    expect(alice).toBeChecked();

    first.unmount();
    renderSurface();

    expect(await screen.findByRole("checkbox", { name: "All-day events" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Alice" })).not.toBeChecked();
  });

  it("applies member and all-day filters to the shared visible collection", async () => {
    mockBackend({
      events: () =>
        json([
          { ...EVENT, id: "all-day-a", title: "All-day A", assignedTo: ["m1"] },
          { ...EVENT, id: "all-day-unassigned", title: "All-day unassigned" },
          {
            ...EVENT,
            id: "timed-b",
            title: "Timed B",
            allDay: false,
            occurrenceStart: `${TOMORROW}T10:00:00.000Z`,
            occurrenceEnd: `${TOMORROW}T11:00:00.000Z`,
            assignedTo: ["m2"],
          },
          {
            ...EVENT,
            id: "timed-unassigned",
            title: "Timed unassigned",
            allDay: false,
            occurrenceStart: `${TOMORROW}T12:00:00.000Z`,
            occurrenceEnd: `${TOMORROW}T13:00:00.000Z`,
          },
        ]),
      members: () => json(MEMBERS.map((member) => ({ ...member, lifecycle: "active" as const }))),
    });
    renderSurface();

    const alice = await screen.findByRole("checkbox", { name: "Alice" });
    fireEvent.click(alice);
    expect(screen.getByText("All-day A")).toBeInTheDocument();
    expect(screen.queryByText("Timed B")).not.toBeInTheDocument();
    expect(screen.getByText("All-day unassigned")).toBeInTheDocument();
    expect(screen.getByText("Timed unassigned")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "All-day events" }));
    expect(screen.queryByText("All-day A")).not.toBeInTheDocument();
    expect(screen.queryByText("All-day unassigned")).not.toBeInTheDocument();
    expect(screen.getByText("Timed unassigned")).toBeInTheDocument();
  });

  it("switches between month and week presentations", async () => {
    mockBackend();
    renderSurface();

    expect(await screen.findByTestId("calendar-month-grid")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Week" }));
    expect(await screen.findByTestId("calendar-week-grid")).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-month-grid")).not.toBeInTheDocument();
  });

  it("opens the existing mutation controls from event activation", async () => {
    mockBackend();
    renderSurface();

    const event = await screen.findByTestId("calendar-event-row");
    expect(screen.queryByTestId("calendar-edit-btn")).not.toBeInTheDocument();
    fireEvent.click(event);
    expect(await screen.findByTestId("calendar-edit-btn")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-delete-btn")).toBeInTheDocument();
  });

  it("keeps external events readable but exposes no local mutation controls", async () => {
    mockBackend({ events: () => json([{ ...EVENT, source: "external" as const }]) });
    renderSurface();

    fireEvent.click(await screen.findByTestId("calendar-event-row"));
    expect(await screen.findByText("External event — read only")).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-edit-btn")).not.toBeInTheDocument();
    expect(screen.queryByTestId("calendar-delete-btn")).not.toBeInTheDocument();
  });

  it("bounds period navigation without issuing another Calendar request", async () => {
    const mockFetch = mockBackend();
    renderSurface();

    await screen.findByTestId("calendar-month-grid");
    const previous = screen.getByRole("button", { name: "Previous period" });
    expect(previous).toBeDisabled();

    const next = screen.getByRole("button", { name: "Next period" });
    for (let guard = 0; guard < 14 && !next.hasAttribute("disabled"); guard += 1) {
      fireEvent.click(next);
    }
    expect(next).toBeDisabled();

    const calendarReads = (mockFetch.mock.calls as FetchCall[]).filter(
      ([input, init]) => String(input).includes("/api/calendar/events") && !init?.method
    );
    expect(calendarReads).toHaveLength(1);
  });

  it("renders assigned member colours as diagonal event bands", async () => {
    mockBackend({
      events: () => json([{ ...EVENT, assignedTo: ["m1", "m2"] }]),
      members: () => json(MEMBERS.map((member) => ({ ...member, lifecycle: "active" as const }))),
    });
    renderSurface();

    const row = await screen.findByTestId("calendar-event-row");
    expect(row).toHaveClass("member-event-surface");
    const background = row.style.getPropertyValue("--member-event-background");
    expect(background).toContain("repeating-linear-gradient(135deg");
    expect(background).toContain("--color-member-blue-500");
    expect(background).toContain("--color-member-violet-500");
  });

  it("keeps create, assign, edit, and delete plus their member load available when the obsolete admin-unlock branch is false", async () => {
    // Mutation caught: restoring `unlocked &&` around Calendar authoring, or returning early from
    // the members effect when `unlocked` is false, hides ordinary /calendar operations.
    adminUnlock.unlocked = false;
    mockBackend();
    renderSurface();

    await screen.findByTestId("calendar-create-btn");
    const row = await screen.findByTestId("calendar-event-row");
    expect(row).toBeInTheDocument();
    fireEvent.click(row);
    expect(screen.getByTestId("calendar-edit-btn")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-delete-btn")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("calendar-edit-btn"));
    await screen.findByTestId(`calendar-assign-member-${MEMBERS[0].id}`);
  });
});

describe("CalendarView — kiosk density (SC-001, SC-002, FR-009)", () => {
  it("meets kiosk density across every rendered control — default state, then create form + edit panel + delete confirm all open, across two phases", async () => {
    mockBackend();
    // CheckboxField renders a `size-[var(--control-height)]` utility — outside the density
    // helper's base candidate list (`densityStyles.ts` header), same as
    // `checkbox-field.test.tsx`'s /`meals-management.test.tsx`'s own extraCandidates.
    const uninject = await injectDensityStyles({
      extraCandidates: ["size-[var(--control-height)]"],
    });
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderSurface();

      await screen.findByTestId("calendar-event-row");

      // Phase 1 — the surface's default, fully-collapsed state: the create-event toggle button
      // plus each row's assign/edit/delete toggle buttons (one event row here).
      expect(countInteractiveControls(document.body)).toBe(9);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // Phase 2 — expand every expandable panel at once (none of them are mutually exclusive —
      // `showCreate`/`showEdit`/`showDeleteConfirm` are independent state): the create form's own
      // fields, the edit panel's fields with its member toggles, and the delete-confirm panel's
      // buttons.
      //
      // NOT reached, and not claimed to be (finding — a prior version of
      // this comment overclaimed "every control this surface can render is reachable in a single
      // measured state", which is false): the TIMED branches of both the create and edit forms —
      // four `<Input type="datetime-local">` fields, two per form — because `fAllDay` defaults
      // `true` and `EVENT` above is itself `allDay: true`, so both forms only ever render their
      // ALL-DAY branch (a single `<Input type="date">`) in this test. Reaching the create form's
      // timed branch would need toggling its own "all day" `CheckboxField` off; reaching the edit
      // form's would additionally need a second, timed `EVENT` fixture (the branch is driven by the
      // loaded event's own `allDay`, not user-toggleable in edit mode) — deliberately left
      // uncovered here rather than growing this fixture, since the timed `<Input
      // type="datetime-local">` is density-identical to the already-covered `<Input type="date">`
      // (same shared `components/ui/input.tsx`, same size classes): a census count is necessary,
      // not sufficient, and this is the one gap that overclaiming comment would otherwise hide.
      fireEvent.click(screen.getByTestId("calendar-create-btn"));
      await screen.findByTestId("calendar-create-title-input");

      await activateFirstEvent();

      fireEvent.click(screen.getByTestId("calendar-edit-btn"));
      await screen.findByTestId("calendar-edit-title-input");
      await screen.findByTestId(`calendar-assign-member-${MEMBERS[0].id}`);

      fireEvent.click(screen.getByTestId("calendar-delete-btn"));
      await screen.findByTestId("calendar-delete-confirm-btn");

      expect(countInteractiveControls(document.body)).toBeGreaterThan(15);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("DELIBERATE NEGATIVE — forcing one of this surface's own controls below the kiosk minimum makes the assertion fail", async () => {
    mockBackend();
    const uninject = await injectDensityStyles({
      extraCandidates: ["size-[var(--control-height)]"],
    });
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = renderSurface();
      await screen.findByTestId("calendar-event-row");

      // A real control from this surface, not a synthetic fixture — the create-event button.
      const createBtn = screen.getByTestId("calendar-create-btn");
      createBtn.style.height = "10px";
      createBtn.style.fontSize = "8px";

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

describe("CalendarView — error states are announced (SC-011)", () => {
  it.each(["create", "edit"] as const)(
    "announces invalid date conversion during %s and releases the submit button",
    async (action) => {
      mockBackend();
      renderSurface();
      await screen.findByTestId("calendar-event-row");
      if (action === "edit") {
        await activateFirstEvent();
        fireEvent.click(screen.getByTestId("calendar-edit-btn"));
      } else {
        fireEvent.click(screen.getByTestId("calendar-create-btn"));
      }
      fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "" } });
      const submit = await screen.findByTestId(
        action === "edit" ? "calendar-edit-save-btn" : "calendar-create-submit"
      );
      fireEvent.submit(submit.closest("form")!);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        action === "edit" ? "Failed to save changes." : "Failed to load calendar events."
      );
      expect(submit).toBeEnabled();
    }
  );

  it("announces the events-load failure", async () => {
    mockBackend({ events: () => json(null, 500) });
    renderSurface();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load calendar events.");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  it("announces the members-load failure once the edit form is opened", async () => {
    mockBackend({ members: () => json(null, 500) });
    renderSurface();

    await screen.findByTestId("calendar-event-row");
    await activateFirstEvent();
    fireEvent.click(screen.getByTestId("calendar-edit-btn"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load members.");
  });

  it("announces an assignment-update failure", async () => {
    mockBackend({ assignments: () => json(null, 500) });
    renderSurface();

    await screen.findByTestId("calendar-event-row");
    await activateFirstEvent();
    fireEvent.click(screen.getByTestId("calendar-edit-btn"));
    fireEvent.click(await screen.findByTestId(`calendar-assign-member-${MEMBERS[0].id}`));
    fireEvent.click(screen.getByTestId("calendar-edit-save-btn"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to update assignment.");
  });

  it("announces an edit-save failure", async () => {
    mockBackend({ editEvent: () => json(null, 500) });
    renderSurface();

    await screen.findByTestId("calendar-event-row");
    await activateFirstEvent();
    fireEvent.click(screen.getByTestId("calendar-edit-btn"));
    fireEvent.click(await screen.findByTestId("calendar-edit-save-btn"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to save changes.");
  });

  it("announces a delete failure", async () => {
    mockBackend({ deleteEvent: () => json(null, 500) });
    renderSurface();

    await screen.findByTestId("calendar-event-row");
    await activateFirstEvent();
    fireEvent.click(screen.getByTestId("calendar-delete-btn"));
    fireEvent.click(await screen.findByTestId("calendar-delete-confirm-btn"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to delete event.");
  });

  it("announces a create failure", async () => {
    mockBackend({ createEvent: () => json(null, 500) });
    renderSurface();

    await screen.findByTestId("calendar-event-row");
    fireEvent.click(screen.getByTestId("calendar-create-btn"));
    fireEvent.change(screen.getByTestId("calendar-create-title-input"), {
      target: { value: "New Event" },
    });
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: TOMORROW } });
    fireEvent.click(screen.getByTestId("calendar-create-submit"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load calendar events.");
  });
});

describe("CalendarView — New Event dialog", () => {
  function sentBody(mockFetch: ReturnType<typeof mockBackend>, method: string, suffix: RegExp) {
    const call = (mockFetch.mock.calls as FetchCall[]).find(
      ([input, init]) => init?.method === method && suffix.test(String(input))
    );
    return call ? (JSON.parse(String(call[1]?.body)) as unknown) : undefined;
  }

  it("stores the inclusive end date of an all-day event as the exclusive day after", async () => {
    const mockFetch = mockBackend({ createEvent: () => json({ id: "new-1" }, 201) });
    renderSurface();

    await screen.findByTestId("calendar-event-row");
    fireEvent.click(screen.getByTestId("calendar-create-btn"));
    fireEvent.change(screen.getByTestId("calendar-create-title-input"), {
      target: { value: "Camping" },
    });
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-07-10" } });
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-07-12" } });
    fireEvent.change(screen.getByLabelText("Location"), { target: { value: "Lake cabin" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Bring boots" } });
    fireEvent.click(screen.getByTestId("calendar-create-submit"));

    await waitFor(() =>
      expect(sentBody(mockFetch, "POST", /\/api\/calendar\/events$/)).toEqual({
        title: "Camping",
        allDay: true,
        startDate: "2026-07-10",
        endDate: "2026-07-13",
        location: "Lake cabin",
        description: "Bring boots",
      })
    );
  });

  it("assigns the people picked in the dialog to the event it just created", async () => {
    const mockFetch = mockBackend({ createEvent: () => json({ id: "new-2" }, 201) });
    renderSurface();

    await screen.findByTestId("calendar-event-row");
    fireEvent.click(screen.getByTestId("calendar-create-btn"));
    const dialog = within(await screen.findByRole("dialog", { name: "New Event" }));
    fireEvent.change(screen.getByTestId("calendar-create-title-input"), {
      target: { value: "Swimming" },
    });
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: TOMORROW } });
    fireEvent.click(dialog.getByRole("checkbox", { name: "Alice" }));
    fireEvent.click(screen.getByTestId("calendar-create-submit"));

    await waitFor(() =>
      expect(sentBody(mockFetch, "PUT", /\/events\/new-2\/assignments$/)).toEqual({
        memberIds: [MEMBERS[0].id],
      })
    );
  });
});

describe("CalendarView — event detail dialog", () => {
  it("shows a highlight emoji on the chip and in the dialog, but edits the stored title", async () => {
    mockBackend({
      events: () => json([{ ...EVENT, title: "Football", decoratedTitle: "⚽ Football" }]),
    });
    renderSurface();

    const chip = await screen.findByTestId("calendar-event-row");
    expect(chip).toHaveTextContent("⚽ Football");
    fireEvent.click(chip);
    expect(await screen.findByRole("dialog", { name: "⚽ Football" })).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("calendar-edit-btn"));
    expect(await screen.findByTestId("calendar-edit-title-input")).toHaveValue("Football");
  });

  it("shows an imported event's place and description, read only", async () => {
    mockBackend({
      events: () =>
        json([
          {
            ...EVENT,
            id: "external-1",
            source: "external",
            title: "Parents evening",
            location: "School hall",
            description: "Room 4\nBring the report",
          },
        ]),
    });
    renderSurface();

    fireEvent.click(await screen.findByTestId("calendar-event-row"));
    const dialog = within(await screen.findByRole("dialog", { name: "Parents evening" }));
    expect(dialog.getByText("School hall")).toBeInTheDocument();
    expect(dialog.getByText(/Room 4\s+Bring the report/)).toBeInTheDocument();
    expect(dialog.queryByTestId("calendar-edit-btn")).not.toBeInTheDocument();
  });
});

describe("CalendarView — editing a local event", () => {
  it("turns an all-day event into a timed one, carrying its day across", async () => {
    const mockFetch = mockBackend();
    renderSurface();

    await activateFirstEvent();
    fireEvent.click(screen.getByTestId("calendar-edit-btn"));
    fireEvent.click(await screen.findByRole("checkbox", { name: "All-day event" }));
    expect(screen.getByLabelText("Start time")).toHaveValue(`${TOMORROW}T09:00`);
    expect(screen.getByLabelText("End time")).toHaveValue(`${TOMORROW}T10:00`);
    fireEvent.click(screen.getByTestId("calendar-edit-save-btn"));

    await waitFor(() => {
      const patch = (mockFetch.mock.calls as FetchCall[]).find(
        ([, init]) => init?.method === "PATCH"
      );
      expect(patch).toBeDefined();
      const body = JSON.parse(String(patch?.[1]?.body)) as Record<string, unknown>;
      expect(body).toEqual({
        allDay: false,
        startUtc: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/) as string,
        endUtc: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/) as string,
        tzid: expect.any(String) as string,
      });
    });
  });

  it("closes the dialog after a successful save and reopens on the summary", async () => {
    mockBackend();
    renderSurface();

    await activateFirstEvent();
    const people = within(screen.getByTestId("calendar-event-detail"));
    fireEvent.click(screen.getByTestId("calendar-edit-btn"));
    fireEvent.change(await screen.findByTestId("calendar-edit-title-input"), {
      target: { value: "Renamed" },
    });
    // While the form shows the people, the summary's own list of them is gone.
    expect(people.queryByRole("list", { name: "Who is it for" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("calendar-edit-save-btn"));

    await waitFor(() =>
      expect(screen.queryByTestId("calendar-event-detail")).not.toBeInTheDocument()
    );
    await activateFirstEvent();
    expect(screen.getByTestId("calendar-edit-btn")).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-edit-title-input")).not.toBeInTheDocument();
  });

  it("shows a same-day timed event as one date with start and end times and no time zone", async () => {
    mockBackend({
      events: () =>
        json([
          {
            ...EVENT,
            allDay: false,
            occurrenceStart: `${TOMORROW}T10:00:00.000Z`,
            occurrenceEnd: `${TOMORROW}T10:20:00.000Z`,
            tzid: "UTC",
          },
        ]),
    });
    renderSurface();

    await activateFirstEvent();
    const when = within(screen.getByTestId("calendar-event-detail")).getByText(/—/);
    expect(when.textContent).toMatch(/^\S+ \d{1,2} \S+ \d{2}:\d{2} — \d{2}:\d{2}$/);
  });
});

describe("CalendarView — adopts the AdminPanel L2 frame", () => {
  it("wraps the surface in a landmark region labelled by its own title", async () => {
    mockBackend();
    renderSurface();

    // A bare `<div>` in place of `AdminPanel` passes every functional test in this file — this
    // is the only assertion that would catch it: the region role AND its accessible name both
    // come from `AdminPanel`'s `role="region"` + generated `aria-labelledby`, not from anything
    // this surface writes itself.
    expect(await screen.findByRole("region", { name: "Calendar" })).toBeInTheDocument();
  });

  it("renders an h1, not h2 — the page-level heading for the whole /calendar route (review, PR #777, finding F6)", async () => {
    mockBackend();
    renderSurface();

    // Real gap this guards: `AdminPanel` defaults to `<h2>`, which left `/calendar` with ZERO
    // `<h1>` elements on the page at all (verified via a real browser DOM dump — `HEADINGS =
    // ["H2:Calendario"]`) — a page-level surface, mounted exactly like
    // ChoresBoard/MealsBoard/DailyBriefingView (which each render their own `<h1>` directly), must
    // carry the SAME `headingLevel="h1"` override those three get for free.
    expect(await screen.findByRole("heading", { level: 1, name: "Calendar" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2 })).toHaveAttribute(
      "data-testid",
      "calendar-period-title"
    );
  });
});

describe("CalendarView — the assignment row is a real, keyboard-operable control (FR-013, SC-012)", () => {
  it("is reachable by Tab, activated by Space (via a native click), and its checked state is announced through an accessible name — not a non-focusable <li onClick> wrapping a readOnly checkbox", async () => {
    mockBackend();
    renderSurface();

    await screen.findByTestId("calendar-event-row");
    await activateFirstEvent();
    fireEvent.click(screen.getByTestId("calendar-edit-btn"));

    // A REAL native checkbox, not `readOnly` — the product's original known offender
    // (quickstart.md S9 row 1, `CalendarView.tsx:644`).
    const checkbox = await screen.findByTestId(`calendar-assign-member-${MEMBERS[0].id}`);
    expect(checkbox).not.toHaveAttribute("readonly");
    expect(checkbox).not.toBeChecked();

    // Reachable by Tab: a native `<input type="checkbox">` is focusable by default (no
    // `tabIndex={-1}`, not `disabled`) and is NOT wrapped in a non-semantic `<li onClick>` — the
    // census's OTHER offender (row 23, `CalendarView.tsx:628`). Proven directly: the parent `<li>`
    // carries no `onclick` property at all.
    const listItem = checkbox.closest("li");
    expect(listItem).not.toBeNull();
    expect((listItem as HTMLLIElement).onclick).toBeNull();

    checkbox.focus();
    expect(document.activeElement).toBe(checkbox);

    // Activated by Space: a browser translates Space, on a focused, native checkbox, into a
    // synthetic click — the same activation path `tools/dev/audit-accessible-names.mjs`'s own
    // header names as "how AT operates a control". `fireEvent.click` here reproduces exactly that
    // browser-level translation, not a mouse-only shortcut. (finding,
    // browser-verified: Enter does NOT toggle a bare native checkbox with no enclosing `<form>` —
    // only Space does. The claim above previously said "Enter/Space"; corrected here so it is not
    // copied forward.)
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();

    // Clicking the row's OWN container (not the checkbox/label) must NOT toggle anything — the old
    // `<li onClick={toggleMember}>` behaviour is gone, deliberately: an `<li>` with an `onClick`
    // handler and no `role` is not exposed to assistive tech as a control at all (worse than
    // unnamed — quickstart.md S9's row 23), so removing that handler is the fix, not a regression.
    // (this comment previously described an assertion that did
    // not exist — the next line clicked the checkbox again, not the container. Real,
    // browser-verified claim, now actually asserted below.)
    fireEvent.click(listItem as HTMLLIElement);
    expect(checkbox).toBeChecked(); // unchanged by the inert container click

    // Toggling once more via the real control proves the checkbox itself still owns activation.
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
  });

  it("meets kiosk density on the per-member checkbox row (the row that used to be a non-focusable <li>)", async () => {
    mockBackend();
    const uninject = await injectDensityStyles({
      extraCandidates: ["size-[var(--control-height)]"],
    });
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderSurface();
      await screen.findByTestId("calendar-event-row");
      await activateFirstEvent();
      fireEvent.click(screen.getByTestId("calendar-edit-btn"));
      await screen.findByTestId(`calendar-assign-member-${MEMBERS[0].id}`);

      const checkbox = screen.getByTestId(`calendar-assign-member-${MEMBERS[0].id}`);
      expect(() =>
        assertKioskDensityCompliant(checkbox.closest("li") as HTMLElement)
      ).not.toThrow();
    } finally {
      uninject();
    }
  });
});

describe("CalendarView — assignment save round-trips the selected members (regression guard for the CheckboxField migration)", () => {
  it("submits the toggled member id in the PUT payload", async () => {
    const mockFetch = mockBackend();
    renderSurface();

    await screen.findByTestId("calendar-event-row");
    await activateFirstEvent();
    fireEvent.click(screen.getByTestId("calendar-edit-btn"));
    const checkbox = await screen.findByTestId(`calendar-assign-member-${MEMBERS[0].id}`);
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByTestId("calendar-edit-save-btn"));

    await waitFor(() => {
      const putCalls = (mockFetch.mock.calls as FetchCall[]).filter(
        ([reqInput, init]) => /\/assignments$/.test(String(reqInput)) && init?.method === "PUT"
      );
      expect(putCalls).toHaveLength(1);
      const body = JSON.parse(String(putCalls[0][1]?.body));
      expect(body).toEqual({ memberIds: [MEMBERS[0].id] });
    });
  });

  it("makes the whole member pill the tap target ( review, PR #777, finding F5 — restoring the tap target the removed <li onClick> used to provide)", async () => {
    mockBackend();
    renderSurface();

    await screen.findByTestId("calendar-event-row");
    await activateFirstEvent();
    fireEvent.click(screen.getByTestId("calendar-edit-btn"));
    const checkbox = await screen.findByTestId(`calendar-assign-member-${MEMBERS[0].id}`);

    // Real gap this guards: removing the `<li>`'s `onClick` (the FR-013 fix) shrank the tappable
    // area from the whole row (~1198px measured in a real browser) to just the label's own content
    // width (~206px) — an ~83% reduction on a wall-mounted kiosk. `w-full` restores a full-row hit
    // area on the label itself (which already legitimately owns activation); `cursor-pointer`
    // restores the tap affordance the `<li>`'s removed `onClick` used to imply.
    const label = checkbox.closest("label");
    expect(label).not.toBeNull();
    // The member toggle is a pill, not a row: the native checkbox is stretched invisibly over the
    // whole pill, so every part of the pill that looks tappable is the control.
    expect(label?.className).toMatch(/\brelative\b/);
    expect(label?.className).toMatch(/\bcursor-pointer\b/);
    expect(checkbox.className).toMatch(/\babsolute\b/);
    expect(checkbox.className).toMatch(/\binset-0\b/);
  });

  it("excludes archived members from assignment choices", async () => {
    mockBackend();
    renderSurface();

    await screen.findByTestId("calendar-event-row");
    await activateFirstEvent();
    fireEvent.click(screen.getByTestId("calendar-edit-btn"));
    await screen.findByTestId(`calendar-assign-member-${MEMBERS[0].id}`);
    expect(screen.queryByTestId(`calendar-assign-member-${MEMBERS[1].id}`)).not.toBeInTheDocument();
  });
});
