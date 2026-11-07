/** Completion celebration on the chores board (#92): it fires once, for the member's own tap
 * that finishes a day period, with that member's colour and emojis, and never on load,
 * refetch, uncompletion or a re-completion in the same session.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChoreColumns } from "@/chores/ChoreColumns";
import { resetCelebrationSoundForTests } from "@/chores/celebration-sound";
import { HouseholdSettingsProvider } from "@/lib/householdSettings";
import { LanguageProvider } from "@/i18n";

const DATE = "2026-11-07";

function json(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status });
}

/** A backend whose board reflects the completions posted to it. */
function mockBackend(options: { initiallyDone?: string[]; sound?: boolean } = {}) {
  const done = new Set(options.initiallyDone ?? []);
  const column = () => ({
    memberId: "m1",
    displayName: "Ari",
    streak: null,
    todayProgress: null,
    dayPeriods: [
      {
        id: "morning",
        labelKey: "dayPeriod.morning",
        chores: ["c1", "c2"].map((id) => ({
          id,
          name: id === "c1" ? "Brush teeth" : "Make bed",
          icon: null,
          completed: done.has(id),
        })),
      },
      { id: "afternoon", labelKey: "dayPeriod.afternoon", chores: [] },
      { id: "evening", labelKey: "dayPeriod.evening", chores: [] },
      { id: "night", labelKey: "dayPeriod.night", chores: [] },
    ],
  });
  const mockFetch = vi.fn((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/api/settings")) {
      return Promise.resolve(
        json({
          locale: { timezone: "UTC", language: "en", weekStartDay: 1 },
          celebration: { sound: options.sound ?? false },
        })
      );
    }
    if (url.startsWith("/api/chores/board")) return Promise.resolve(json([column()]));
    if (url.includes("/api/day-periods")) return Promise.resolve(json(null, 500));
    if (url.includes("/api/members")) {
      return Promise.resolve(
        json([
          {
            id: "m1",
            displayName: "Ari",
            colorKey: "violet",
            celebration: { preset: "custom", emojis: ["🦄", "🏰"] },
          },
        ])
      );
    }
    const completion = url.match(/\/api\/chores\/(\w+)\/completions/);
    if (completion && method === "POST") {
      done.add(completion[1]);
      return Promise.resolve(json(null, 201));
    }
    if (completion && method === "DELETE") {
      done.delete(completion[1]);
      return Promise.resolve(json(null, 204));
    }
    throw new Error(`unexpected fetch: ${url} (${method})`);
  });
  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

function renderBoard() {
  return render(
    <HouseholdSettingsProvider>
      <LanguageProvider>
        <ChoreColumns date={DATE} layout="scroll" />
      </LanguageProvider>
    </HouseholdSettingsProvider>
  );
}

async function tap(choreId: string) {
  fireEvent.click(await screen.findByTestId(`chore-toggle-${choreId}`));
}

async function confirmUncomplete() {
  fireEvent.click(await screen.findByTestId("chores-uncomplete-confirm"));
}

describe("chores board completion celebration", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("celebrates once when the member's tap completes the last open chore of a period", async () => {
    mockBackend({ initiallyDone: ["c1"] });
    renderBoard();
    await tap("c2");

    const overlay = await screen.findByTestId("completion-celebration");
    expect(within(overlay).getByRole("status")).toHaveTextContent("Morning completed!");
    const symbols = within(overlay)
      .getAllByTestId("completion-celebration-particle")
      .map((particle) => particle.getAttribute("data-symbol"));
    expect(new Set(symbols)).toEqual(new Set(["🦄", "🏰"]));
    expect(overlay.getAttribute("style")).toContain("--color-member-violet-500");
  });

  it("does not celebrate a period that is already complete when the board loads", async () => {
    mockBackend({ initiallyDone: ["c1", "c2"] });
    renderBoard();
    await screen.findByTestId("chore-toggle-c2");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByTestId("completion-celebration")).toBeNull();
  });

  it("does not celebrate a completion that leaves chores open in the period", async () => {
    const mockFetch = mockBackend();
    renderBoard();
    await tap("c1");
    await waitFor(() =>
      expect(
        mockFetch.mock.calls.filter(([url]) => String(url).startsWith("/api/chores/board"))
      ).toHaveLength(2)
    );
    expect(screen.queryByTestId("completion-celebration")).toBeNull();
  });

  it("does not celebrate an uncompletion, nor the same period again in this session", async () => {
    mockBackend({ initiallyDone: ["c1"] });
    renderBoard();
    await tap("c2");
    await screen.findByTestId("completion-celebration");
    // A tap anywhere dismisses it.
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByTestId("completion-celebration")).toBeNull());

    await tap("c2");
    await confirmUncomplete();
    await waitFor(() =>
      expect(screen.getByTestId("chore-toggle-c2")).toHaveAttribute("aria-pressed", "false")
    );
    expect(screen.queryByTestId("completion-celebration")).toBeNull();

    await tap("c2");
    await waitFor(() =>
      expect(screen.getByTestId("chore-toggle-c2")).toHaveAttribute("aria-pressed", "true")
    );
    expect(screen.queryByTestId("completion-celebration")).toBeNull();
  });

  it("unlocks the fanfare inside the completion tap, before the request settles", async () => {
    resetCelebrationSoundForTests();
    const mutedAtPlay: boolean[] = [];
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
      this: HTMLMediaElement
    ) {
      mutedAtPlay.push(this.muted);
      return Promise.resolve();
    });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    try {
      mockBackend({ initiallyDone: ["c1"], sound: true });
      renderBoard();
      // The board only loads once the household settings (and their sound switch) have.
      const toggle = await screen.findByTestId("chore-toggle-c2");
      fireEvent.click(toggle);
      // Synchronously, in the tap: one muted priming play.
      expect(mutedAtPlay).toEqual([true]);
      await screen.findByTestId("completion-celebration");
      // Then the real, audible play once the celebration is known.
      await waitFor(() => expect(mutedAtPlay).toEqual([true, false]));
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("neither unlocks nor plays the fanfare when the household sound is off", async () => {
    resetCelebrationSoundForTests();
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockImplementation(() => Promise.resolve());
    try {
      mockBackend({ initiallyDone: ["c1"], sound: false });
      renderBoard();
      await tap("c2");
      await screen.findByTestId("completion-celebration");
      expect(play).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("still celebrates when session storage is unavailable", async () => {
    mockBackend({ initiallyDone: ["c1"] });
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    try {
      renderBoard();
      await tap("c2");
      expect(await screen.findByTestId("completion-celebration")).toBeInTheDocument();
    } finally {
      getItem.mockRestore();
    }
  });
});
