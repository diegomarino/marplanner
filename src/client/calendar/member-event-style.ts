import type { CSSProperties } from "react";
import type { MemberColorKey } from "../../shared";

export type MemberEventStyle = CSSProperties & {
  "--member-event-background"?: string;
  "--member-event-border"?: string;
};

function memberColour(key: MemberColorKey): string {
  return `var(--color-member-${key}-500)`;
}

/** Visual identity for unassigned, single-member, and multi-member event surfaces. */
export function memberEventStyle(colorKeys: readonly MemberColorKey[]): MemberEventStyle {
  const uniqueKeys = [...new Set(colorKeys)];
  if (uniqueKeys.length === 0) return {};

  const first = memberColour(uniqueKeys[0]);
  if (uniqueKeys.length === 1) {
    return {
      // eslint-disable-next-line no-restricted-syntax -- The runtime member token must be softened without replacing the member's configured identity colour.
      "--member-event-background": `color-mix(in oklch, ${first} 22%, white)`,
      "--member-event-border": first,
    };
  }

  const stripeStops = uniqueKeys
    .map((key, index) => {
      const start = (index / uniqueKeys.length) * 100;
      const end = ((index + 1) / uniqueKeys.length) * 100;
      // eslint-disable-next-line no-restricted-syntax -- Each diagonal band is derived from a semantic member token selected at runtime.
      return `color-mix(in oklch, ${memberColour(key)} 18%, white) ${start}% ${end}%`;
    })
    .join(", ");

  return {
    "--member-event-background": `repeating-linear-gradient(135deg, ${stripeStops})`,
    "--member-event-border": first,
  };
}

/** Selected filter pill styling derived from the same semantic member token as event surfaces. */
export function memberFilterStyle(key: MemberColorKey): CSSProperties {
  const colour = memberColour(key);
  return {
    // eslint-disable-next-line no-restricted-syntax -- The selected state is derived from the active member's semantic colour token at runtime.
    backgroundColor: `color-mix(in oklch, ${colour} 24%, white)`,
    borderColor: colour,
    color: `var(--color-member-${key}-foreground)`,
  };
}
