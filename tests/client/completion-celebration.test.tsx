/** CompletionCelebration (#92): emoji and paper particles, auto-dismiss and tap-dismiss,
 * reduced motion, and the fanfare (played only with sound on; a refused play() is silent).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CELEBRATION_DURATION_MS,
  CompletionCelebration,
  celebrationParticles,
} from "@/chores/CompletionCelebration";
import { resetCelebrationSoundForTests } from "@/chores/celebration-sound";
import { EMOJI_CATEGORIES, NON_PICKER_ICON_EMOJIS } from "@/chores/emoji-catalog";
import { CELEBRATION_PRESETS } from "../../src/shared/celebration";

function stubMatchMedia(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: reduce && query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }))
  );
}

function renderCelebration(
  props: Partial<Parameters<typeof CompletionCelebration>[0]> = {},
  onDismiss = vi.fn()
) {
  render(
    <CompletionCelebration
      colorKey="teal"
      emojis={["⚽", "🥅"]}
      title="Morning completed!"
      message="High five!"
      sound={false}
      onDismiss={onDismiss}
      {...props}
    />
  );
  return onDismiss;
}

const particles = () => screen.getAllByTestId("completion-celebration-particle");

describe("CompletionCelebration", () => {
  let play: ReturnType<typeof vi.fn<() => Promise<void>>>;

  beforeEach(() => {
    resetCelebrationSoundForTests();
    play = vi.fn<() => Promise<void>>(() => Promise.resolve());
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play);
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("probably");
    stubMatchMedia(false);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("announces the title and message and rains the member's emojis", () => {
    renderCelebration();
    expect(screen.getByRole("status")).toHaveTextContent("Morning completed!");
    expect(screen.getByRole("status")).toHaveTextContent("High five!");
    expect(new Set(particles().map((p) => p.getAttribute("data-symbol")))).toEqual(
      new Set(["⚽", "🥅"])
    );
    expect(screen.getByTestId("completion-celebration")).toHaveAttribute("data-motion", "full");
  });

  it("draws coloured paper in the member palette when the set has no emojis", () => {
    renderCelebration({ emojis: [] });
    expect(screen.getByTestId("completion-celebration")).toHaveAttribute(
      "data-preset-kind",
      "paper"
    );
    expect(particles().every((p) => p.classList.contains("completion-celebration-paper"))).toBe(
      true
    );
    const colours = celebrationParticles([], "teal").map((p) => p.color);
    expect(colours.filter((colour) => colour === "teal")).toHaveLength(colours.length / 2);
    expect(new Set(colours).size).toBeGreaterThan(2);
  });

  it("dismisses itself after the celebration duration", () => {
    vi.useFakeTimers();
    const onDismiss = renderCelebration();
    act(() => {
      vi.advanceTimersByTime(CELEBRATION_DURATION_MS - 1);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("dismisses on any tap without blocking the page", () => {
    const onDismiss = renderCelebration();
    expect(screen.getByTestId("completion-celebration")).toHaveClass("pointer-events-none");
    fireEvent.pointerDown(document.body);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("shows a still scene under reduced motion", () => {
    stubMatchMedia(true);
    renderCelebration();
    expect(screen.getByTestId("completion-celebration")).toHaveAttribute("data-motion", "reduced");
    expect(particles().length).toBeLessThan(celebrationParticles(["⚽"], "teal").length);
  });

  it("plays the fanfare once when sound is on, also under reduced motion", () => {
    stubMatchMedia(true);
    renderCelebration({ sound: true });
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("plays nothing when sound is off", () => {
    renderCelebration({ sound: false });
    expect(play).not.toHaveBeenCalled();
  });

  it("swallows a refused play()", async () => {
    play.mockImplementation(() => Promise.reject(new DOMException("blocked", "NotAllowedError")));
    renderCelebration({ sound: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("swallows a play() that throws synchronously", () => {
    play.mockImplementation(() => {
      throw new Error("no audio device");
    });
    expect(() => renderCelebration({ sound: true })).not.toThrow();
  });
});

describe("celebration emojis are vendored", () => {
  it("every preset emoji is in the emoji catalog, so it renders as a Noto SVG", () => {
    const catalog = new Set([
      ...EMOJI_CATEGORIES.flatMap((category) => category.items.map((item) => item.emoji)),
      ...NON_PICKER_ICON_EMOJIS.map((item) => item.emoji),
    ]);
    const pickable = new Set(
      EMOJI_CATEGORIES.flatMap((category) => category.items.map((item) => item.emoji))
    );
    for (const emojis of Object.values(CELEBRATION_PRESETS)) {
      for (const emoji of emojis) {
        expect(catalog.has(emoji), emoji).toBe(true);
        expect(pickable.has(emoji), emoji).toBe(true);
      }
    }
  });
});
