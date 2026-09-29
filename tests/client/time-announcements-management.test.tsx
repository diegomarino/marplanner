import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/i18n";
import { testVoice } from "@/time-announcements/speech";
import { RULES_CHANGED_EVENT } from "@/time-announcements/events";
import { TimeAnnouncementsManagement } from "@/admin/TimeAnnouncementsManagement";
import type { TimeAnnouncementRule } from "../../src/shared";

/** — TimeAnnouncementsManagement admin panel jsdom tests (house pattern:
 * useT/authFetch/controlled inputs, see e.g. `tests/client/daily-briefing-management.test.tsx`
 * / `tests/client/reminders-management.test.tsx`).
 * `@/lib/householdSettings` is mocked so `LanguageProvider` (D3: consumes the parent settings
 * context when one exists) and the panel's own `useHouseholdSettings` read BOTH resolve
 * synchronously to a fixed household language — no real `/api/settings` fetch, no timing
 * dependency on the US0 hoist. `@/time-announcements/speech`'s `testVoice` is mocked so the
 * "Test-voice speaks the unsaved time, no POST" assertion doesn't depend on jsdom's
 * (absent) Web Speech API.
 * (Traces: TIME-ANNOUNCEMENTS-INV-05 — surface half, TIME-ANNOUNCEMENTS-AC-07 — panel half;
 * FR-005, FR-006, FR-013, FR-014)
 */

let currentSettings: {
  timezone: string | null;
  language: string | null;
  weekStartDay: number | null;
} = { timezone: "Europe/Madrid", language: "en", weekStartDay: 1 };

vi.mock("@/lib/householdSettings", () => ({
  useHouseholdSettings: () => currentSettings,
  useHouseholdSettingsContext: () => currentSettings,
}));

vi.mock("@/time-announcements/speech", () => ({
  testVoice: vi.fn(),
}));

type FetchCall = Parameters<typeof globalThis.fetch>;

const RULE_MORNING: TimeAnnouncementRule = {
  id: "rule-morning",
  time: "07:00",
  weekDays: ["mon", "tue", "wed", "thu", "fri"],
  isActive: true,
  createdAt: 1,
  updatedAt: 1,
};

const RULE_EVENING_INACTIVE: TimeAnnouncementRule = {
  id: "rule-evening",
  time: "20:00",
  weekDays: ["sat", "sun"],
  isActive: false,
  createdAt: 1,
  updatedAt: 1,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function renderManagement() {
  render(
    <LanguageProvider>
      <TimeAnnouncementsManagement />
    </LanguageProvider>
  );
}

describe("TimeAnnouncementsManagement (slice-015 T009)", () => {
  beforeEach(() => {
    currentSettings = { timezone: "Europe/Madrid", language: "en", weekStartDay: 1 };
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(testVoice).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("lists ALL rules (inactive included) ordered by time, as returned by the server", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input] = args;
      if (String(input) === "/api/time-announcements")
        return jsonResponse([RULE_MORNING, RULE_EVENING_INACTIVE]);
      throw new Error(`unexpected fetch: ${String(input)}`);
    });

    renderManagement();

    const morningRow = await screen.findByTestId("time-announcements-rule-rule-morning");
    const eveningRow = await screen.findByTestId("time-announcements-rule-rule-evening");
    expect(morningRow).toHaveTextContent("07:00");
    expect(eveningRow).toHaveTextContent("20:00");
    expect(eveningRow).toHaveTextContent("Inactive");

    // Server-returned order preserved (no client re-sort): morning before evening in the DOM.
    const rows = screen.getAllByTestId(/^time-announcements-rule-/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "time-announcements-rule-rule-morning",
      "time-announcements-rule-rule-evening",
    ]);
  });

  it("renders the empty state when no rules exist", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async () => jsonResponse([]));

    renderManagement();

    expect(await screen.findByText("No time announcement rules yet.")).toBeInTheDocument();
  });

  it("creates a rule via POST, refreshes the list, and dispatches the rules-changed event", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    let created = false;
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input, init] = args;
      const url = String(input);
      if (url === "/api/time-announcements" && (!init || init.method === undefined)) {
        return jsonResponse(created ? [RULE_MORNING] : []);
      }
      if (url === "/api/time-announcements" && init?.method === "POST") {
        created = true;
        return jsonResponse(RULE_MORNING, 201);
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    });

    const changedListener = vi.fn();
    window.addEventListener(RULES_CHANGED_EVENT, changedListener);

    renderManagement();
    await screen.findByTestId("time-announcements-empty");

    fireEvent.change(screen.getByTestId("time-announcements-time-input"), {
      target: { value: "07:00" },
    });
    fireEvent.click(screen.getByTestId("time-announcements-weekday-mon"));
    fireEvent.click(screen.getByTestId("time-announcements-weekday-tue"));

    fireEvent.click(screen.getByTestId("time-announcements-create"));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/time-announcements",
        expect.objectContaining({
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ time: "07:00", weekDays: ["mon", "tue"], isActive: true }),
        })
      );
    });

    await screen.findByTestId("time-announcements-rule-rule-morning");
    expect(changedListener).toHaveBeenCalledTimes(1);

    window.removeEventListener(RULES_CHANGED_EVENT, changedListener);
  });

  it("the Create button stays disabled until a time and at least one weekday are set", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async () => jsonResponse([]));

    renderManagement();
    await screen.findByTestId("time-announcements-empty");

    const createButton = screen.getByTestId("time-announcements-create");
    expect(createButton).toBeDisabled();

    fireEvent.change(screen.getByTestId("time-announcements-time-input"), {
      target: { value: "07:00" },
    });
    expect(createButton).toBeDisabled();

    fireEvent.click(screen.getByTestId("time-announcements-weekday-mon"));
    expect(createButton).not.toBeDisabled();
  });

  it("edits a rule via PATCH with the edited time/weekdays/isActive", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    let current = RULE_MORNING;
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input, init] = args;
      const url = String(input);
      if (url === "/api/time-announcements" && !init?.method) {
        return jsonResponse([current]);
      }
      if (url === "/api/time-announcements/rule-morning" && init?.method === "PATCH") {
        current = { ...current, time: "08:00", weekDays: ["mon"], isActive: false };
        return jsonResponse(current);
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    });

    renderManagement();
    await screen.findByTestId("time-announcements-rule-rule-morning");

    fireEvent.click(screen.getByTestId("time-announcements-edit-rule-morning"));

    fireEvent.change(screen.getByTestId("time-announcements-edit-time-rule-morning"), {
      target: { value: "08:00" },
    });
    // Deselect every day but mon (rule-morning starts mon..fri).
    for (const day of ["tue", "wed", "thu", "fri"]) {
      fireEvent.click(screen.getByTestId(`time-announcements-edit-weekday-rule-morning-${day}`));
    }
    fireEvent.click(screen.getByTestId("time-announcements-edit-active-rule-morning"));

    fireEvent.click(screen.getByTestId("time-announcements-save-rule-morning"));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/time-announcements/rule-morning",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ time: "08:00", weekDays: ["mon"], isActive: false }),
        })
      );
    });

    const row = await screen.findByTestId("time-announcements-rule-rule-morning");
    expect(row).toHaveTextContent("08:00");
    expect(row).toHaveTextContent("Inactive");
  });

  it("toggles active via a PATCH carrying only the inverted isActive value", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    let current = RULE_MORNING;
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input, init] = args;
      const url = String(input);
      if (url === "/api/time-announcements" && !init?.method) {
        return jsonResponse([current]);
      }
      if (url === "/api/time-announcements/rule-morning" && init?.method === "PATCH") {
        expect(init.body).toBe(JSON.stringify({ isActive: false }));
        current = { ...current, isActive: false };
        return jsonResponse(current);
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    });

    renderManagement();
    await screen.findByTestId("time-announcements-rule-rule-morning");

    fireEvent.click(screen.getByTestId("time-announcements-toggle-rule-morning"));

    await waitFor(() => {
      const row = screen.getByTestId("time-announcements-rule-rule-morning");
      expect(row).toHaveTextContent("Inactive");
    });
  });

  it("deletes a rule via DELETE after confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const mockFetch = vi.mocked(globalThis.fetch);
    let deleted = false;
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input, init] = args;
      const url = String(input);
      if (url === "/api/time-announcements" && !init?.method) {
        return jsonResponse(deleted ? [] : [RULE_MORNING]);
      }
      if (url === "/api/time-announcements/rule-morning" && init?.method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    });

    renderManagement();
    await screen.findByTestId("time-announcements-rule-rule-morning");

    fireEvent.click(screen.getByTestId("time-announcements-delete-rule-morning"));

    await waitFor(() => {
      expect(screen.queryByTestId("time-announcements-rule-rule-morning")).not.toBeInTheDocument();
    });
    expect(confirmSpy).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("does NOT delete when the confirm dialog is dismissed", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input, init] = args;
      const url = String(input);
      if (url === "/api/time-announcements" && !init?.method) return jsonResponse([RULE_MORNING]);
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    });

    renderManagement();
    await screen.findByTestId("time-announcements-rule-rule-morning");

    fireEvent.click(screen.getByTestId("time-announcements-delete-rule-morning"));

    expect(
      mockFetch.mock.calls.some(
        ([input, init]) => String(input).includes("rule-morning") && init?.method === "DELETE"
      )
    ).toBe(false);
    expect(screen.getByTestId("time-announcements-rule-rule-morning")).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("surfaces the server's 409 active-overlap message (naming the conflicting rule) on create", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    const overlapMessage =
      'Active rule "rule-morning" already announces at 07:00 on an overlapping weekday';
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input, init] = args;
      const url = String(input);
      if (url === "/api/time-announcements" && !init?.method) return jsonResponse([RULE_MORNING]);
      if (url === "/api/time-announcements" && init?.method === "POST") {
        return jsonResponse({ error: "active_overlap", message: overlapMessage }, 409);
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    });

    renderManagement();
    await screen.findByTestId("time-announcements-rule-rule-morning");

    fireEvent.change(screen.getByTestId("time-announcements-time-input"), {
      target: { value: "07:00" },
    });
    fireEvent.click(screen.getByTestId("time-announcements-weekday-mon"));
    fireEvent.click(screen.getByTestId("time-announcements-create"));

    expect(await screen.findByTestId("time-announcements-error")).toHaveTextContent(overlapMessage);
  });

  it("surfaces the server's 400 validation message on create", async () => {
    // The native <input type="time"> constrains typed input to a valid shape (jsdom
    // sanitizes an unparsable value back to empty, mirroring real browser behavior) — a
    // 400 can still reach this panel for a reason the client form doesn't itself guard
    // (e.g. a stricter server-side rule), so this asserts the panel surfaces WHATEVER
    // message the server sends back on a 400, not that the client can produce one.
    const mockFetch = vi.mocked(globalThis.fetch);
    const validationMessage = "Unsupported field(s) in rule body: extra";
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input, init] = args;
      const url = String(input);
      if (url === "/api/time-announcements" && !init?.method) return jsonResponse([]);
      if (url === "/api/time-announcements" && init?.method === "POST") {
        return jsonResponse({ error: "validation_error", message: validationMessage }, 400);
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    });

    renderManagement();
    await screen.findByTestId("time-announcements-empty");

    fireEvent.change(screen.getByTestId("time-announcements-time-input"), {
      target: { value: "07:00" },
    });
    fireEvent.click(screen.getByTestId("time-announcements-weekday-mon"));
    fireEvent.click(screen.getByTestId("time-announcements-create"));

    expect(await screen.findByTestId("time-announcements-error")).toHaveTextContent(
      validationMessage
    );
  });

  it("Test-voice speaks the UNSAVED form time via the speech seam and performs NO POST (FR-014)", async () => {
    currentSettings = { timezone: "Europe/Madrid", language: "es", weekStartDay: 1 };
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input, init] = args;
      const url = String(input);
      if (url === "/api/time-announcements" && !init?.method) return jsonResponse([]);
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    });

    renderManagement();
    await screen.findByTestId("time-announcements-empty");

    fireEvent.change(screen.getByTestId("time-announcements-time-input"), {
      target: { value: "17:45" },
    });
    // No weekday selected, no create click — Test-voice must work independent of the
    // create form's own validity gate.
    fireEvent.click(screen.getByTestId("time-announcements-test-voice"));

    expect(vi.mocked(testVoice)).toHaveBeenCalledWith("17:45", "es");
    // Tightened: no call of ANY write method — not just "no POST specifically" —
    // reached fetch. Every call this panel makes is either the initial GET (method undefined,
    // since authFetch's plain read omits it) or a write; asserting the full non-read set is a
    // stronger proof than singling out POST.
    expect(
      mockFetch.mock.calls.some(([, init]) => {
        const method = init?.method;
        return method !== undefined && method !== "GET";
      })
    ).toBe(false);
  });
});
