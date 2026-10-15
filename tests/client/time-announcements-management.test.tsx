import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/i18n";
import { testVoice, voiceNameFor } from "@/time-announcements/speech";
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
  voiceNameFor: vi.fn(() => null),
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

function openCreateDialog() {
  fireEvent.click(screen.getByTestId("time-announcements-create"));
  return screen.getByTestId("time-announcements-form-dialog");
}

function renderManagement() {
  render(
    <LanguageProvider>
      <TimeAnnouncementsManagement />
    </LanguageProvider>
  );
}

describe("TimeAnnouncementsManagement", () => {
  beforeEach(() => {
    currentSettings = { timezone: "Europe/Madrid", language: "en", weekStartDay: 1 };
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(testVoice).mockClear();
    vi.mocked(voiceNameFor).mockReset().mockReturnValue(null);
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
    expect(morningRow).not.toHaveTextContent("Inactive");

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

    openCreateDialog();
    expect(screen.getByTestId("time-announcements-time-input")).toHaveValue("07:00");
    fireEvent.click(screen.getByTestId("time-announcements-weekday-mon"));
    fireEvent.click(screen.getByTestId("time-announcements-weekday-tue"));

    fireEvent.click(screen.getByTestId("time-announcements-submit"));

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

    await waitFor(() =>
      expect(screen.queryByTestId("time-announcements-form-dialog")).not.toBeInTheDocument()
    );
    await screen.findByTestId("time-announcements-rule-rule-morning");
    expect(changedListener).toHaveBeenCalledTimes(1);

    window.removeEventListener(RULES_CHANGED_EVENT, changedListener);
  });

  it("the dialog submit stays disabled until a time and at least one weekday are set", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async () => jsonResponse([]));

    renderManagement();
    await screen.findByTestId("time-announcements-empty");

    openCreateDialog();
    const submit = screen.getByTestId("time-announcements-submit");
    expect(submit).toBeDisabled();

    fireEvent.click(screen.getByTestId("time-announcements-weekday-mon"));
    expect(submit).not.toBeDisabled();

    fireEvent.change(screen.getByTestId("time-announcements-time-input"), {
      target: { value: "" },
    });
    expect(submit).toBeDisabled();
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
    expect(screen.getByTestId("time-announcements-time-input")).toHaveValue("07:00");
    expect(screen.getByTestId("time-announcements-weekday-mon")).toBeChecked();

    fireEvent.change(screen.getByTestId("time-announcements-time-input"), {
      target: { value: "08:00" },
    });
    // Deselect every day but mon (rule-morning starts mon..fri).
    for (const day of ["tue", "wed", "thu", "fri"]) {
      fireEvent.click(screen.getByTestId(`time-announcements-weekday-${day}`));
    }
    fireEvent.click(screen.getByTestId("time-announcements-active-checkbox"));

    fireEvent.click(screen.getByTestId("time-announcements-submit"));

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
    const confirmSpy = vi.spyOn(window, "confirm");
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
    const dialog = await screen.findByRole("dialog", { name: "Delete announcement" });
    expect(dialog).toHaveTextContent("Delete this time announcement rule?");
    fireEvent.click(screen.getByTestId("time-announcements-delete-confirm"));

    await waitFor(() => {
      expect(screen.queryByTestId("time-announcements-rule-rule-morning")).not.toBeInTheDocument();
    });
    expect(
      mockFetch.mock.calls.some(
        ([input, init]) =>
          String(input) === "/api/time-announcements/rule-morning" && init?.method === "DELETE"
      )
    ).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("does NOT delete when the confirm dialog is dismissed", async () => {
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
    const dialog = await screen.findByRole("dialog", { name: "Delete announcement" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Delete announcement" })).not.toBeInTheDocument()
    );
    expect(
      mockFetch.mock.calls.some(
        ([input, init]) => String(input).includes("rule-morning") && init?.method === "DELETE"
      )
    ).toBe(false);
    expect(screen.getByTestId("time-announcements-rule-rule-morning")).toBeInTheDocument();
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

    openCreateDialog();
    fireEvent.click(screen.getByTestId("time-announcements-weekday-mon"));
    fireEvent.click(screen.getByTestId("time-announcements-submit"));

    expect(await screen.findByTestId("time-announcements-form-error")).toHaveTextContent(
      "An active rule already announces at this time on an overlapping weekday."
    );
    // The dialog stays open with the form intact so the admin can fix it.
    expect(screen.getByTestId("time-announcements-form-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("time-announcements-weekday-mon")).toBeChecked();
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

    openCreateDialog();
    fireEvent.click(screen.getByTestId("time-announcements-weekday-mon"));
    fireEvent.click(screen.getByTestId("time-announcements-submit"));

    expect(await screen.findByTestId("time-announcements-form-error")).toHaveTextContent(
      "The rule settings are invalid. Check the time and weekdays."
    );
    expect(screen.getByTestId("time-announcements-form-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("time-announcements-weekday-mon")).toBeChecked();
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

    openCreateDialog();
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

  it("shows a spinner while loading", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(() => new Promise<Response>(() => {}));
    renderManagement();
    expect(screen.getByRole("status")).toHaveTextContent("Loading time announcements…");
  });

  it("a failed load shows the error and a Retry that reloads", async () => {
    let gets = 0;
    vi.mocked(globalThis.fetch).mockImplementation(async () => {
      gets += 1;
      return gets === 1 ? jsonResponse({ error: "boom" }, 500) : jsonResponse([RULE_MORNING]);
    });

    renderManagement();
    await screen.findByTestId("time-announcements-error");
    expect(screen.queryByTestId("time-announcements-create")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("time-announcements-retry"));

    await screen.findByTestId("time-announcements-rule-rule-morning");
    expect(screen.getByTestId("time-announcements-create")).toBeInTheDocument();
    expect(screen.queryByTestId("time-announcements-error")).not.toBeInTheDocument();
  });

  it("Cancel closes the dialog without any write", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async () => jsonResponse([]));
    renderManagement();
    await screen.findByTestId("time-announcements-empty");

    openCreateDialog();
    fireEvent.click(screen.getByTestId("time-announcements-cancel"));

    await waitFor(() =>
      expect(screen.queryByTestId("time-announcements-form-dialog")).not.toBeInTheDocument()
    );
    expect(mockFetch.mock.calls.some(([, init]) => init?.method && init.method !== "GET")).toBe(
      false
    );
  });

  it("shows the selected voice name, or a no-voice hint", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async () => jsonResponse([]));
    vi.mocked(voiceNameFor).mockReturnValue("Monica");
    renderManagement();
    await screen.findByTestId("time-announcements-empty");

    openCreateDialog();
    expect(screen.getByTestId("time-announcements-voice")).toHaveTextContent("Voice: Monica");
    expect(vi.mocked(voiceNameFor)).toHaveBeenCalledWith("en");

    fireEvent.click(screen.getByTestId("time-announcements-cancel"));
    await waitFor(() =>
      expect(screen.queryByTestId("time-announcements-form-dialog")).not.toBeInTheDocument()
    );
    vi.mocked(voiceNameFor).mockReturnValue(null);
    openCreateDialog();
    expect(screen.getByTestId("time-announcements-voice")).toHaveTextContent(
      "No voice available for this language"
    );
  });

  it("inactive rules are dimmed and tagged", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async () =>
      jsonResponse([RULE_MORNING, RULE_EVENING_INACTIVE])
    );
    renderManagement();
    const evening = await screen.findByTestId("time-announcements-rule-rule-evening");
    const morning = await screen.findByTestId("time-announcements-rule-rule-morning");

    expect(within(evening).getByText("20:00").className).toContain("opacity-60");
    expect(within(morning).getByText("07:00").className).not.toContain("opacity-60");
    expect(evening).toHaveTextContent("Inactive");
  });

  it("weekday circles show initials and on/off state", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async () => jsonResponse([RULE_MORNING]));
    renderManagement();
    const row = await screen.findByTestId("time-announcements-rule-rule-morning");

    const circles = within(row).getAllByTestId(/^time-announcements-day-/);
    expect(circles).toHaveLength(7);
    expect(circles.map((c) => c.getAttribute("data-on"))).toEqual([
      "true",
      "true",
      "true",
      "true",
      "true",
      "false",
      "false",
    ]);
    expect(circles.map((c) => c.textContent).join("")).toBe("MTWTFSS");
    expect(row).toHaveTextContent("Mon, Tue, Wed, Thu, Fri");
  });

  it("weekday circles follow a Sunday-first household week", async () => {
    currentSettings.weekStartDay = 0;
    vi.mocked(globalThis.fetch).mockImplementation(async () =>
      jsonResponse([{ ...RULE_MORNING, weekDays: ["mon", "sun"] }])
    );
    renderManagement();
    const row = await screen.findByTestId("time-announcements-rule-rule-morning");

    const circles = within(row).getAllByTestId(/^time-announcements-day-/);
    expect(circles.map((c) => c.textContent).join("")).toBe("SMTWTFS");
    expect(circles.map((c) => c.getAttribute("data-on"))).toEqual([
      "true",
      "true",
      "false",
      "false",
      "false",
      "false",
      "false",
    ]);
    expect(row).toHaveTextContent("Sun, Mon");
  });

  it("closing is blocked while a save is in flight", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (...args: FetchCall) => {
      const [, init] = args;
      if (init?.method === "POST") return new Promise<Response>(() => {});
      return jsonResponse([]);
    });
    renderManagement();
    await screen.findByTestId("time-announcements-empty");

    openCreateDialog();
    fireEvent.click(screen.getByTestId("time-announcements-weekday-mon"));
    fireEvent.click(screen.getByTestId("time-announcements-submit"));
    await waitFor(() => expect(screen.getByTestId("time-announcements-submit")).toBeDisabled());

    fireEvent.keyDown(screen.getByTestId("time-announcements-form-dialog"), { key: "Escape" });

    expect(screen.getByTestId("time-announcements-form-dialog")).toBeInTheDocument();
  });
});

it.each(["en", "es"] as const)(
  "localizes browser exceptions on rule creation (%s)",
  async (language) => {
    currentSettings.language = language;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init) => {
        if (init?.method === "POST") throw new TypeError("Failed to fetch private diagnostics");
        return jsonResponse([]);
      })
    );
    try {
      renderManagement();
      await screen.findByRole("button", { name: language === "es" ? "Crear" : "Create" });
      fireEvent.click(screen.getByTestId("time-announcements-create"));
      fireEvent.change(screen.getByTestId("time-announcements-time-input"), {
        target: { value: "07:00" },
      });
      fireEvent.click(screen.getByTestId("time-announcements-weekday-mon"));
      fireEvent.click(screen.getByTestId("time-announcements-submit"));
      const notice = await screen.findByTestId("time-announcements-form-error");
      expect(notice).toHaveTextContent(
        language === "es" ? "Error al crear esta regla." : "Failed to create this rule."
      );
      expect(notice).not.toHaveTextContent("private diagnostics");
    } finally {
      cleanup();
      vi.unstubAllGlobals();
    }
  }
);
