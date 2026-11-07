/** Noto Emoji file naming shared by the client `NotoEmoji` component and the server-side readers
 * of the vendored SVGs in `src/shared/noto/` (written by `npm run generate:noto-emojis`). Pure
 * string logic so both runtimes agree on which file an emoji maps to.
 */

const VARIATION_SELECTOR_16 = 0xfe0f;

/** Noto's codepoint key for an emoji: lowercase hex codepoints joined by `_`, without VS16. */
export function emojiToCodepoint(emoji: string): string {
  return [...emoji]
    .map((char) => char.codePointAt(0) ?? 0)
    .filter((codePoint) => codePoint !== VARIATION_SELECTOR_16)
    .map((codePoint) => codePoint.toString(16))
    .join("_");
}

/** The vendored SVG's file name for an emoji, e.g. `emoji_u1fa70.svg` for 🩰. */
export function notoEmojiFilename(emoji: string): string {
  return `emoji_u${emojiToCodepoint(emoji)}.svg`;
}
