/** MembersManagement spec (FR-009).
 * This is the executable evidence for the per-change DoD (the component acceptance criteria): it CALLS
 * the frozen density assertion over each surface's rendered control set with kiosk density
 * active (not merely imports it), records a deliberate negative proving the assertion can fail
 * on THIS surface's own controls, and asserts every error state either surface can render is
 * announced through the shared `ErrorNotice` live region (SC-011).
 * adds the closed member-colour identity control coverage: a server-owned automatic
 * sentinel plus sixteen literal localized colour labels, controlled edits, and no free-form input.
 * Functional CRUD/lifecycle coverage already exists at the e2e layer
 * (`tests/e2e/member-lifecycle.spec.ts`, `tests/e2e/critical-flow.spec.ts`) and the mount
 * regression already has its own unit spec (`tests/client/members-management-mount.test.tsx`) —
 * this file does not repeat that surface area; it preserves the migration-specific guarantees
 * and typed month/day lookup coverage while adding the curated member-colour guarantees.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MembersManagement } from "@/admin/MembersManagement";
import { HouseholdSettingsProvider } from "@/lib/householdSettings";
import { LanguageProvider } from "@/i18n";
import { Role } from "../../src/shared";
import { DensityViolationError, assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

type FetchCall = Parameters<typeof globalThis.fetch>;

vi.mock("@/lib/adminUnlock", () => ({
  useAdminUnlock: () => ({ unlocked: true, setUnlocked: vi.fn() }),
}));

// jsdom implements no scroll layout at all, so it never defines `Element.scrollIntoView` —
// Radix `Select`'s post-selection scroll-into-view effect (`@radix-ui/react-select`) calls it
// unconditionally, crashing (uncaught, unmounting the tree) the moment a real option is clicked.
// No other spec in this repo drives a Radix `Select` popover open in jsdom yet (every other
// migrated surface either keeps a native `<select>` — see `docs/development/style-guide.md`'s
// `NATIVE_SELECT_CLASSES` recipe — or doesn't need to open one in its own tests), so this is a
// file-local stub rather than a change to the shared `vitest.setup.ts`.
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? ((() => {}) as never);

function json(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status });
}

const MEMBER_JANUARY = {
  id: "m1",
  displayName: "Ari",
  colorKey: "blue" as const,
  role: Role.child,
  lifecycle: "active" as const,
  createdAt: 0,
  updatedAt: 0,
  birthDate: { month: 1, day: 1, year: 2015 },
};

const MEMBER_JUNE = {
  id: "m2",
  displayName: "Noor",
  colorKey: "sky" as const,
  role: Role.parent,
  lifecycle: "active" as const,
  createdAt: 0,
  updatedAt: 0,
  birthDate: { month: 6, day: 15, year: null },
};

const MEMBER_DECEMBER = {
  id: "m3",
  displayName: "Kai",
  colorKey: "teal" as const,
  role: Role.child,
  lifecycle: "active" as const,
  createdAt: 0,
  updatedAt: 0,
  birthDate: { month: 12, day: 31, year: 2018 },
};

/** The archived tab renders `Restore`, a control absent from the active tab.
 * Measure it while the archived tab is open. */
const MEMBER_ARCHIVED = {
  id: "m4",
  displayName: "Robin",
  colorKey: "green" as const,
  role: Role.child,
  lifecycle: "archived" as const,
  createdAt: 0,
  updatedAt: 0,
};

/** A fully-loaded, happy-path mock backend. `overrides` lets a single test redirect one
 * endpoint to a failure, or the members list, without re-declaring the rest — mirrors
 * `chores-board.test.tsx`'s own `mockBackend` shape. */
function mockBackend(
  overrides: Partial<{
    settings: () => Response;
    members: () => Response;
    archived: () => Response;
    patch: () => Response;
    archive: () => Response;
    restore: () => Response;
    create: () => Response;
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

    if (overrides.archived && url.startsWith("/api/members?lifecycle=archived")) {
      return Promise.resolve(overrides.archived());
    }
    if (url.startsWith("/api/members?lifecycle=archived")) {
      return Promise.resolve(json([]));
    }

    if (url === "/api/members" && method === "GET") {
      return Promise.resolve(
        overrides.members
          ? overrides.members()
          : json([MEMBER_JANUARY, MEMBER_JUNE, MEMBER_DECEMBER])
      );
    }
    if (url === "/api/members" && method === "POST") {
      return Promise.resolve(
        overrides.create ? overrides.create() : json({ ...MEMBER_JANUARY, id: "new" }, 201)
      );
    }

    if (/\/api\/members\/[^/]+$/.test(url) && method === "PATCH") {
      return Promise.resolve(
        overrides.patch ? overrides.patch() : json({ ...MEMBER_JANUARY, displayName: "Updated" })
      );
    }
    if (url.endsWith("/archive") && method === "POST") {
      return Promise.resolve(
        overrides.archive ? overrides.archive() : json({ ...MEMBER_JANUARY, lifecycle: "archived" })
      );
    }
    if (url.endsWith("/restore") && method === "POST") {
      return Promise.resolve(
        overrides.restore ? overrides.restore() : json({ ...MEMBER_JANUARY, lifecycle: "active" })
      );
    }

    throw new Error(`unexpected fetch: ${url} (${method})`);
  });

  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

function renderManagement() {
  return render(
    <HouseholdSettingsProvider>
      <LanguageProvider>
        <MembersManagement />
      </LanguageProvider>
    </HouseholdSettingsProvider>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  document.documentElement.removeAttribute("data-density");
});

describe("MembersManagement — v1-like member workspace", () => {
  it("renders semantic-colour cards and opens create and edit dialogs", async () => {
    mockBackend();
    renderManagement();

    const grid = await screen.findByTestId("members-card-grid");
    const cards = within(grid).getAllByTestId(/^member-card-/);
    expect(cards).toHaveLength(3);
    // The full name is the identity, drawn on the member's own colour.
    expect(within(within(grid).getByTestId("member-card-m1")).getByText("Ari")).toHaveStyle({
      "--member-color": "var(--color-member-blue-500)",
    });

    fireEvent.click(screen.getByTestId("members-add-member"));
    const createDialog = await screen.findByRole("dialog", { name: "Create Member" });
    expect(within(createDialog).getByLabelText("Display Name")).toBeInTheDocument();
    fireEvent.keyDown(createDialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    fireEvent.click(within(grid).getAllByTestId(/^member-card-/)[0]);
    const editDialog = await screen.findByRole("dialog", { name: "Edit Ari" });
    expect(within(editDialog).getByLabelText("Display Name")).toHaveValue("Ari");
    const palette = within(editDialog).getByTestId("member-edit-color-palette");
    expect(palette).toHaveClass("grid-cols-5");
    expect(within(palette).getAllByRole("radio")).toHaveLength(10);
    const radios = within(palette).getAllByRole("radio");
    expect(radios.filter((radio) => radio.tabIndex === 0)).toHaveLength(1);
    radios[0].focus();
    fireEvent.keyDown(radios[0], { key: "ArrowLeft" });
    expect(radios.at(-1)).toHaveFocus();
    expect(radios.at(-1)).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(radios.at(-1)!, { key: "Home" });
    expect(radios[0]).toHaveFocus();
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    // Sky and Teal belong to the other two active members: they cannot be picked, and the
    // arrow keys step over them to Green.
    expect(radios[1]).toBeDisabled();
    expect(radios[1]).toHaveAccessibleName(expect.stringMatching(/ — used by another member$/));
    expect(radios[2]).toBeDisabled();
    fireEvent.keyDown(radios[0], { key: "ArrowDown" });
    expect(radios[3]).toHaveFocus();
    expect(radios[3]).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(radios[3], { key: "ArrowUp" });
    expect(radios[0]).toHaveFocus();
    fireEvent.keyDown(radios[0], { key: "End" });
    expect(radios.at(-1)).toHaveFocus();
    fireEvent.keyDown(radios.at(-1)!, { key: "ArrowRight" });
    expect(radios[0]).toHaveFocus();
    fireEvent.keyDown(radios[0], { key: "Tab" });
    expect(radios[0]).toHaveAttribute("aria-checked", "true");

    expect(within(palette).getByRole("radio", { name: "Blue" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
  });

  it("creates a member from the same form, starting empty, and lets the server pick a colour", async () => {
    const mockFetch = mockBackend({
      create: () => json({ ...MEMBER_JANUARY, id: "new", colorKey: "teal" }, 201),
    });
    renderManagement();
    await screen.findByTestId("members-card-grid");

    fireEvent.click(screen.getByTestId("members-add-member"));
    const dialog = within(await screen.findByRole("dialog", { name: "Create Member" }));
    expect(dialog.getByLabelText("Display Name")).toHaveValue("");
    expect(
      dialog.getAllByRole("radio").filter((r) => r.getAttribute("aria-checked") === "true")
    ).toHaveLength(0);
    // No archive action on a member that does not exist yet.
    expect(dialog.queryByTestId("member-archive")).not.toBeInTheDocument();
    expect(dialog.getByTestId("member-save")).toBeDisabled();

    fireEvent.change(dialog.getByLabelText("Display Name"), { target: { value: " Sam " } });
    await selectComboboxOption("Role", "Child");
    fireEvent.click(dialog.getByRole("button", { name: "Create Member" }));

    await waitFor(() => {
      const postCall = (mockFetch.mock.calls as FetchCall[]).find(
        ([reqInput, init]) => String(reqInput) === "/api/members" && init?.method === "POST"
      );
      expect(parseJsonBody(postCall)).toEqual({ displayName: "Sam", role: "child" });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("announces a failed create inside the form and keeps what was typed", async () => {
    mockBackend({ create: () => json({ error: "boom" }, 500) });
    renderManagement();
    await screen.findByTestId("members-card-grid");

    fireEvent.click(screen.getByTestId("members-add-member"));
    const dialog = within(await screen.findByRole("dialog", { name: "Create Member" }));
    fireEvent.change(dialog.getByLabelText("Display Name"), { target: { value: "Sam" } });
    await selectComboboxOption("Role", "Child");
    fireEvent.click(dialog.getByRole("button", { name: "Create Member" }));

    expect(await dialog.findByRole("alert")).toHaveTextContent("boom");
    expect(dialog.getByLabelText("Display Name")).toHaveValue("Sam");
  });

  it("opens an archived member read-only, with restoring as the only action", async () => {
    const mockFetch = mockBackend({ archived: () => json([MEMBER_ARCHIVED]) });
    renderManagement();
    await screen.findByText("Ari");

    fireEvent.click(screen.getByTestId("members-tab-archived"));
    fireEvent.click(await screen.findByText("Robin"));
    const dialog = within(await screen.findByRole("dialog", { name: "Robin" }));
    expect(dialog.getByLabelText("Display Name")).toBeDisabled();
    dialog.getAllByRole("radio").forEach((radio) => expect(radio).toBeDisabled());
    expect(dialog.queryByTestId("member-save")).not.toBeInTheDocument();
    expect(dialog.queryByTestId("member-archive")).not.toBeInTheDocument();

    fireEvent.click(dialog.getByTestId("member-restore"));
    const restores = () =>
      (mockFetch.mock.calls as FetchCall[]).filter(([reqInput]) =>
        String(reqInput).endsWith("/restore")
      );
    expect(restores()).toHaveLength(0);
    fireEvent.click(await screen.findByTestId("member-lifecycle-confirm"));
    await waitFor(() => expect(restores()).toHaveLength(1));
  });
});

describe("MembersManagement — kiosk density (SC-001, SC-002)", () => {
  it("meets kiosk density across the active list AND an open edit row", async () => {
    mockBackend();
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderManagement();

      await screen.findByText("Ari");
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // Opening an edit row adds a display-name input, a role select, two birthdate selects,
      // a year input, and clear/save/cancel buttons — every one of them must ALSO meet the
      // kiosk minimum, not just the tab/refresh/list-action controls already rendered.
      fireEvent.click(screen.getAllByTestId(/^member-card-/)[0]);
      await screen.findByRole("button", { name: "Save" });
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("DELIBERATE NEGATIVE — forcing this surface's own Refresh button below the kiosk minimum makes the assertion fail", async () => {
    mockBackend();
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = renderManagement();
      const refreshButton = await screen.findByRole("button", { name: "New Member" });

      // A real control from this surface, not a synthetic fixture.
      refreshButton.style.height = "10px";
      refreshButton.style.fontSize = "8px";

      let thrown: unknown;
      try {
        assertKioskDensityCompliant(container);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(DensityViolationError);
      const message = (thrown as DensityViolationError).message;
      // Recorded verbatim in the recorded assertion — proof the helper actually rejects a real
      // undersized control on THIS surface, not merely on the helper's own synthetic fixtures.
      expect(message).toMatch(/height 10px is below the kiosk minimum 48px/);
      expect(message).toMatch(/font-size 8px is below the kiosk minimum 18px/);

      // Revert — the rest of this file (and any test after it) must see a compliant surface.
      refreshButton.style.height = "";
      refreshButton.style.fontSize = "";
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });

  // The archived tab is the only state that renders Restore, so its controls must be
  // measured with that tab open.
  it("also meets kiosk density on the archived tab, where Restore is the only reachable control of its kind", async () => {
    mockBackend({ archived: () => json([MEMBER_ARCHIVED]) });
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderManagement();
      await screen.findByText("Ari");

      fireEvent.click(screen.getByRole("button", { name: "Archived" }));
      fireEvent.click(await screen.findByText("Robin"));
      expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });
});

// A CLOSED Select renders only its trigger; its popover items do not exist in the DOM until it
// opens. Tests that render only closed selects therefore never measure a
// single option among the 45 birthdate and role options. Opening the popover is necessary to
// measure their density.
//
// Select popovers render their options only when opened. These tests open each popover, pin its
// option count, and assert that every rendered option meets kiosk density.
describe("MembersManagement — open Select popover items meet kiosk density (#790, fixed in select.tsx)", () => {
  it("MembersManagement: the edit row's Month/Day/Role popovers are density-compliant when open", async () => {
    mockBackend();
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderManagement();
      await screen.findByText("Ari");
      fireEvent.click(screen.getAllByTestId(/^member-card-/)[0]);
      await screen.findByRole("button", { name: "Save" });

      // `toBeInstanceOf` alone does not pin how many controls are unresolvable. A new popover-only
      // control could regress and be absorbed by a test already expected to throw. Pinning `.controls.length`
      // (the property actually exported by `DensityUnresolvableStyleError`, see
      // `tests/client/helpers/density.ts`) to the exact per-popover item count makes that
      // regression visible: each count below is exactly this select's own item population
      // (12 months, 31 days, 2 roles) — nothing else, since only one popover is open at a time.
      const expected: Array<[string, number]> = [
        ["Month", 12],
        ["Day", 31],
        ["Role", 2],
      ];
      for (const [triggerName, expectedCount] of expected) {
        fireEvent.click(screen.getByRole("combobox", { name: triggerName }));
        await screen.findAllByRole("option");

        // The option COUNT is still asserted, and it is what keeps this non-vacuous: compliance
        // over an EMPTY popover would pass trivially, so the population must be pinned
        // independently of the density check. The expected sizes are checked separately below.
        expect(
          screen.getAllByRole("option"),
          `expected exactly ${triggerName}'s own ${expectedCount} popover items to render`
        ).toHaveLength(expectedCount);
        expect(
          () => assertKioskDensityCompliant(document.body),
          `${triggerName}'s popover items must meet kiosk density now that #790 is fixed`
        ).not.toThrow();

        // Close before opening the next trigger, so each phase measures ONE open popover.
        fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
        await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));
      }
    } finally {
      uninject();
    }
  });
});

describe("MembersManagement — adopts the AdminPanel L2 frame (F2, independent review on)", () => {
  it("MembersManagement wraps the surface in a landmark region labelled by its own title", async () => {
    mockBackend();
    renderManagement();

    // A bare `<div>` in place of `AdminPanel` passes every functional test in this file — this
    // is the only assertion that would catch it, mirroring `calendar-view.test.tsx` and
    // `meals-management.test.tsx`'s own identical assertion for their own surfaces.
    expect(await screen.findByRole("region", { name: "Members Management" })).toBeInTheDocument();
    // Region alone is bypassable: `AdminPanel` names its region via `aria-labelledby` pointing
    // at its own heading, so a hand-rolled `<section aria-label="Members Management">` with NO
    // heading reproduces the landmark and its name and passes. The heading is the half a
    // substitute would have to reproduce the component to satisfy (per-change DoD).
    expect(screen.getByRole("heading", { name: "Members Management" })).toBeInTheDocument();
  });
});

// Check that the birthdate group label is visible; an accessible-name query alone could pass
// even when the visible label text is absent.
describe("MembersManagement — the birthdate group label is VISIBLE, not just accessible (F5 regression guard)", () => {
  it("MembersManagement's edit row renders the visible 'Birth Date (optional)' label", async () => {
    mockBackend();
    renderManagement();

    fireEvent.click((await screen.findAllByTestId(/^member-card-/))[0]);
    await screen.findByRole("button", { name: "Save" });

    expect(await screen.findByText("Birth Date (optional)")).toBeInTheDocument();
  });
});

describe("MembersManagement — error states are announced (SC-011)", () => {
  it("announces a members-list load failure through ErrorNotice's live region", async () => {
    mockBackend({ members: () => json(null, 500) });
    renderManagement();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load members.");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  it("announces an archive failure through ErrorNotice's live region", async () => {
    // Use a 500 response with a parseable JSON body to exercise the `!res.ok` check.
    // A null body makes `res.json` reject regardless of that guard, so the catch path would
    // look identical even if the guard were missing.
    mockBackend({ archive: () => json({ error: "archive_failed" }, 500) });
    renderManagement();

    await screen.findByText("Ari");
    fireEvent.click(screen.getAllByTestId(/^member-card-/)[0]);
    fireEvent.click(await screen.findByTestId("member-archive"));
    fireEvent.click(await screen.findByTestId("member-lifecycle-confirm"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to update the member.");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  it("announces an invalid-birthdate save through ErrorNotice's live region without a server round-trip", async () => {
    mockBackend();
    renderManagement();

    fireEvent.click((await screen.findAllByTestId(/^member-card-/))[0]);
    // The edit row starts with MEMBER_JANUARY's month+day+year all set (FR-009 preserves the
    // pre-migration prefill behaviour). Clearing resets all three; re-setting ONLY the year
    // reproduces the "partial birthdate" case (year set, month/day absent) via the surface's
    // own state, without needing to drive the Radix Select popover.
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    const yearInput = screen.getByPlaceholderText("Year");
    fireEvent.change(yearInput, { target: { value: "1999" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Enter both a month and a day, or leave the birth date empty.");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });
});

// A regression lesson from related date-label coverage:
// (MealsManagement, weekday parity): assert enough of a typed key -> translation map to catch an
// off-by-one or a swapped entry, not just the one index a happy-path test exercises. Rendered
// under a non-English household locale, so a leftover English literal fallback would read wrong
// too, not just coincidentally match.
describe("MembersManagement — the typed birthdate month/day lookup (SC-007) maps each 1-based value to its OWN key, through i18n", () => {
  it("formats a January, a June, and a December birth date in Spanish word order with the correct month name", async () => {
    mockBackend({ language: "es" });
    renderManagement();

    await screen.findByText("Ari");

    // `findByText` (not `getByText`) below: the household language comes from a SEPARATE
    // `/api/settings` fetch (`HouseholdSettingsProvider` -> `LanguageProvider`) than the one that
    // resolves "Ari" (the members list), so the locale can still be mid-flight — poll for it
    // rather than assert the instant "Ari" appears.
    // MEMBER_JANUARY: month=1, day=1, year=2015 — catches an off-by-one at the low end.
    expect(await screen.findByText(/1 de enero de 2015/)).toBeInTheDocument();
    // MEMBER_JUNE: month=6, day=15, year=null — mid-range, no year suffix.
    expect(await screen.findByText(/15 de junio$/)).toBeInTheDocument();
    // MEMBER_DECEMBER: month=12, day=31, year=2018 — catches an off-by-one/overflow at the
    // high end (index 11 of a 12-element array).
    expect(await screen.findByText(/31 de diciembre de 2018/)).toBeInTheDocument();
  });
});

describe("MembersManagement — archive/restore round-trip (unchanged behaviour, migration regression guard)", () => {
  it("archives a member and refreshes the active list", async () => {
    const mockFetch = mockBackend();
    renderManagement();

    await screen.findByText("Ari");
    fireEvent.click(screen.getAllByTestId(/^member-card-/)[0]);
    fireEvent.click(await screen.findByTestId("member-archive"));
    // Opening the form and pressing Archive is not enough: nothing is sent until confirmed.
    expect(
      (mockFetch.mock.calls as FetchCall[]).filter(([reqInput]) =>
        String(reqInput).endsWith("/archive")
      )
    ).toHaveLength(0);
    fireEvent.click(await screen.findByTestId("member-lifecycle-confirm"));

    await waitFor(() => {
      expect(
        (mockFetch.mock.calls as FetchCall[]).filter(([reqInput]) =>
          String(reqInput).endsWith("/archive")
        )
      ).toHaveLength(1);
    });
  });
});

// Open each birthdate popover, select an option by its visible label, and assert the numeric
// value sent to the server. Together these checks catch swapped label maps and mismatches between
// the SelectItem value and its 1-based index.
async function selectComboboxOption(triggerName: string, optionName: string): Promise<void> {
  fireEvent.click(screen.getByRole("combobox", { name: triggerName }));
  fireEvent.click(await screen.findByRole("option", { name: optionName }));
}

function parseJsonBody(call: FetchCall | undefined): Record<string, unknown> {
  const init = call?.[1];
  return init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
}

describe("MembersManagement — the edit row's Day select submits the VALUE matching the selected LABEL (F3)", () => {
  it.each([
    ["1", 1],
    ["16", 16],
    ["31", 31],
  ])("selecting day label %s submits birthDate.day === %i", async (dayLabel, expectedDay) => {
    cleanup();
    const mockFetch = mockBackend();
    renderManagement();

    fireEvent.click((await screen.findAllByTestId(/^member-card-/))[0]);
    await screen.findByRole("button", { name: "Save" });

    await selectComboboxOption("Day", dayLabel as string);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const patchCall = (mockFetch.mock.calls as FetchCall[]).find(
        ([reqInput, init]) => String(reqInput) === "/api/members/m1" && init?.method === "PATCH"
      );
      expect(patchCall).toBeDefined();
      expect(parseJsonBody(patchCall).birthDate).toMatchObject({ day: expectedDay });
    });
  });
});

describe("MembersManagement — the edit row's Month select submits the VALUE matching the selected LABEL (F3)", () => {
  it.each([
    ["January", 1],
    ["June", 6],
    ["December", 12],
  ])(
    "selecting month label %s submits birthDate.month === %i",
    async (monthLabel, expectedMonth) => {
      cleanup();
      const mockFetch = mockBackend();
      renderManagement();

      fireEvent.click((await screen.findAllByTestId(/^member-card-/))[0]);
      await screen.findByRole("button", { name: "Save" });

      await selectComboboxOption("Month", monthLabel as string);
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        const patchCall = (mockFetch.mock.calls as FetchCall[]).find(
          ([reqInput, init]) => String(reqInput) === "/api/members/m1" && init?.method === "PATCH"
        );
        expect(patchCall).toBeDefined();
        expect(parseJsonBody(patchCall).birthDate).toMatchObject({ month: expectedMonth });
      });
    }
  );
});

describe("MembersManagement — curated member colours", () => {
  it("sends an explicitly selected curated colour when creating and editing, without a free-form colour input", async () => {
    const mockFetch = mockBackend({
      create: () => json({ ...MEMBER_JANUARY, id: "new", colorKey: "violet" }, 201),
      patch: () => json({ ...MEMBER_JANUARY, colorKey: "violet" }),
    });
    renderManagement();
    await screen.findByTestId("members-card-grid");

    fireEvent.click(screen.getByTestId("members-add-member"));
    const createDialog = within(await screen.findByRole("dialog", { name: "Create Member" }));
    fireEvent.change(createDialog.getByLabelText("Display Name"), { target: { value: "Sam" } });
    await selectComboboxOption("Role", "Child");
    fireEvent.click(createDialog.getByRole("radio", { name: "Violet" }));
    fireEvent.click(createDialog.getByRole("button", { name: "Create Member" }));

    await waitFor(() => {
      const postCall = (mockFetch.mock.calls as FetchCall[]).find(
        ([reqInput, init]) => String(reqInput) === "/api/members" && init?.method === "POST"
      );
      expect(parseJsonBody(postCall)).toMatchObject({ colorKey: "violet" });
    });
    expect(document.querySelector('input[type="color"]')).toBeNull();

    cleanup();
    renderManagement();
    fireEvent.click((await screen.findAllByTestId(/^member-card-/))[0]);
    expect(screen.getByRole("radio", { name: "Blue" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "Violet" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const patchCall = (mockFetch.mock.calls as FetchCall[]).find(
        ([reqInput, init]) => String(reqInput) === "/api/members/m1" && init?.method === "PATCH"
      );
      expect(parseJsonBody(patchCall)).toMatchObject({ colorKey: "violet" });
    });
  });

  it("keeps a curated choice controllable for an eleventh member after every colour is in use", async () => {
    const palette = [
      "blue",
      "sky",
      "teal",
      "green",
      "lime",
      "amber",
      "orange",
      "red",
      "pink",
      "violet",
    ];
    const eleventh = {
      ...MEMBER_JANUARY,
      id: "m11",
      displayName: "Eleven",
      colorKey: "blue" as const,
    };
    const mockFetch = mockBackend({
      members: () =>
        json([
          ...palette.map((colorKey, index) => ({
            ...MEMBER_JANUARY,
            id: `m${index + 1}`,
            displayName: `Member ${index + 1}`,
            colorKey,
          })),
          eleventh,
        ]),
      patch: () => json({ ...eleventh, colorKey: "blue" }),
    });
    renderManagement();

    fireEvent.click((await screen.findAllByTestId(/^member-card-/))[10]);
    expect(screen.getByRole("radio", { name: "Blue" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "Blue" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const patchCall = (mockFetch.mock.calls as FetchCall[]).find(
        ([reqInput, init]) => String(reqInput) === "/api/members/m11" && init?.method === "PATCH"
      );
      expect(parseJsonBody(patchCall)).toMatchObject({ colorKey: "blue" });
    });
  });
});
