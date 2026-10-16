/** RemindersManagement spec (FR-005/FR-009) — the reminders admin page is a list of rules plus one
 * add/edit Dialog (scheduled all/specific with the member x weekday matrix, calendar_gated with
 * query and members), a per-row dry-run panel and a themed delete ConfirmDialog.
 * This is the executable evidence for the verification policy: it CALLS the frozen density
 * assertion over this surface's rendered control set with kiosk density active, records a
 * deliberate negative proving the assertion can fail on THIS surface's own controls, asserts the
 * announced error states (load with Retry, save inside the dialog, dry-run, toggle), asserts the
 * panel's own region+heading (the L2-adoption clause), and pins the row summaries, the
 * targetingMode edit payloads and the silent-refresh behaviour.
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
  colorKey: "blue",
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

const MEMBER_B = { ...MEMBER, id: "m2", displayName: "Bea", colorKey: "teal" };

const REMINDER_SPECIFIC = {
  id: "r3",
  kind: "scheduled",
  targetingMode: "specific",
  text: "Pack the gym bag",
  weekdays: null,
  query: null,
  queryFields: null,
  active: true,
  assignments: [
    { id: "a2", memberId: "m1", weekdays: ["mon", "wed"], active: true },
    { id: "a3", memberId: "m2", weekdays: ["fri"], active: true },
  ],
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
    members: () => Response;
    language: string;
    weekStartDay: number;
  }> = {}
) {
  const mockFetch = vi.fn((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url.includes("/api/settings")) {
      return Promise.resolve(
        json({
          locale: {
            timezone: "UTC",
            language: overrides.language ?? "en",
            weekStartDay: overrides.weekStartDay ?? 1,
          },
        })
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
      return Promise.resolve(overrides.members ? overrides.members() : json([MEMBER]));
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
  it("exposes an AdminPanel region AND heading named like the sidebar label, with a single such heading", async () => {
    mockBackend();
    renderSurface();
    await screen.findByText("Take out the trash");

    const region = await screen.findByRole("region", { name: "Reminders" });
    expect(within(region).getByRole("heading", { name: "Reminders" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Reminders" })).toHaveLength(1);
  });
});

describe("RemindersManagement — kiosk density (SC-001, SC-002, SC-003, SC-009)", () => {
  it("meets kiosk density with the list, the dry-run panel, the add dialog and the edit dialog open", async () => {
    mockBackend();
    const uninject = await injectDensityStyles({
      extraCandidates: ["size-[var(--control-height)]"],
    });
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderSurface();
      await screen.findByText("Take out the trash");
      await screen.findByText("Vet appointment prep");

      // Phase 1 — list only. Page: Add rule (1). Row r1: Deactivate, Edit, Delete (3).
      // Row r2 (calendar_gated): Deactivate, Dry-run, Edit, Delete (4). Total 8.
      expect(countInteractiveControls(document.body)).toBe(8);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // Phase 2 — r2's dry-run panel open: member select, date input, Run (+3) = 11.
      const cgRow = await screen.findByTestId("reminder-r2");
      fireEvent.click(within(cgRow).getByRole("button", { name: "Dry-run" }));
      await screen.findByText("Dry-run / explain");
      expect(countInteractiveControls(document.body)).toBe(11);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // Phase 3 — add dialog (scheduled, all members): close X (1), kind pills (2), text (1),
      // targeting pills (2), seven weekday pills (7), Cancel (1), Create (1) = +15 = 26.
      fireEvent.click(screen.getByTestId("reminders-add-rule"));
      await screen.findByTestId("reminder-form-dialog");
      expect(countInteractiveControls(document.body)).toBe(26);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("meets kiosk density with the edit dialog open on a specific rule (member pills)", async () => {
    mockBackend({
      reminders: () => json([REMINDER_SPECIFIC]),
      members: () => json([MEMBER, MEMBER_B]),
    });
    const uninject = await injectDensityStyles({
      extraCandidates: ["size-[var(--control-height)]"],
    });
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderSurface();
      await screen.findByText("Pack the gym bag");
      fireEvent.click(screen.getByTestId("reminder-edit-r3"));
      await screen.findByTestId("reminder-form-dialog");
      // Dialog: close X (1), text (1), targeting pills (2), 2 member pills (2) + their 2 x 7
      // weekday pills (14), Cancel (1), Save (1) = 22; page behind it: Add rule, Deactivate, Edit,
      // Delete = 4. Total 26.
      expect(countInteractiveControls(document.body)).toBe(26);
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

      fireEvent.click(within(card).getByRole("button", { name: /^Delete/ }));
      await screen.findByRole("dialog");

      // Asserted over document.body — the one shape that reaches a control Radix mounted
      // outside `card`'s own DOM subtree.
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("DELIBERATE NEGATIVE — forcing this surface's own Add rule button below the kiosk minimum makes the assertion fail", async () => {
    mockBackend();
    const uninject = await injectDensityStyles({
      extraCandidates: ["size-[var(--control-height)]"],
    });
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = renderSurface();
      const createButton = await screen.findByTestId("reminders-add-rule");

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

describe("RemindersManagement — error states are announced (SC-011) and recoverable", () => {
  it("announces a data-load failure through ErrorNotice's live region and offers Retry that recovers", async () => {
    let fail = true;
    const mockFetch = mockBackend({
      reminders: () => (fail ? json(null, 500) : json([REMINDER_SCHEDULED])),
    });
    renderSurface();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load reminders.");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(screen.queryByTestId("reminders-add-rule")).not.toBeInTheDocument();

    fail = false;
    fireEvent.click(screen.getByTestId("reminders-retry"));
    expect(await screen.findByText("Take out the trash")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      (mockFetch.mock.calls as FetchCall[]).filter(
        ([u, init]) => String(u) === "/api/reminders" && (init?.method ?? "GET") === "GET"
      ).length
    ).toBeGreaterThanOrEqual(2);
  });

  it("keeps the add dialog open and announces a create failure inside it", async () => {
    const mockFetch = mockBackend();
    renderSurface();
    await screen.findByText("Take out the trash");

    fireEvent.click(screen.getByTestId("reminders-add-rule"));
    const dialog = await screen.findByTestId("reminder-form-dialog");
    mockFetch.mockImplementation((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      if (url === "/api/reminders" && init?.method === "POST")
        return Promise.resolve(json(null, 500));
      throw new Error(`unexpected fetch after override: ${url}`);
    });

    fireEvent.change(within(dialog).getByPlaceholderText("Reminder text"), {
      target: { value: "New reminder" },
    });
    fireEvent.click(within(dialog).getByLabelText("Mon"));
    fireEvent.click(within(dialog).getByTestId("reminder-save"));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Failed to save the reminder.");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(screen.getByTestId("reminder-form-dialog")).toBeInTheDocument();
  });

  it("announces a dry-run failure through ErrorNotice's live region", async () => {
    const mockFetch = mockBackend();
    renderSurface();

    const row = await screen.findByTestId("reminder-r2");
    fireEvent.click(within(row).getByRole("button", { name: "Dry-run" }));
    await screen.findByText("Dry-run / explain");

    mockFetch.mockImplementation((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      if (/\/api\/reminders\/[^/]+\/dry-run$/.test(url) && init?.method === "POST") {
        return Promise.resolve(json(null, 500));
      }
      throw new Error(`unexpected fetch after override: ${url}`);
    });

    fireEvent.change(within(row).getByRole("combobox"), { target: { value: "m1" } });
    fireEvent.click(within(row).getByRole("button", { name: "Run" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to run dry-run.");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  it("announces a toggle failure at page level", async () => {
    const mockFetch = mockBackend();
    renderSurface();
    const row = await screen.findByTestId("reminder-r1");
    mockFetch.mockImplementation((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
      if (String(input) === "/api/reminders/r1" && init?.method === "PATCH") {
        return Promise.resolve(json(null, 500));
      }
      throw new Error(`unexpected fetch after override: ${String(input)}`);
    });
    fireEvent.click(within(row).getByTestId("reminder-toggle-r1"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to update the reminder.");
  });
});

describe("RemindersManagement — deleting a reminder opens a themed ConfirmDialog instead of window.confirm (research D3/FR-005)", () => {
  it("does not delete until the ConfirmDialog is confirmed, and deletes on confirm", async () => {
    const mockFetch = mockBackend();
    renderSurface();

    const card = await screen.findByTestId("reminder-r1");
    fireEvent.click(within(card).getByRole("button", { name: /^Delete/ }));
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
    fireEvent.click(within(card).getByRole("button", { name: /^Delete/ }));
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

describe("RemindersManagement — rows name their members and days", () => {
  it("summarises all-members, specific and calendar-gated rules", async () => {
    mockBackend({
      reminders: () => json([REMINDER_SCHEDULED, REMINDER_SPECIFIC, REMINDER_CALENDAR_GATED]),
      members: () => json([MEMBER, MEMBER_B]),
    });
    renderSurface();
    await screen.findByText("Pack the gym bag");

    expect(
      within(screen.getByTestId("reminder-r1")).getByText("All members · Mon")
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("reminder-r3")).getByText("Ari: Mon, Wed · Bea: Fri")
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("reminder-r2")).getByText("Match text: vet · Ari")
    ).toBeInTheDocument();
    expect(within(screen.getByTestId("reminder-r1")).getByText("Active")).toBeInTheDocument();
  });

  it("shows Off for an inactive rule", async () => {
    mockBackend({ reminders: () => json([{ ...REMINDER_SCHEDULED, active: false }]) });
    renderSurface();
    expect(await screen.findByText("Off")).toBeInTheDocument();
  });
});

describe("RemindersManagement — the add/edit dialog", () => {
  it("creates a specific scheduled rule from the member pills", async () => {
    const mockFetch = mockBackend();
    renderSurface();
    await screen.findByText("Take out the trash");

    fireEvent.click(screen.getByTestId("reminders-add-rule"));
    const dialog = await screen.findByTestId("reminder-form-dialog");
    fireEvent.change(within(dialog).getByPlaceholderText("Reminder text"), {
      target: { value: "Bus day" },
    });
    fireEvent.click(within(dialog).getByLabelText("Specific members"));
    expect(within(dialog).getByTestId("reminder-save")).toBeDisabled();
    fireEvent.click(within(dialog).getByTestId("reminders-member-m1"));
    fireEvent.click(within(dialog).getByTestId("reminders-weekday-m1-mon"));
    fireEvent.click(within(dialog).getByTestId("reminder-save"));

    await waitFor(() => {
      const post = (mockFetch.mock.calls as FetchCall[]).find(
        ([u, init]) => String(u) === "/api/reminders" && init?.method === "POST"
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post![1]!.body))).toEqual({
        kind: "scheduled",
        targetingMode: "specific",
        text: "Bus day",
        assignments: [{ memberId: "m1", weekdays: ["mon"] }],
      });
    });
    await waitFor(() =>
      expect(screen.queryByTestId("reminder-form-dialog")).not.toBeInTheDocument()
    );
  });

  it("orders each member's weekday pills by the household week start", async () => {
    const mockFetch = mockBackend({ weekStartDay: 0 });
    renderSurface();
    await screen.findByText("Take out the trash");

    fireEvent.click(screen.getByTestId("reminders-add-rule"));
    const dialog = await screen.findByTestId("reminder-form-dialog");
    fireEvent.change(within(dialog).getByPlaceholderText("Reminder text"), {
      target: { value: "Bus day" },
    });
    fireEvent.click(within(dialog).getByLabelText("Specific members"));
    fireEvent.click(within(dialog).getByTestId("reminders-member-m1"));
    const group = await within(dialog).findByRole("group", { name: "Ari — Weekdays" });
    expect(
      within(group)
        .getAllByRole("checkbox")
        .map((box) => box.closest("label")?.textContent?.trim())
    ).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);

    // Storage order is unchanged: picking Sunday then Monday still saves mon..sun order.
    fireEvent.click(within(dialog).getByTestId("reminders-weekday-m1-sun"));
    fireEvent.click(within(dialog).getByTestId("reminders-weekday-m1-mon"));
    fireEvent.click(within(dialog).getByTestId("reminder-save"));
    await waitFor(() => {
      const post = (mockFetch.mock.calls as FetchCall[]).find(
        ([u, init]) => String(u) === "/api/reminders" && init?.method === "POST"
      );
      expect(JSON.parse(String(post![1]!.body)).assignments).toEqual([
        { memberId: "m1", weekdays: ["mon", "sun"] },
      ]);
    });
  });

  it("Enter in the text field submits a valid form", async () => {
    const mockFetch = mockBackend();
    renderSurface();
    await screen.findByText("Take out the trash");
    fireEvent.click(screen.getByTestId("reminders-add-rule"));
    const dialog = await screen.findByTestId("reminder-form-dialog");
    const input = within(dialog).getByPlaceholderText("Reminder text");
    fireEvent.change(input, { target: { value: "Enter submit" } });
    fireEvent.click(within(dialog).getByLabelText("Tue"));
    fireEvent.submit(input.closest("form")!);
    await waitFor(() =>
      expect(
        (mockFetch.mock.calls as FetchCall[]).some(
          ([u, init]) => String(u) === "/api/reminders" && init?.method === "POST"
        )
      ).toBe(true)
    );
  });

  it("edits an all-members rule into a specific one (PATCH carries targetingMode and assignments)", async () => {
    const mockFetch = mockBackend();
    renderSurface();
    await screen.findByText("Take out the trash");

    fireEvent.click(screen.getByTestId("reminder-edit-r1"));
    const dialog = await screen.findByTestId("reminder-form-dialog");
    expect(within(dialog).queryByLabelText("Calendar-gated")).not.toBeInTheDocument(); // kind is fixed
    expect(within(dialog).getByPlaceholderText("Reminder text")).toHaveValue("Take out the trash");

    fireEvent.click(within(dialog).getByLabelText("Specific members"));
    fireEvent.click(within(dialog).getByTestId("reminders-member-m1"));
    fireEvent.click(within(dialog).getByTestId("reminders-weekday-m1-tue"));
    fireEvent.click(within(dialog).getByTestId("reminder-save"));

    await waitFor(() => {
      const patch = (mockFetch.mock.calls as FetchCall[]).find(
        ([u, init]) => String(u) === "/api/reminders/r1" && init?.method === "PATCH"
      );
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch![1]!.body))).toEqual({
        text: "Take out the trash",
        targetingMode: "specific",
        assignments: [{ memberId: "m1", weekdays: ["tue"] }],
      });
    });
  });

  it("edits a specific calendar-gated rule back to all members (no assignments sent)", async () => {
    const mockFetch = mockBackend();
    renderSurface();
    await screen.findByText("Vet appointment prep");
    fireEvent.click(screen.getByTestId("reminder-edit-r2"));
    const dialog = await screen.findByTestId("reminder-form-dialog");
    fireEvent.click(within(dialog).getByLabelText("All members"));
    fireEvent.click(within(dialog).getByTestId("reminder-save"));
    await waitFor(() => {
      const patch = (mockFetch.mock.calls as FetchCall[]).find(
        ([u, init]) => String(u) === "/api/reminders/r2" && init?.method === "PATCH"
      );
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch![1]!.body))).toEqual({
        text: "Vet appointment prep",
        targetingMode: "apply_to_all",
        query: "vet",
        queryFields: ["title", "description"],
      });
    });
  });

  it("a successful toggle refreshes silently: an open dry-run panel stays mounted", async () => {
    mockBackend();
    renderSurface();
    const row = await screen.findByTestId("reminder-r2");
    fireEvent.click(within(row).getByRole("button", { name: "Dry-run" }));
    await screen.findByText("Dry-run / explain");

    fireEvent.click(within(row).getByTestId("reminder-toggle-r2"));
    await waitFor(() => expect(screen.getByTestId("reminder-r2")).toBeInTheDocument());
    // the page never swapped to its loading panel, so the panel is still there
    expect(screen.getByText("Dry-run / explain")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });
});

describe("RemindersManagement — the dialog's pill controls", () => {
  async function openCreate(overrides: Parameters<typeof mockBackend>[0] = {}) {
    const mockFetch = mockBackend({ members: () => json([MEMBER, MEMBER_B]), ...overrides });
    renderSurface();
    await screen.findByText("Take out the trash");
    fireEvent.click(screen.getByTestId("reminders-add-rule"));
    const dialog = await screen.findByTestId("reminder-form-dialog");
    return { mockFetch, dialog };
  }
  const postBody = (mockFetch: ReturnType<typeof mockBackend>) => {
    const post = (mockFetch.mock.calls as FetchCall[]).find(
      ([u, init]) => String(u) === "/api/reminders" && init?.method === "POST"
    );
    return post ? JSON.parse(String(post[1]!.body)) : undefined;
  };

  it("offers the kind as a segmented choice in create mode and switches the form", async () => {
    const { dialog } = await openCreate();
    const kind = within(dialog).getByRole("radiogroup", { name: "Kind" });
    expect(within(kind).getByRole("radio", { name: "Scheduled" })).toBeChecked();
    expect(within(kind).getByRole("radio", { name: "Calendar-gated" })).not.toBeChecked();

    fireEvent.click(within(kind).getByRole("radio", { name: "Calendar-gated" }));
    expect(
      within(dialog).getByPlaceholderText("Text to match in calendar events")
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByLabelText("Specific members"));
    expect(within(dialog).getByRole("group", { name: "Assigned members" })).toBeInTheDocument();
  });

  it("shows no kind choice when editing", async () => {
    mockBackend();
    renderSurface();
    await screen.findByText("Take out the trash");
    fireEvent.click(screen.getByTestId("reminder-edit-r1"));
    const dialog = await screen.findByTestId("reminder-form-dialog");
    expect(within(dialog).queryByRole("radiogroup", { name: "Kind" })).not.toBeInTheDocument();
  });

  it("deselecting a member drops their days from the body", async () => {
    const { mockFetch, dialog } = await openCreate();
    fireEvent.change(within(dialog).getByPlaceholderText("Reminder text"), {
      target: { value: "Drop test" },
    });
    fireEvent.click(within(dialog).getByLabelText("Specific members"));
    fireEvent.click(within(dialog).getByTestId("reminders-member-m1"));
    fireEvent.click(within(dialog).getByTestId("reminders-weekday-m1-mon"));
    fireEvent.click(within(dialog).getByTestId("reminders-member-m2"));
    fireEvent.click(within(dialog).getByTestId("reminders-weekday-m2-fri"));
    fireEvent.click(within(dialog).getByTestId("reminders-member-m1"));
    fireEvent.click(within(dialog).getByTestId("reminder-save"));

    await waitFor(() => expect(postBody(mockFetch)).toBeTruthy());
    expect(postBody(mockFetch).assignments).toEqual([{ memberId: "m2", weekdays: ["fri"] }]);
  });

  it("prefills the selected members and their days when editing a specific rule", async () => {
    mockBackend({
      reminders: () => json([REMINDER_SPECIFIC]),
      members: () => json([MEMBER, MEMBER_B]),
    });
    renderSurface();
    await screen.findByText("Pack the gym bag");
    fireEvent.click(screen.getByTestId("reminder-edit-r3"));
    const dialog = await screen.findByTestId("reminder-form-dialog");
    expect(within(dialog).getByTestId("reminders-member-m1")).toBeChecked();
    expect(within(dialog).getByTestId("reminders-member-m2")).toBeChecked();
    expect(within(dialog).getByTestId("reminders-weekday-m1-mon")).toBeChecked();
    expect(within(dialog).getByTestId("reminders-weekday-m1-wed")).toBeChecked();
    expect(within(dialog).getByTestId("reminders-weekday-m2-fri")).toBeChecked();
    expect(within(dialog).getByTestId("reminders-weekday-m1-tue")).not.toBeChecked();
  });

  it("keeps Save disabled and explains why while a selected member has no days", async () => {
    const { dialog } = await openCreate();
    fireEvent.change(within(dialog).getByPlaceholderText("Reminder text"), {
      target: { value: "Hint test" },
    });
    fireEvent.click(within(dialog).getByLabelText("Specific members"));
    fireEvent.click(within(dialog).getByTestId("reminders-member-m1"));
    expect(within(dialog).getByTestId("reminders-member-hint-m1")).toBeInTheDocument();
    expect(within(dialog).getByTestId("reminder-save")).toBeDisabled();
    fireEvent.click(within(dialog).getByTestId("reminders-weekday-m1-mon"));
    expect(within(dialog).queryByTestId("reminders-member-hint-m1")).not.toBeInTheDocument();
    expect(within(dialog).getByTestId("reminder-save")).toBeEnabled();
  });

  it("creates a specific calendar-gated rule with member pills and a query-field pill", async () => {
    const { mockFetch, dialog } = await openCreate();
    fireEvent.change(within(dialog).getByPlaceholderText("Reminder text"), {
      target: { value: "Gated" },
    });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Calendar-gated" }));
    fireEvent.click(within(dialog).getByLabelText("Specific members"));
    fireEvent.change(within(dialog).getByLabelText("Match text"), { target: { value: "vet" } });
    fireEvent.click(within(dialog).getByTestId("reminders-query-field-location"));
    fireEvent.click(within(dialog).getByTestId("reminders-cg-member-m1"));
    fireEvent.click(within(dialog).getByTestId("reminder-save"));

    await waitFor(() => expect(postBody(mockFetch)).toBeTruthy());
    expect(postBody(mockFetch)).toMatchObject({
      kind: "calendar_gated",
      targetingMode: "specific",
      query: "vet",
      queryFields: ["title", "description", "location"],
      assignments: [{ memberId: "m1", weekdays: [] }],
    });
  });

  it("prefills the member pills when editing a calendar-gated rule", async () => {
    mockBackend({ members: () => json([MEMBER, MEMBER_B]) });
    renderSurface();
    await screen.findByText("Vet appointment prep");
    fireEvent.click(screen.getByTestId("reminder-edit-r2"));
    const dialog = await screen.findByTestId("reminder-form-dialog");
    expect(within(dialog).getByTestId("reminders-cg-member-m1")).toBeChecked();
    expect(within(dialog).getByTestId("reminders-cg-member-m2")).not.toBeChecked();
  });

  it("shows the empty message instead of an empty group when there are no active members", async () => {
    const { dialog } = await openCreate({ members: () => json([]) });
    fireEvent.click(within(dialog).getByLabelText("Specific members"));
    expect(within(dialog).getByText("No active members.")).toBeInTheDocument();
    expect(within(dialog).queryByTestId(/^reminders-member-/)).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("radio", { name: "Calendar-gated" }));
    expect(within(dialog).getByText("No active members.")).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("group", { name: "Assigned members" })
    ).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByTestId("reminders-add-rule"));
    await screen.findByTestId("reminder-form-dialog");

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
    fireEvent.click(screen.getByTestId("reminders-add-rule"));
    const dialog = await screen.findByTestId("reminder-form-dialog");

    fireEvent.change(within(dialog).getByPlaceholderText("Reminder text"), {
      target: { value: "Order test" },
    });
    // Click order deliberately REVERSED from canonical order.
    fireEvent.click(within(dialog).getByLabelText("Wed"));
    fireEvent.click(within(dialog).getByLabelText("Mon"));
    fireEvent.click(within(dialog).getByTestId("reminder-save"));

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
