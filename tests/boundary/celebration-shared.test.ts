/** The shared celebration rules (#92) that the server, the admin form and the board renderer
 * all read from src/shared/celebration.ts.
 */
import { describe, expect, it } from "vitest";
import {
  CELEBRATION_CUSTOM_MAX,
  CELEBRATION_PRESETS,
  CELEBRATION_PRESET_IDS,
  DEFAULT_CELEBRATION,
  celebrationEmojis,
  isCelebrationPreset,
  parseCelebration,
} from "../../src/shared/celebration";
import { isSingleEmoji } from "../../src/shared/emoji";

describe("celebration presets", () => {
  it("lists every preset plus custom, with confetti as the emoji-less default", () => {
    expect(CELEBRATION_PRESET_IDS).toEqual([...Object.keys(CELEBRATION_PRESETS), "custom"]);
    expect(DEFAULT_CELEBRATION).toEqual({ preset: "confetti" });
    expect(CELEBRATION_PRESETS.confetti).toEqual([]);
  });

  it("holds only distinct single emojis within the custom maximum", () => {
    for (const emojis of Object.values(CELEBRATION_PRESETS)) {
      expect(emojis.every((emoji) => isSingleEmoji(emoji))).toBe(true);
      expect(new Set(emojis).size).toBe(emojis.length);
      expect(emojis.length).toBeLessThanOrEqual(CELEBRATION_CUSTOM_MAX);
    }
  });

  it("recognises preset ids only", () => {
    expect(isCelebrationPreset("custom")).toBe(true);
    expect(isCelebrationPreset("dragons")).toBe(false);
    expect(isCelebrationPreset(3)).toBe(false);
  });

  it("draws a preset's glyphs or a custom set's own", () => {
    expect(celebrationEmojis({ preset: "soccer" })).toEqual(["⚽", "🥅", "🏆", "⭐"]);
    expect(celebrationEmojis({ preset: "custom", emojis: ["🦄"] })).toEqual(["🦄"]);
  });
});

describe("parseCelebration", () => {
  it("accepts a preset and a custom set, trimming the emojis", () => {
    expect(parseCelebration({ preset: "stars" })).toEqual({
      ok: true,
      value: { preset: "stars" },
    });
    expect(parseCelebration({ preset: "custom", emojis: [" 👑 ", "🏰"] })).toEqual({
      ok: true,
      value: { preset: "custom", emojis: ["👑", "🏰"] },
    });
  });

  it("accepts exactly the custom maximum", () => {
    const emojis = ["⭐", "🌟", "✨", "💫", "👑", "🏰"];
    expect(emojis).toHaveLength(CELEBRATION_CUSTOM_MAX);
    expect(parseCelebration({ preset: "custom", emojis }).ok).toBe(true);
  });

  it.each([
    [null, /object/],
    [["stars"], /object/],
    [{ preset: "stars", extra: 1 }, /Unknown celebration field "extra"/],
    [{ preset: "dragons" }, /must be one of/],
    [{ preset: "stars", emojis: ["⭐"] }, /only allowed with preset "custom"/],
    [{ preset: "custom" }, /at least one emoji/],
    [{ preset: "custom", emojis: "⭐" }, /at least one emoji/],
    [{ preset: "custom", emojis: ["⭐", "🌟", "✨", "💫", "👑", "🏰", "🦄"] }, /at most 6/],
    [{ preset: "custom", emojis: ["a"] }, /exactly one emoji/],
    [{ preset: "custom", emojis: ["⭐", " ⭐"] }, /must not repeat/],
  ])("refuses %j", (value, message) => {
    const parsed = parseCelebration(value);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(message);
  });
});
