import { useId, type CSSProperties } from "react";

import { cn } from "@/lib/utils";
import type { MemberColorKey } from "../../shared";
import { PillControl } from "./PillControl";

/** L2 composed component (wiring and accessibility).
 * Pick one member (`mode="single"`, a native radio group) or several (multi, the default, native
 * checkboxes). An unselected pill is muted grey; a selected one is filled with the member's own
 * colour and white semibold text, and every label reserves its bold width so selecting never
 * shifts its neighbours. A disabled member stays visible. An off member (one that cannot be picked
 * here) keeps the pill shape with a plain border on the page ground, its caller-supplied marker
 * after the name (part of the accessible name, so colour is never the only signal), a disabled
 * input, and is never returned by `onChange`.
 */

/** Unselected: muted ground. Selected: the member's solid colour (`--member-color`, set per pill)
 * with the avatar foreground. The border is always present and transparent so both states match
 * the off pill's box. */
const MEMBER_PILL_CLASS =
  "border-transparent bg-muted text-muted-foreground has-[:checked]:bg-[var(--member-color)] has-[:checked]:text-member-avatar-foreground has-[:checked]:font-semibold";

/** Off: the page shows through a plain border; no hover, no dimming (it is not "disabled" chrome,
 * it is a member who is simply not available here). */
const MEMBER_PILL_OFF_CLASS =
  "border-border bg-transparent font-normal opacity-100 not-has-[:checked]:hover:bg-transparent not-has-[:checked]:hover:text-muted-foreground";

/** Static class map so Tailwind sees every class (the `TodayAgenda.tsx` precedent). */
export const MEMBER_DOT_CLASS: Record<MemberColorKey, string> = {
  blue: "bg-member-blue-500",
  sky: "bg-member-sky-500",
  teal: "bg-member-teal-500",
  green: "bg-member-green-500",
  lime: "bg-member-lime-500",
  amber: "bg-member-amber-500",
  orange: "bg-member-orange-500",
  red: "bg-member-red-500",
  pink: "bg-member-pink-500",
  violet: "bg-member-violet-500",
};

export interface MemberPillsMember {
  id: string;
  displayName: string;
  colorKey: MemberColorKey;
  disabled?: boolean;
  /** Localized marker such as "off"; when set the member cannot be picked here: the pill is drawn
   * off, its input is disabled, and the marker follows the name (part of its accessible name). */
  offLabel?: string;
}

interface MemberPillsCommonProps {
  /** Display order. A MemberDTO/Member satisfies this structurally. */
  members: readonly MemberPillsMember[];
  /** Accessible name of the group (required, localized). */
  groupLabel: string;
  /** `${testIdPrefix}-${member.id}` on each native input. */
  testIdPrefix?: string;
  disabled?: boolean;
  className?: string;
}

export interface MemberPillsSingleProps extends MemberPillsCommonProps {
  mode: "single";
  value: string | null;
  onChange: (memberId: string) => void;
}

export interface MemberPillsMultiProps extends MemberPillsCommonProps {
  mode?: "multi";
  value: readonly string[];
  /** Selected ids in `members` order, followed by any selected ids not in `members`. */
  onChange: (next: string[]) => void;
}

export type MemberPillsProps = MemberPillsSingleProps | MemberPillsMultiProps;

export function MemberPills(props: MemberPillsProps) {
  const { members, groupLabel, testIdPrefix, disabled, className } = props;
  // Called before the mode branch: hooks cannot sit inside a conditional.
  const name = useId();

  const renderPill = (
    member: MemberPillsMember,
    type: "checkbox" | "radio",
    checked: boolean,
    onPillChange: () => void
  ) => (
    <PillControl
      key={member.id}
      type={type}
      name={type === "radio" ? name : undefined}
      value={member.id}
      checked={checked}
      onChange={() => {
        if (member.offLabel === undefined) onPillChange();
      }}
      label={member.displayName}
      note={member.offLabel}
      reserveBoldLabel
      // eslint-disable-next-line ui-policy/debt -- Closed member keys select generated semantic token custom properties only.
      style={{ "--member-color": `var(--color-member-${member.colorKey}-500)` } as CSSProperties}
      disabled={disabled || member.disabled || member.offLabel !== undefined}
      className={cn(MEMBER_PILL_CLASS, member.offLabel !== undefined && MEMBER_PILL_OFF_CLASS)}
      data-testid={testIdPrefix ? `${testIdPrefix}-${member.id}` : undefined}
    />
  );

  if (props.mode === "single") {
    const { value, onChange } = props;
    return (
      <div
        role="radiogroup"
        aria-label={groupLabel}
        className={cn("flex flex-wrap gap-2", className)}
      >
        {members.map((member) =>
          renderPill(member, "radio", member.id === value, () => onChange(member.id))
        )}
      </div>
    );
  }

  const { value, onChange } = props;
  const toggle = (memberId: string) => {
    const next = new Set(value);
    if (next.has(memberId)) {
      next.delete(memberId);
    } else {
      next.add(memberId);
    }
    const shown = new Set(members.map((member) => member.id));
    onChange([
      // An off member is never returned, even if the caller passed it in `value`.
      ...members
        .filter((member) => next.has(member.id) && member.offLabel === undefined)
        .map((member) => member.id),
      // Never drop a selected member the caller chose not to show (e.g. an archived one).
      ...[...next].filter((id) => !shown.has(id)),
    ]);
  };

  return (
    <div role="group" aria-label={groupLabel} className={cn("flex flex-wrap gap-2", className)}>
      {members.map((member) =>
        renderPill(member, "checkbox", value.includes(member.id), () => toggle(member.id))
      )}
    </div>
  );
}
