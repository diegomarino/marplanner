/** TimeAnnouncementsManagement + DailyBriefingManagement spec (FR-005/FR-009,
 *) — the two surfaces that configure scheduled output.
 * This is the executable evidence for the verification policy (verification policy): it CALLS
 * the frozen density assertion over each surface's rendered control set with kiosk density
 * active (not merely imports it), across several reachable interaction states with an exact
 * control-count census per phase, records a deliberate negative per surface proving the
 * assertion can fail on THAT surface's own controls, asserts every error state either surface
 * can render is announced through the shared `ErrorNotice` live region, asserts the shared
 * `AdminPanel` L2 frame was actually adopted (region + heading, not region alone), asserts BOTH
 * surfaces' adoption of the shared `WeekdayPicker` (SC-009) — the group's accessible name AND
 * that toggling emits the CANONICAL `mon..sun` order at the request boundary, not click order —
 * and pins both surfaces' `WEEKDAY_LABEL_KEYS` maps by iteration (SC-007).
 * * `ConfirmDialog`:* `TimeAnnouncementsManagement` uses it for rule delete (the old
 * `window.confirm` is gone); `DailyBriefingManagement` has no destructive action of any kind
 * (opt-in, generate, and the settings-layer writes are all non-destructive) — nothing to gate.
 * `StatusToggle`/`RadioField` do not apply to either surface — neither renders a pressed-state
 * toggle or a mutually-exclusive radio choice.
 * Functional CRUD/settings-layer coverage already exists (`tests/client/
 * time-announcements-management.test.tsx`, `tests/client/time-announcements-i18n-parity.test.ts`,
 * `tests/client/daily-briefing-management.test.tsx`, `tests/client/daily-briefing-admin.test.tsx`,
 * `tests/client/daily-briefing-admin-mirror-fence.test.tsx`) — this file does not repeat that
 * surface area; it only proves the migration-specific guarantees exists to prove.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TimeAnnouncementsManagement,
  WEEKDAY_LABEL_KEYS as TIME_ANNOUNCEMENTS_WEEKDAY_LABEL_KEYS,
} from "@/admin/TimeAnnouncementsManagement";
import {
  DailyBriefingManagement,
  WEEKDAY_LABEL_KEYS as DAILY_BRIEFING_WEEKDAY_LABEL_KEYS,
} from "@/admin/DailyBriefingManagement";
import { HouseholdSettingsProvider } from "@/lib/householdSettings";
import { LanguageProvider } from "@/i18n";
import { DensityViolationError, assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

type FetchCall = Parameters<typeof globalThis.fetch>;

function json(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status });
}

/** Mirrors `density.ts`'s own selector/filter — see `reminders.test.tsx`'s identical helper for
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
    if (element instanceof HTMLElement && element.closest("[hidden]")) return false;
    return element.getAttribute("aria-hidden") !== "true";
  }).length;
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  document.documentElement.removeAttribute("data-density");
});

/* ==================================================================================
 * TimeAnnouncementsManagement
 * ================================================================================== */

const RULE_MORNING = {
  id: "rule-morning",
  time: "07:00",
  weekDays: ["mon", "tue", "wed", "thu", "fri"],
  isActive: true,
};

const RULE_EVENING = {
  id: "rule-evening",
  time: "20:00",
  weekDays: ["sat", "sun"],
  isActive: false,
};

/** Stateful — GET reflects any POST/PATCH/DELETE this same mock has already served, so a spec can
 * drive create/delete through the real UI and assert the NEXT load reflects it (mirrors
 * `daily-briefing-admin.test.tsx`'s own stateful mock precedent). */
function mockTimeAnnouncementsBackend(
  overrides: Partial<{ rules: () => Response; language: string }> = {}
) {
  let current = [RULE_MORNING, RULE_EVENING];

  const mockFetch = vi.fn((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url.includes("/api/settings")) {
      return Promise.resolve(
        json({ locale: { timezone: "UTC", language: overrides.language ?? "en" } })
      );
    }
    if (overrides.rules && url === "/api/time-announcements" && method === "GET") {
      return Promise.resolve(overrides.rules());
    }
    if (url === "/api/time-announcements" && method === "GET") {
      return Promise.resolve(json(current));
    }
    if (url === "/api/time-announcements" && method === "POST") {
      return Promise.resolve(json(RULE_MORNING, 201));
    }
    if (/\/api\/time-announcements\/[^/]+$/.test(url) && method === "PATCH") {
      return Promise.resolve(json({ ...RULE_MORNING, isActive: false }));
    }
    const deleteMatch = /\/api\/time-announcements\/([^/]+)$/.exec(url);
    if (deleteMatch && method === "DELETE") {
      current = current.filter((rule) => rule.id !== deleteMatch[1]);
      return Promise.resolve(json(null, 204));
    }

    throw new Error(`unexpected fetch: ${url} (${method})`);
  });

  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

function renderTimeAnnouncements() {
  return render(
    <HouseholdSettingsProvider>
      <LanguageProvider>
        <TimeAnnouncementsManagement />
      </LanguageProvider>
    </HouseholdSettingsProvider>
  );
}

describe("TimeAnnouncementsManagement — the panel is a real landmark (FR-009 L2-adoption clause)", () => {
  it("exposes an AdminPanel region AND heading, both named for the panel title", async () => {
    mockTimeAnnouncementsBackend();
    renderTimeAnnouncements();

    // The LOADED panel, not the loading skeleton — TimeAnnouncementsManagement renders a second
    // AdminPanel with the SAME title while loading, so anchor on loaded fixture content first.
    await screen.findByTestId("time-announcements-rule-rule-morning");

    const region = await screen.findByRole("region", { name: "Time announcements" });
    const heading = within(region).getByRole("heading", { name: "Time announcements" });
    expect(heading).toBeInTheDocument();
  });
});

describe("TimeAnnouncementsManagement — kiosk density across reachable states (SC-001, SC-002, SC-003)", () => {
  it("meets kiosk density collapsed with two rules, then with the create dialog open", async () => {
    mockTimeAnnouncementsBackend();
    const uninject = await injectDensityStyles({
      extraCandidates: ["size-[var(--control-height)]"],
    });
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderTimeAnnouncements();
      await screen.findByTestId("time-announcements-rule-rule-morning");
      await screen.findByTestId("time-announcements-rule-rule-evening");

      // Phase 1 — collapsed: the header "+ Create" button + each rule's own action row
      // (Edit icon, Delete icon, Activate/Deactivate) = 1 + 3 * 2.
      expect(countInteractiveControls(document.body)).toBe(7);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // Phase 2 — the create dialog open: time input, Test voice, 7 weekday checkboxes, the
      // Active checkbox, Cancel, Create and the dialog's close button = 13, on top of the
      // 7 behind it (counted: the census reads 20, matching 7 + 13).
      fireEvent.click(screen.getByTestId("time-announcements-create"));
      expect(countInteractiveControls(document.body)).toBe(20);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("CENSUS FIRES ON REMOVAL — deleting a rule drops its collapsed row's 3 controls (7 -> 4), not a synthetic shrink", async () => {
    mockTimeAnnouncementsBackend();
    const uninject = await injectDensityStyles({
      extraCandidates: ["size-[var(--control-height)]"],
    });
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderTimeAnnouncements();
      await screen.findByTestId("time-announcements-rule-rule-morning");
      await screen.findByTestId("time-announcements-rule-rule-evening");

      expect(countInteractiveControls(document.body)).toBe(7);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      fireEvent.click(screen.getByTestId("time-announcements-delete-rule-evening"));
      fireEvent.click(await screen.findByTestId("time-announcements-delete-confirm"));
      await waitFor(() =>
        expect(screen.queryByTestId("time-announcements-rule-rule-evening")).not.toBeInTheDocument()
      );
      // The confirm dialog must be gone too, or its buttons would inflate the census.
      await waitFor(() =>
        expect(screen.queryByTestId("time-announcements-delete-confirm")).not.toBeInTheDocument()
      );

      // rule-evening's own Edit/Delete/Toggle (3 controls) are gone — a census that failed to
      // actually recompute (a stale/memoized count) would still read 7 here.
      expect(countInteractiveControls(document.body)).toBe(4);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("DELIBERATE NEGATIVE — forcing this surface's own Create button below the kiosk minimum makes the assertion fail", async () => {
    mockTimeAnnouncementsBackend();
    const uninject = await injectDensityStyles({
      extraCandidates: ["size-[var(--control-height)]"],
    });
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = renderTimeAnnouncements();
      const createButton = await screen.findByTestId("time-announcements-create");

      createButton.style.height = "11px";
      createButton.style.fontSize = "9px";

      let thrown: unknown;
      try {
        assertKioskDensityCompliant(container);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(DensityViolationError);
      const message = (thrown as DensityViolationError).message;
      expect(message).toMatch(/height 11px is below the kiosk minimum 48px/);
      expect(message).toMatch(/font-size 9px is below the kiosk minimum 18px/);

      createButton.style.height = "";
      createButton.style.fontSize = "";
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });
});

describe("TimeAnnouncementsManagement — error states are announced (SC-011)", () => {
  it("announces a data-load failure through ErrorNotice's live region", async () => {
    mockTimeAnnouncementsBackend({ rules: () => json(null, 500) });
    renderTimeAnnouncements();

    const alert = await screen.findByTestId("time-announcements-error");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(alert).toHaveTextContent("Failed to load time announcements.");
    expect(screen.getByTestId("time-announcements-retry")).toBeInTheDocument();
  });

  it("announces a create-rule failure through ErrorNotice's live region", async () => {
    const mockFetch = mockTimeAnnouncementsBackend();
    renderTimeAnnouncements();
    await screen.findByTestId("time-announcements-rule-rule-morning");

    mockFetch.mockImplementation((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      if (url.includes("/api/settings")) {
        return Promise.resolve(json({ locale: { timezone: "UTC", language: "en" } }));
      }
      if (url === "/api/time-announcements" && init?.method === "POST") {
        return Promise.resolve(json({ error: "active_overlap", message: "overlap detected" }, 409));
      }
      throw new Error(`unexpected fetch after override: ${url}`);
    });

    fireEvent.click(screen.getByTestId("time-announcements-create"));
    fireEvent.click(screen.getByTestId("time-announcements-weekday-mon"));
    fireEvent.click(screen.getByTestId("time-announcements-submit"));

    const alert = await screen.findByTestId("time-announcements-form-error");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(alert).toHaveTextContent(
      "An active rule already announces at this time on an overlapping weekday."
    );
  });
});

describe("WeekdayPicker adoption (TimeAnnouncementsManagement) — group accessible name AND canonical emission order (SC-009)", () => {
  it("labels the create form's WeekdayPicker group with the localized weekdays caption", async () => {
    mockTimeAnnouncementsBackend({ language: "es" });
    renderTimeAnnouncements();
    await screen.findByTestId("time-announcements-rule-rule-morning");
    fireEvent.click(screen.getByTestId("time-announcements-create"));

    // findByRole, not getByRole: the testid anchor above proves the DATA loaded, but testids are
    // locale-independent — the surface can still be mid-flight on the async /api/settings locale
    // fetch, rendering English. Awaiting the LOCALIZED group name is the
    // await-the-state-you-assert fix (fourth appearance of this race today:,
    // handoff, and twice here).
    const group = await screen.findByRole("group", { name: "Días de la semana" });
    const dayLabels = within(group)
      .getAllByRole("checkbox")
      .map((checkbox) => checkbox.closest("label")?.textContent?.trim());
    expect(dayLabels).toEqual(["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]);
  });

  it("toggling Wed then Mon emits mon..wed in canonical order, not click order, at the create POST boundary", async () => {
    // A hand-rolled replica that renders labels in canonical order but APPENDS on click passes
    // every render-only assertion — the falsifier is the POST body, not the DOM.
    const mockFetch = mockTimeAnnouncementsBackend();
    renderTimeAnnouncements();
    await screen.findByTestId("time-announcements-rule-rule-morning");

    fireEvent.click(screen.getByTestId("time-announcements-create"));
    // The time input already holds the 07:00 default.
    // Click order deliberately REVERSED from canonical order.
    fireEvent.click(screen.getByTestId("time-announcements-weekday-wed"));
    fireEvent.click(screen.getByTestId("time-announcements-weekday-mon"));
    fireEvent.click(screen.getByTestId("time-announcements-submit"));

    await waitFor(() => {
      const post = mockFetch.mock.calls.find(
        ([input, init]) => String(input) === "/api/time-announcements" && init?.method === "POST"
      );
      expect(post, "the create POST must have fired").toBeTruthy();
      const body = JSON.parse(String(post![1]!.body));
      expect(body.weekDays, "emission must be canonical mon..sun, not click order").toEqual([
        "mon",
        "wed",
      ]);
    });
  });
});

describe("TimeAnnouncementsManagement — WEEKDAY_LABEL_KEYS maps each weekday to its OWN translation key (SC-007's cast removal, pinned)", () => {
  it("every weekday maps to its own key, by ITERATING the map", () => {
    const keys = Object.keys(
      TIME_ANNOUNCEMENTS_WEEKDAY_LABEL_KEYS
    ) as (keyof typeof TIME_ANNOUNCEMENTS_WEEKDAY_LABEL_KEYS)[];
    expect(keys.length).toBe(7);
    for (const k of keys) {
      expect(TIME_ANNOUNCEMENTS_WEEKDAY_LABEL_KEYS[k], `weekday "${k}" maps to the wrong key`).toBe(
        `timeAnnouncements.weekday.${k}`
      );
    }
  });
});

/* ==================================================================================
 * DailyBriefingManagement
 * ================================================================================== */

const ADA = {
  id: "member-ada",
  displayName: "Ada",
  role: "parent",
  lifecycle: "active",
  createdAt: 1,
  updatedAt: 1,
  birthDate: null,
};
const BEN = {
  id: "member-ben",
  displayName: "Ben",
  role: "child",
  lifecycle: "active",
  createdAt: 1,
  updatedAt: 1,
  birthDate: null,
};

function defaultDailyBriefingSettings(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    generationTime: "06:00",
    autoPrintTrigger: null,
    blockOrder: [],
    memberBlockSettings: [],
    ...overrides,
  };
}

function mockDailyBriefingBackend(
  overrides: Partial<{
    members: () => Response;
    optIns: () => Response;
    settings: () => Response;
    optInPut: (memberId: string, init: Parameters<typeof fetch>[1]) => Response;
    generate: () => Response;
    blockSettingsPut: (
      memberId: string,
      blockType: string,
      init: Parameters<typeof fetch>[1]
    ) => Response;
    language: string;
  }> = {}
) {
  const mockFetch = vi.fn((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url === "/api/settings") {
      return Promise.resolve(
        json({ locale: { timezone: "UTC", language: overrides.language ?? "en" } })
      );
    }
    if (url === "/api/members") {
      return Promise.resolve(overrides.members ? overrides.members() : json([ADA, BEN]));
    }
    if (url === "/api/daily-briefing/opt-in" && method === "GET") {
      return Promise.resolve(overrides.optIns ? overrides.optIns() : json([]));
    }
    const optInMatch = /^\/api\/daily-briefing\/opt-in\/([^/]+)$/.exec(url);
    if (optInMatch && method === "PUT") {
      if (overrides.optInPut) return Promise.resolve(overrides.optInPut(optInMatch[1], init));
      const enabled = JSON.parse(String(init?.body)).enabled as boolean;
      return Promise.resolve(json({ memberId: optInMatch[1], enabled }));
    }
    if (url === "/api/daily-briefing/settings" && method === "GET") {
      return Promise.resolve(
        overrides.settings ? overrides.settings() : json(defaultDailyBriefingSettings())
      );
    }
    if (url === "/api/daily-briefing/generate" && method === "POST") {
      if (overrides.generate) return Promise.resolve(overrides.generate());
      const memberId = JSON.parse(String(init?.body)).memberId as string;
      return Promise.resolve(
        json({
          id: "briefing-1",
          memberId,
          date: "2026-09-10",
          status: "ready",
          payload: {
            schemaVersion: 1,
            member: { id: memberId, displayName: "" },
            date: "2026-09-10",
            blocks: [],
          },
          createdAt: 1,
          updatedAt: 1,
        })
      );
    }
    if (url === "/api/daily-briefing/block-order" && method === "PUT") {
      return Promise.resolve(json({ blockOrder: JSON.parse(String(init?.body)) }));
    }
    const blockSettingsMatch = /^\/api\/daily-briefing\/block-settings\/([^/]+)\/([^/]+)$/.exec(
      url
    );
    if (blockSettingsMatch && method === "PUT") {
      if (overrides.blockSettingsPut) {
        return Promise.resolve(
          overrides.blockSettingsPut(blockSettingsMatch[1], blockSettingsMatch[2], init)
        );
      }
      const patch = JSON.parse(String(init?.body)) as { weekdays?: unknown; enabled?: unknown };
      return Promise.resolve(
        json({
          memberId: blockSettingsMatch[1],
          blockType: blockSettingsMatch[2],
          enabled: patch.enabled ?? true,
          weekdays: patch.weekdays ?? null,
          params: null,
          updatedAt: 1,
        })
      );
    }

    throw new Error(`unexpected fetch: ${url} (${method})`);
  });

  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

function renderDailyBriefing() {
  return render(
    <LanguageProvider>
      <DailyBriefingManagement />
    </LanguageProvider>
  );
}

describe("DailyBriefingManagement — the panel is a real landmark (FR-009 L2-adoption clause)", () => {
  it("exposes an AdminPanel region AND heading, both named for the panel title", async () => {
    mockDailyBriefingBackend();
    renderDailyBriefing();

    await screen.findByTestId("daily-briefing-opt-in-member-ada");

    const region = await screen.findByRole("region", { name: "Daily Briefing" });
    const heading = within(region).getByRole("heading", { name: "Daily Briefing" });
    expect(heading).toBeInTheDocument();
  });
});

describe("DailyBriefingManagement — every opt-in checkbox carries a DISTINCT accessible name (Codex review on #812)", () => {
  it("names each member's checkbox with the member's own name, so two rows never announce identically", async () => {
    mockDailyBriefingBackend();
    renderDailyBriefing();

    const ada = await screen.findByTestId("daily-briefing-opt-in-member-ada");
    const ben = await screen.findByTestId("daily-briefing-opt-in-member-ben");

    // Pre-fix, both computed to the bare visible label ("Enabled") — indistinguishable to
    // assistive technology with more than one member listed. The name must compose the two
    // VISIBLE texts (member name + state word), mirroring what sighted users see.
    expect(ada).toHaveAccessibleName("Ada: Enabled");
    expect(ben).toHaveAccessibleName("Ben: Enabled");
  });
});

describe("DailyBriefingManagement — kiosk density across reachable states (SC-001, SC-002)", () => {
  it("meets kiosk density collapsed, opted-in, block-order added, then removed (CENSUS FIRES ON REMOVAL)", async () => {
    const mockFetch = mockDailyBriefingBackend();
    const uninject = await injectDensityStyles({
      extraCandidates: ["size-[var(--control-height)]"],
    });
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderDailyBriefing();
      await screen.findByTestId("daily-briefing-opt-in-member-ada");

      // Phase 1 — Blocks workspace: the first member is selected immediately, so the complete
      // 21-row matrix is visible with its drag handles, enabled controls, weekday cells, and
      // applicable parameter selects, alongside the workspace/settings/order controls.
      expect(countInteractiveControls(document.body)).toBe(212);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // Phase 2 — Preview / Generate workspace: opt Ada in and expose the Generate panel's
      // compatibility member-select, Generate, and Generate-all controls.
      fireEvent.click(screen.getByTestId("daily-briefing-tab-preview"));
      fireEvent.click(screen.getByTestId("daily-briefing-opt-in-member-ada"));
      await waitFor(() => {
        expect(
          (mockFetch.mock.calls as FetchCall[]).some(
            ([input, init]) =>
              String(input) === "/api/daily-briefing/opt-in/member-ada" && init?.method === "PUT"
          )
        ).toBe(true);
      });
      await screen.findByTestId("daily-briefing-member-select");
      expect(countInteractiveControls(document.body)).toBe(12);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // Phase 3 — add one block-order entry: the list appears with its 3 per-item action buttons
      // (up/down/remove — up starts disabled at index 0, but a disabled, mounted control still
      // counts, per the census convention every other batch's spec uses).
      fireEvent.click(screen.getByTestId("daily-briefing-tab-blocks"));
      const addSelect = screen.getByTestId("daily-briefing-admin-block-order-add-select");
      fireEvent.change(addSelect, { target: { value: "dadJoke" } });
      fireEvent.click(screen.getByTestId("daily-briefing-admin-block-order-add-button"));
      expect(countInteractiveControls(document.body)).toBe(215);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // Phase 4 — CENSUS FIRES ON REMOVAL: removing that same entry drops its 3 per-item action
      // buttons back out (215 -> 212) — a census that failed to actually recompute (a stale/
      // memoized count) would still read 215 here.
      fireEvent.click(screen.getByTestId("daily-briefing-admin-block-order-remove-0"));
      await waitFor(() =>
        expect(
          screen.queryByTestId("daily-briefing-admin-block-order-item-0")
        ).not.toBeInTheDocument()
      );
      expect(countInteractiveControls(document.body)).toBe(212);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("DELIBERATE NEGATIVE — forcing this surface's own settings Save button below the kiosk minimum makes the assertion fail", async () => {
    mockDailyBriefingBackend();
    const uninject = await injectDensityStyles({
      extraCandidates: ["size-[var(--control-height)]"],
    });
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = renderDailyBriefing();
      const saveButton = await screen.findByTestId("daily-briefing-admin-settings-save");

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

      saveButton.style.height = "";
      saveButton.style.fontSize = "";
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });
});

describe("DailyBriefingManagement — error states are announced (SC-011)", () => {
  it("announces a members/opt-in load failure through ErrorNotice's live region", async () => {
    mockDailyBriefingBackend({ members: () => new Response(null, { status: 500 }) });
    renderDailyBriefing();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(alert).toHaveTextContent("Failed to load members.");
  });

  it("announces a settings-save validation failure through the settings card's own ErrorNotice", async () => {
    const mockFetch = mockDailyBriefingBackend();
    renderDailyBriefing();
    await screen.findByTestId("daily-briefing-admin-generation-time");

    mockFetch.mockImplementation((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      if (url === "/api/settings") {
        return Promise.resolve(json({ locale: { timezone: "UTC", language: "en" } }));
      }
      if (url === "/api/daily-briefing/settings" && init?.method === "PUT") {
        return Promise.resolve(
          json({ error: "validation_error", message: 'Invalid generationTime "99:99"' }, 400)
        );
      }
      throw new Error(`unexpected fetch after override: ${url}`);
    });

    fireEvent.click(screen.getByTestId("daily-briefing-admin-settings-save"));

    const alert = await screen.findByTestId("daily-briefing-admin-settings-error");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(alert).toHaveClass("text-destructive");
    expect(alert).toHaveTextContent("Failed to save Daily Briefing settings.");
  });

  it("announces the settings-load failure through the block-order AND block-settings cards' own ErrorNotice (routed off the shared component now, closing #758's per-site debt)", async () => {
    mockDailyBriefingBackend({ settings: () => json({ error: "internal_error" }, 500) });
    renderDailyBriefing();

    const blockOrderAlert = await screen.findByTestId(
      "daily-briefing-admin-block-order-load-error"
    );
    expect(blockOrderAlert).toHaveAttribute("role", "alert");
    expect(blockOrderAlert).toHaveAttribute("aria-live", "assertive");

    const blockSettingsAlert = await screen.findByTestId(
      "daily-briefing-admin-block-settings-load-error"
    );
    expect(blockSettingsAlert).toHaveAttribute("role", "alert");
    expect(blockSettingsAlert).toHaveAttribute("aria-live", "assertive");
  });
});

describe("WeekdayPicker adoption (DailyBriefingManagement) — group accessible name AND canonical emission order (SC-009)", () => {
  it("labels a per-block WeekdayPicker group with the localized active-weekdays caption", async () => {
    mockDailyBriefingBackend({ language: "es" });
    renderDailyBriefing();

    fireEvent.change(
      await screen.findByTestId("daily-briefing-admin-block-settings-member-select"),
      {
        target: { value: "member-ada" },
      }
    );

    // Every block-type row renders its own WeekdayPicker with the SAME group name — scope to
    // one row (wordOfDay) rather than asserting a role that resolves to all 21.
    const row = screen.getByTestId("daily-briefing-admin-block-settings-row-wordOfDay");
    // findByRole, not getByRole: the testid anchors above are locale-independent, so the async
    // /api/settings locale fetch may not have applied "es" yet (the same race fixed in the
    // TimeAnnouncements twin of this test).
    const group = await within(row).findByRole("group", { name: "Días activos" });
    const dayLabels = within(group)
      .getAllByRole("checkbox")
      .map((checkbox) => checkbox.closest("label")?.textContent?.trim());
    expect(dayLabels).toEqual(["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]);
  });

  it("unchecking fri then mon on wordOfDay emits the canonical mon..sun-minus-those-two order at the PUT boundary, regardless of click order", async () => {
    // Mirrors the pre-existing `daily-briefing-admin.test.tsx` behavioural pin, but asserts
    // through the SHARED component's own adoption rather than the surface's hand-rolled loop —
    // the falsifier this module's DoD calls for is the shared picker itself, not a replica.
    const mockFetch = mockDailyBriefingBackend();
    renderDailyBriefing();

    fireEvent.change(
      await screen.findByTestId("daily-briefing-admin-block-settings-member-select"),
      {
        target: { value: "member-ada" },
      }
    );

    fireEvent.click(screen.getByTestId("daily-briefing-admin-block-weekday-wordOfDay-fri"));
    await waitFor(() => {
      const put = mockFetch.mock.calls.find(
        ([input, init]) =>
          String(input) === "/api/daily-briefing/block-settings/member-ada/wordOfDay" &&
          init?.method === "PUT"
      );
      expect(put, "the first weekday PUT must have fired").toBeTruthy();
      const body = JSON.parse(String(put![1]!.body));
      expect(body.weekdays).toEqual(["mon", "tue", "wed", "thu", "sat", "sun"]);
    });

    fireEvent.click(screen.getByTestId("daily-briefing-admin-block-weekday-wordOfDay-mon"));
    await waitFor(() => {
      const puts = mockFetch.mock.calls.filter(
        ([input, init]) =>
          String(input) === "/api/daily-briefing/block-settings/member-ada/wordOfDay" &&
          init?.method === "PUT"
      );
      const last = puts[puts.length - 1];
      const body = JSON.parse(String(last![1]!.body));
      expect(body.weekdays, "emission must be canonical, not click order").toEqual([
        "tue",
        "wed",
        "thu",
        "sat",
        "sun",
      ]);
    });

    // RE-CHECK fri — the step that makes click order distinguishable. Unchecking from an
    // already-canonical set preserves order under ANY implementation (independent review on this
    // proved the two assertions above stay green under an insertion-order mutant); a re-added
    // day lands LAST under insertion order, so this final assertion is the one that actually
    // fails on the mutant: fri must come back BEFORE sat/sun, not appended.
    fireEvent.click(screen.getByTestId("daily-briefing-admin-block-weekday-wordOfDay-fri"));
    await waitFor(() => {
      const puts = mockFetch.mock.calls.filter(
        ([input, init]) =>
          String(input) === "/api/daily-briefing/block-settings/member-ada/wordOfDay" &&
          init?.method === "PUT"
      );
      const last = puts[puts.length - 1];
      const body = JSON.parse(String(last![1]!.body));
      expect(body.weekdays, "a re-added day must slot into canonical position, not append").toEqual(
        ["tue", "wed", "thu", "fri", "sat", "sun"]
      );
    });
  });
});

describe("DailyBriefingManagement — WEEKDAY_LABEL_KEYS maps each weekday to its OWN translation key (SC-007's cast removal, pinned)", () => {
  it("every weekday maps to its own key, by ITERATING the map", () => {
    const keys = Object.keys(
      DAILY_BRIEFING_WEEKDAY_LABEL_KEYS
    ) as (keyof typeof DAILY_BRIEFING_WEEKDAY_LABEL_KEYS)[];
    expect(keys.length).toBe(7);
    for (const k of keys) {
      expect(DAILY_BRIEFING_WEEKDAY_LABEL_KEYS[k], `weekday "${k}" maps to the wrong key`).toBe(
        `dailyBriefing.admin.weekday.${k}`
      );
    }
  });
});
