import { isSingleEmoji } from "./emoji.js";

/** The emoji sets a member can pick for the confetti played when they finish a block of chores.
 * One table for the server's validation, the admin picker and the board renderer. `confetti` has
 * no emojis: it draws coloured paper in the member's palette instead.
 */
export const CELEBRATION_PRESETS = {
  confetti: [],
  stars: ["⭐", "🌟", "✨", "💫"],
  videogames: ["🎮", "👾", "🕹️", "⭐"],
  soccer: ["⚽", "🥅", "🏆", "⭐"],
  fairytale: ["👑", "🏰", "✨", "💖", "🦄"],
} as const satisfies Record<string, readonly string[]>;

export type CelebrationPresetId = keyof typeof CELEBRATION_PRESETS;
export type CelebrationPreset = CelebrationPresetId | "custom";

/** Every stored preset value, in the order the admin picker shows them. */
export const CELEBRATION_PRESET_IDS = [
  "confetti",
  "stars",
  "videogames",
  "soccer",
  "fairytale",
  "custom",
] as const satisfies readonly CelebrationPreset[];

/** The most emojis a custom set may hold. */
export const CELEBRATION_CUSTOM_MAX = 6;

/** A member's celebration: a preset, or `custom` with its own 1–6 distinct emojis. */
export type MemberCelebration =
  { preset: CelebrationPresetId } | { preset: "custom"; emojis: string[] };

export const DEFAULT_CELEBRATION: MemberCelebration = { preset: "confetti" };

export function isCelebrationPreset(value: unknown): value is CelebrationPreset {
  return typeof value === "string" && (CELEBRATION_PRESET_IDS as readonly string[]).includes(value);
}

/** Validate an API value. Returns the normalised celebration (emojis trimmed), or the reason it
 * was refused. Rules: a known preset; `custom` needs 1–6 distinct single emojis; any other
 * preset takes no emojis.
 */
export function parseCelebration(
  value: unknown
): { ok: true; value: MemberCelebration } | { ok: false; message: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, message: "celebration must be an object." };
  }
  const { preset, emojis, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) {
    return { ok: false, message: `Unknown celebration field "${Object.keys(rest)[0]}".` };
  }
  if (!isCelebrationPreset(preset)) {
    return {
      ok: false,
      message: `celebration.preset must be one of ${CELEBRATION_PRESET_IDS.join(", ")}.`,
    };
  }
  if (preset !== "custom") {
    if (emojis !== undefined) {
      return { ok: false, message: 'celebration.emojis is only allowed with preset "custom".' };
    }
    return { ok: true, value: { preset } };
  }
  if (!Array.isArray(emojis) || emojis.length === 0) {
    return { ok: false, message: 'celebration preset "custom" needs at least one emoji.' };
  }
  if (emojis.length > CELEBRATION_CUSTOM_MAX) {
    return {
      ok: false,
      message: `celebration.emojis holds at most ${CELEBRATION_CUSTOM_MAX} emojis.`,
    };
  }
  if (!emojis.every((emoji) => typeof emoji === "string" && isSingleEmoji(emoji))) {
    return { ok: false, message: "Each celebration emoji must be exactly one emoji." };
  }
  const trimmed = (emojis as string[]).map((emoji) => emoji.trim());
  if (new Set(trimmed).size !== trimmed.length) {
    return { ok: false, message: "celebration.emojis must not repeat an emoji." };
  }
  return { ok: true, value: { preset, emojis: trimmed } };
}

/** The glyphs a celebration is drawn with; empty means coloured paper. */
export function celebrationEmojis(celebration: MemberCelebration): readonly string[] {
  return celebration.preset === "custom"
    ? celebration.emojis
    : CELEBRATION_PRESETS[celebration.preset];
}

/** Household-wide celebration settings (`settings_objects.celebration`). */
export interface CelebrationSettings {
  sound: boolean;
}

export const DEFAULT_CELEBRATION_SETTINGS: CelebrationSettings = { sound: true };
