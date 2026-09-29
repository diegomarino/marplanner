import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CalendarView } from "@/calendar/CalendarView";
import { LanguageProvider } from "@/i18n";

vi.mock("@/lib/adminUnlock", () => ({
  useAdminUnlock: () => ({ unlocked: true, setUnlocked: vi.fn() }),
}));

/** Regression test for: the members-loading effect reruns when `t`
 * changes identity (as `/api/settings` resolves the locale, mirrored here by
 * a deferred settings fetch). A failed first run must not leave a stale
 * `membersError` up once the rerun succeeds.
 */
describe("CalendarView — membersError clears on successful retry (#339)", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let resolveSettings: (value: Response) => void;
  let membersCallCount: number;

  beforeEach(() => {
    membersCallCount = 0;
    const settingsPromise = new Promise<Response>((resolve) => {
      resolveSettings = resolve;
    });

    mockFetch = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.includes("/api/settings")) {
        return settingsPromise;
      }
      if (url.includes("/api/calendar/events")) {
        // now-relative (not a fixed calendar date, the 28-day render window would
        // otherwise silently drop this fixture once "today" passes it — see
        // tests/client/calendar-window.test.tsx for the window-bound behavior itself).
        const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const dayAfter = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                id: "evt-1",
                title: "Test Event",
                allDay: true,
                occurrenceStart: tomorrow,
                occurrenceEnd: dayAfter,
                source: "local",
                assignedTo: [],
              },
            ]),
            { status: 200 }
          )
        );
      }
      if (url.includes("/api/members")) {
        membersCallCount += 1;
        if (membersCallCount === 1) {
          return Promise.resolve(new Response(null, { status: 500 }));
        }
        return Promise.resolve(
          new Response(JSON.stringify([{ id: "m1", displayName: "Alice", lifecycle: "active" }]), {
            status: 200,
          })
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("clears a stale members error once the retriggered fetch succeeds", async () => {
    render(
      <LanguageProvider>
        <CalendarView />
      </LanguageProvider>
    );

    fireEvent.click(await screen.findByTestId("calendar-event-row"));
    const assignBtn = await screen.findByTestId("calendar-assign-btn");
    fireEvent.click(assignBtn);

    await waitFor(() => {
      expect(screen.getByText("Failed to load members.")).toBeInTheDocument();
    });

    // Resolve /api/settings so `t` changes identity, rerunning the members effect.
    resolveSettings(new Response(JSON.stringify({ locale: { language: "es" } }), { status: 200 }));

    await waitFor(() => {
      expect(screen.getByTestId("calendar-assign-member-m1")).toBeInTheDocument();
    });
    expect(screen.queryByText("Failed to load members.")).not.toBeInTheDocument();
    expect(membersCallCount).toBe(2);
  });
});
