/** Closed screen-identity vocabulary, in assignment order. Ten colours chosen to stay apart
 * from one another on a card or a calendar chip.
 */
export const MEMBER_COLOR_KEYS = [
  "blue",
  "sky",
  "teal",
  "green",
  "lime",
  "amber",
  "orange",
  "red",
  "pink",
  "violet",
] as const;

export type MemberColorKey = (typeof MEMBER_COLOR_KEYS)[number];

/** Archived members do not reserve colours; repeated active keys still count toward reuse. */
export function chooseMemberColorKey(activeKeys: readonly MemberColorKey[]): MemberColorKey {
  const used = new Set(activeKeys);
  return (
    MEMBER_COLOR_KEYS.find((key) => !used.has(key)) ??
    MEMBER_COLOR_KEYS[activeKeys.length % MEMBER_COLOR_KEYS.length]
  );
}

/** Names the palette once had, and the colour each became (migration 0004). */
export const RETIRED_MEMBER_COLOR_KEYS = {
  cyan: "teal",
  yellow: "amber",
  rose: "red",
  fuchsia: "pink",
  purple: "violet",
  indigo: "blue",
} as const satisfies Record<string, MemberColorKey>;
