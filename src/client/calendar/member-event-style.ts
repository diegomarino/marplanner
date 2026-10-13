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
      "--member-event-background": `color-mix(in oklch, ${first} 22%, var(--member-mix-ground))`,
      "--member-event-border": first,
    };
  }

  const stripeStops = uniqueKeys
    .map((key, index) => {
      const start = (index / uniqueKeys.length) * 100;
      const end = ((index + 1) / uniqueKeys.length) * 100;
      return `color-mix(in oklch, ${memberColour(key)} 18%, var(--member-mix-ground)) ${start}% ${end}%`;
    })
    .join(", ");

  return {
    "--member-event-background": `repeating-linear-gradient(135deg, ${stripeStops})`,
    "--member-event-border": first,
  };
}

/** Selected member pill styling derived from the same semantic member token as event surfaces. */
export function memberFilterStyle(key: MemberColorKey): CSSProperties {
  const colour = memberColour(key);
  return {
    backgroundColor: `color-mix(in oklch, ${colour} 24%, var(--member-mix-ground))`,
    borderColor: colour,
    // The tint is light, so it takes the page's text colour, not the solid swatch's.
    color: "var(--color-foreground)",
  };
}
