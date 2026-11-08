import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CalendarManagement } from "@/admin/CalendarManagement";
import { LanguageProvider } from "@/i18n";
import { resolveHouseholdRoute } from "@/shell/routes";
import { adminRoutes } from "@/admin/AdminRoutes";
import type { ExternalSourcePublic, HighlightRule } from "../../src/shared";

const householdSettings = { timezone: "Europe/Madrid", language: "en", weekStartDay: 1 };
vi.mock("@/lib/householdSettings", () => ({
  useHouseholdSettings: () => householdSettings,
  useHouseholdSettingsContext: () => householdSettings,
}));

const source: ExternalSourcePublic = {
  id: "source-1",
  name: "School",
  provider: "google",
  maskedUrl: "https://calendar.example/•••",
  enabled: true,
  pollIntervalMin: 15,
  phase: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastErrorCode: null,
  consecutiveFailures: 0,
  lastImportedCount: 0,
  lastSkippedCount: 0,
};
const rules: HighlightRule[] = [
  { id: "one", emoji: "⚽", keywords: ["football"], enabled: true, priority: 0 },
  { id: "two", emoji: "🎵", keywords: ["music"], enabled: true, priority: 1 },
  { id: "three", emoji: "🎂", keywords: ["birthday"], enabled: true, priority: 2 },
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function renderPage() {
  render(
    <LanguageProvider>
      <CalendarManagement />
    </LanguageProvider>
  );
}

describe("Admin Calendar sources", () => {
  beforeEach(() => {
    householdSettings.language = "en";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json([]))
    );
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("registers the protected route and renders the v1 two-column composition", async () => {
    expect(resolveHouseholdRoute("/admin/calendar").kind).toBe("admin");
    expect(adminRoutes.some((route) => route.path === "/admin/calendar")).toBe(true);
    renderPage();
    expect(
      screen.getByRole("heading", { level: 1, name: "Calendar Management" })
    ).toBeInTheDocument();
    const grid = screen.getByTestId("calendar-admin-grid");
    expect(grid.className).toContain("lg:grid-cols-2");
    expect(within(grid).getByRole("region", { name: "External Calendars" })).toBeInTheDocument();
    expect(within(grid).getByRole("region", { name: "Emoji Highlights" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/poll.*interval/i)).not.toBeInTheDocument();
  });

  it("creates a source with a fixed 15-minute interval and keeps failed first sync retryable", async () => {
    // Fake timers skip the 1 s poll interval; shouldAdvanceTime keeps waitFor working.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls: Array<[string, string, unknown]> = [];
    let current = [] as ExternalSourcePublic[];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push([url, method, init?.body ? JSON.parse(String(init.body)) : null]);
        if (method === "PUT") {
          current = [{ ...source, phase: "requesting" }];
          return json(current[0], 202);
        }
        if (method === "POST") return json({ ...source, phase: "requesting" }, 202);
        if (url.endsWith("/external-sources")) return json(current);
        throw new Error(`unexpected ${method} ${url}`);
      })
    );
    renderPage();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: " School " } });
    fireEvent.change(screen.getByLabelText("Feed URL"), {
      target: { value: " https://calendar.example/private.ics " },
    });
    // The provider is not asked for: the server reads it from the feed's host.
    expect(screen.queryByLabelText("Provider")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    await waitFor(() => expect(screen.getByText("School")).toBeInTheDocument());
    expect(calls.find((call) => call[1] === "PUT")?.[2]).toEqual({
      name: "School",
      feedUrl: "https://calendar.example/private.ics",
      pollIntervalMin: 15,
    });
    expect(screen.getByLabelText("Name")).toHaveValue("");
    expect(screen.getByLabelText("Feed URL")).toHaveValue("");
    expect(screen.getByText("Requesting feed…")).toBeInTheDocument();
    current = [{ ...source, phase: "failed", lastErrorCode: "timeout" }];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(screen.getByText("The feed request timed out.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(calls.filter((call) => call[1] === "POST")).toHaveLength(1));
  });

  it("keeps toggle, sync, and confirmed delete as separate actions", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push(`${method} ${url}`);
        if (method === "PATCH") return json({ ...source, enabled: false });
        if (method === "DELETE") return json(null);
        if (url.endsWith("/external-sources")) return json([source]);
        return json(source);
      })
    );
    renderPage();
    const enabled = await screen.findByRole("checkbox", { name: "Enabled" });
    fireEvent.click(enabled);
    await waitFor(() => expect(calls.some((call) => call.startsWith("PATCH "))).toBe(true));
    expect(calls.some((call) => call.startsWith("DELETE "))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete source" }));
    expect(screen.getByRole("dialog", { name: "Delete School?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(calls.some((call) => call.startsWith("DELETE "))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete source" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls.some((call) => call.startsWith("DELETE "))).toBe(true));
  });

  it("polls only active phases and refreshes Calendar events after success", async () => {
    // Fake timers skip the 1 s poll interval; shouldAdvanceTime keeps waitFor working.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let current: ExternalSourcePublic[] = [{ ...source, phase: "parsing" }];
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/highlight-rules")) return json([]);
        if (url.includes("/api/calendar/events?")) return json([]);
        return json(current);
      })
    );
    renderPage();
    expect(await screen.findByText("Parsing events…")).toBeInTheDocument();
    current = [{ ...source, phase: "succeeded", lastSuccessAt: Date.now() }];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(screen.getByText("Calendar updated")).toBeInTheDocument();
    expect(calls.some((url) => url.includes("/api/calendar/events?"))).toBe(true);
    const sourceReads = calls.filter((url) => url.endsWith("/external-sources")).length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(calls.filter((url) => url.endsWith("/external-sources"))).toHaveLength(sourceReads);
  });

  it("uses the household language for the durable success time", async () => {
    householdSettings.language = "es";
    const lastSuccessAt = Date.UTC(2026, 8, 28, 12, 0);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0]) =>
        json(String(input).endsWith("/highlight-rules") ? [] : [{ ...source, lastSuccessAt }])
      )
    );
    renderPage();
    expect(
      await screen.findByText("Última actualización correcta:", { exact: false })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        new Intl.DateTimeFormat("es-ES", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: "Europe/Madrid",
        }).format(lastSuccessAt),
        { exact: false }
      )
    ).toBeInTheDocument();
  });

  it("keeps enabled toggles and drag handles at kiosk density", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) =>
        json(
          String(input).endsWith("/external-sources")
            ? [source]
            : String(input).endsWith("/highlight-rules")
              ? rules
              : []
        )
      )
    );
    const { injectDensityStyles } = await import("./helpers/densityStyles");
    const { assertKioskDensityCompliant } = await import("./helpers/density");
    const uninject = await injectDensityStyles({
      extraCandidates: ["size-[var(--control-height)]"],
    });
    document.documentElement.setAttribute("data-density", "kiosk");
    try {
      renderPage();
      await screen.findByTestId("external-source-source-1");
      expect(screen.getAllByRole("checkbox", { name: "Enabled" }).length).toBeGreaterThan(0);
      assertKioskDensityCompliant(document.body);
    } finally {
      uninject();
      document.documentElement.removeAttribute("data-density");
    }
  });
});

describe("Admin Calendar highlights", () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  let current: HighlightRule[];
  let failReorder: boolean;
  let holdReorder: boolean;
  let releaseReorder: (() => void) | null;

  beforeEach(() => {
    householdSettings.language = "en";
    calls.length = 0;
    current = rules.map((rule) => ({ ...rule }));
    failReorder = false;
    holdReorder = false;
    releaseReorder = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
        calls.push({ url, method, body });
        if (url.endsWith("/external-sources")) return json([]);
        if (url.endsWith("/highlight-rules") && method === "GET") return json(current);
        if (url.endsWith("/highlight-rules") && method === "POST") {
          const created = {
            id: "four",
            ...(body as object),
            enabled: true,
            priority: current.length,
          } as HighlightRule;
          current = [...current, created];
          return json(created, 201);
        }
        if (url.endsWith("/highlight-rules/reorder") && method === "PUT") {
          if (holdReorder)
            await new Promise<void>((resolve) => {
              releaseReorder = resolve;
            });
          if (failReorder) return json({ error: "failure" }, 500);
          current = (body as { orderedIds: string[] }).orderedIds.map((id, priority) => ({
            ...current.find((rule) => rule.id === id)!,
            priority,
          }));
          return json(current);
        }
        if (url.includes("/highlight-rules/") && method === "PATCH") {
          current = current.map((rule) =>
            rule.id === url.split("/").pop() ? { ...rule, ...(body as object) } : rule
          );
          return json(current.find((rule) => rule.id === url.split("/").pop()));
        }
        if (url.includes("/highlight-rules/") && method === "DELETE") {
          current = current.filter((rule) => rule.id !== url.split("/").pop());
          return new Response(null, { status: 204 });
        }
        throw new Error(`unexpected ${method} ${url}`);
      })
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("creates a trimmed, deduplicated rule and keeps the source policy hidden", async () => {
    renderPage();
    await screen.findByText("⚽ football");
    fireEvent.change(screen.getByLabelText("Emoji"), { target: { value: " 🎨 " } });
    fireEvent.change(screen.getByLabelText("Keywords"), {
      target: { value: " art, , art, craft " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    await screen.findByText("🎨 art, craft");
    expect(calls.filter((call) => call.method === "POST").map((call) => call.body)).toEqual([
      { emoji: "🎨", keywords: ["art", "craft"] },
    ]);
    expect(screen.queryByLabelText(/poll.*interval/i)).not.toBeInTheDocument();
  });

  it("accepts exactly one emoji and says so before anything is sent", async () => {
    renderPage();
    await screen.findByText("⚽ football");
    const emoji = screen.getByLabelText("Emoji");
    const add = screen.getByRole("button", { name: "Add rule" });
    fireEvent.change(screen.getByLabelText("Keywords"), { target: { value: "art" } });

    // Empty is not an error yet, just not ready.
    fireEvent.change(emoji, { target: { value: "" } });
    expect(add).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(/Capitals and accents are ignored/)).toBeInTheDocument();

    for (const rejected of ["art", "🎨🎨", "🎨 art"]) {
      fireEvent.change(emoji, { target: { value: rejected } });
      expect(add, rejected).toBeDisabled();
      expect(screen.getByRole("alert")).toHaveTextContent("Use a single emoji");
      expect(emoji).toHaveAttribute("aria-invalid", "true");
    }

    // A family is several code points but one emoji.
    fireEvent.change(emoji, { target: { value: "👨‍👩‍👧" } });
    expect(add).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("keeps toggle and confirmed delete independent and restores focus on cancel", async () => {
    renderPage();
    const row = await screen.findByTestId("highlight-rule-one");
    fireEvent.click(within(row).getByRole("checkbox", { name: "Enabled" }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) => call.method === "PATCH" && (call.body as { enabled: boolean }).enabled === false
        )
      ).toBe(true)
    );
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    const deleteButton = within(row).getByRole("button", { name: "Delete rule" });
    deleteButton.focus();
    fireEvent.click(deleteButton);
    expect(screen.getByRole("dialog", { name: "Delete ⚽ rule?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(deleteButton).toHaveFocus());
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    fireEvent.click(deleteButton);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Emoji" })).toHaveFocus());
  });

  it("keyboard drag submits one complete order and announces the move", async () => {
    renderPage();
    const handle = await screen.findByRole("button", { name: "Move ⚽ rule" });
    screen.getAllByTestId(/highlight-rule-/).forEach((row, index) => {
      vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
        x: 0,
        y: index * 60,
        top: index * 60,
        left: 0,
        bottom: index * 60 + 50,
        right: 200,
        width: 200,
        height: 50,
        toJSON: () => ({}),
      });
    });
    handle.focus();
    await act(async () => {
      fireEvent.keyDown(handle, { key: "Space", code: "Space", keyCode: 32 });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      fireEvent.keyDown(handle, { key: "ArrowDown", code: "ArrowDown", keyCode: 40 });
    });
    await act(async () => {
      fireEvent.keyDown(handle, { key: "Space", code: "Space", keyCode: 32 });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() =>
      expect(calls.filter((call) => call.url.endsWith("/reorder"))).toHaveLength(1)
    );
    expect(calls.find((call) => call.url.endsWith("/reorder"))?.body).toEqual({
      orderedIds: ["two", "one", "three"],
    });
    expect(screen.getByText("Moved ⚽ rule to position 2.")).toHaveAttribute("role", "status");
  });

  it("restores authoritative order and announces a failed reorder", async () => {
    failReorder = true;
    renderPage();
    const handle = await screen.findByRole("button", { name: "Move ⚽ rule" });
    screen.getAllByTestId(/highlight-rule-/).forEach((row, index) => {
      vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
        x: 0,
        y: index * 60,
        top: index * 60,
        left: 0,
        bottom: index * 60 + 50,
        right: 200,
        width: 200,
        height: 50,
        toJSON: () => ({}),
      });
    });
    handle.focus();
    await act(async () => {
      fireEvent.keyDown(handle, { key: "Space", code: "Space", keyCode: 32 });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      fireEvent.keyDown(handle, { key: "ArrowDown", code: "ArrowDown", keyCode: 40 });
    });
    await act(async () => {
      fireEvent.keyDown(handle, { key: "Space", code: "Space", keyCode: 32 });
    });
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Could not reorder highlight rules.")
    );
    expect(
      screen.getAllByTestId(/highlight-rule-/).map((row) => row.getAttribute("data-testid"))
    ).toEqual(["highlight-rule-one", "highlight-rule-two", "highlight-rule-three"]);
  });

  it.each(["pointer", "touch"] as const)(
    "%s drag submits the same complete order once",
    async (input) => {
      renderPage();
      const handle = await screen.findByRole("button", { name: "Move ⚽ rule" });
      screen.getAllByTestId(/highlight-rule-/).forEach((row, index) => {
        vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
          x: 0,
          y: index * 60,
          top: index * 60,
          left: 0,
          bottom: index * 60 + 50,
          right: 200,
          width: 200,
          height: 50,
          toJSON: () => ({}),
        });
      });
      if (input === "pointer") {
        fireEvent.pointerDown(handle, {
          pointerId: 1,
          button: 0,
          isPrimary: true,
          clientX: 20,
          clientY: 20,
        });
        fireEvent.pointerMove(document, { pointerId: 1, clientX: 20, clientY: 90 });
        fireEvent.pointerUp(document, { pointerId: 1, clientX: 20, clientY: 90 });
      } else {
        const start = { identifier: 1, clientX: 20, clientY: 20, target: handle };
        const end = { ...start, clientY: 90 };
        fireEvent.touchStart(handle, { touches: [start], changedTouches: [start] });
        fireEvent.touchMove(handle, { touches: [end], changedTouches: [end] });
        fireEvent.touchEnd(handle, { touches: [], changedTouches: [end] });
      }
      await waitFor(() =>
        expect(calls.filter((call) => call.url.endsWith("/reorder"))).toHaveLength(1)
      );
      expect(calls.find((call) => call.url.endsWith("/reorder"))?.body).toEqual({
        orderedIds: ["two", "one", "three"],
      });
    }
  );

  it("renders the complete optimistic order while the single reorder request is pending", async () => {
    holdReorder = true;
    renderPage();
    const handle = await screen.findByRole("button", { name: "Move ⚽ rule" });
    screen.getAllByTestId(/highlight-rule-/).forEach((row, index) => {
      vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
        x: 0,
        y: index * 60,
        top: index * 60,
        left: 0,
        bottom: index * 60 + 50,
        right: 200,
        width: 200,
        height: 50,
        toJSON: () => ({}),
      });
    });
    fireEvent.pointerDown(handle, {
      pointerId: 1,
      button: 0,
      isPrimary: true,
      clientX: 20,
      clientY: 20,
    });
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 20, clientY: 90 });
    fireEvent.pointerUp(document, { pointerId: 1, clientX: 20, clientY: 90 });
    await waitFor(() => expect(releaseReorder).toBeTypeOf("function"));
    expect(
      screen.getAllByTestId(/highlight-rule-/).map((row) => row.getAttribute("data-testid"))
    ).toEqual(["highlight-rule-two", "highlight-rule-one", "highlight-rule-three"]);
    expect(calls.filter((call) => call.url.endsWith("/reorder"))).toHaveLength(1);
    await act(async () => {
      releaseReorder?.();
    });
  });

  it("announces keyboard drag instructions and movement in Spanish", async () => {
    householdSettings.language = "es";
    renderPage();
    const handle = await screen.findByRole("button", { name: "Mover regla ⚽" });
    expect(handle).toHaveAttribute("aria-describedby");
    expect(document.getElementById(handle.getAttribute("aria-describedby")!)).toHaveTextContent(
      "Pulsa Espacio para coger una regla"
    );
  });
});
