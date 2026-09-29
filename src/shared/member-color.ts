/** Closed screen-identity vocabulary, in assignment order. */
export const MEMBER_COLOR_KEYS = [
  "blue",
  "sky",
  "cyan",
  "teal",
  "green",
  "lime",
  "yellow",
  "amber",
  "orange",
  "red",
  "rose",
  "pink",
  "fuchsia",
  "purple",
  "violet",
  "indigo",
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
