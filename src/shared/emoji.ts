const PICTOGRAPHIC = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u;

/** Whether `value` is exactly one emoji as a person sees it: a single grapheme (so a family
 * or a flag counts as one) that contains a pictographic character. Surrounding spaces are
 * ignored. The server's highlight-rule validation and the admin form share this one rule.
 */
export function isSingleEmoji(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 32) return false;
  const graphemes = [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(trimmed),
  ];
  return graphemes.length === 1 && PICTOGRAPHIC.test(trimmed);
}
