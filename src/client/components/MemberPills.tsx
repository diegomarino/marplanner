import { useId } from "react";

import { memberFilterStyle } from "@/calendar/member-event-style";
import { cn } from "@/lib/utils";
import type { MemberColorKey } from "../../shared";
import { PillControl } from "./PillControl";

/** L2 composed component (wiring and accessibility).
 * Pick one member (`mode="single"`, a native radio group) or several (multi, the default, native
 * checkboxes). Each pill carries the member's colour dot and, once selected, the member's tint —
 * the same `memberFilterStyle` the calendar member filters use. A disabled member stays visible;
 * an inactive one is drawn dashed with its caller-supplied marker after the name, so colour is
 * never the only signal and screen readers hear the marker.
 */

/** Static class map so Tailwind sees every class (the `TodayAgenda.tsx` precedent). */
const MEMBER_DOT_CLASS: Record<MemberColorKey, string> = {
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
  /** Localized marker such as "inactive"; when set the pill is drawn inactive and the marker
   * follows the name (and is part of its accessible name). */
  inactiveLabel?: string;
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
      onChange={onPillChange}
      label={member.displayName}
      note={member.inactiveLabel}
      adornment={
        <span
          className={cn(
            "block size-3 rounded-full border border-background",
            MEMBER_DOT_CLASS[member.colorKey]
          )}
        />
      }
      selectedStyle={memberFilterStyle(member.colorKey)}
      disabled={disabled || member.disabled}
      className={member.inactiveLabel ? "border-dashed" : undefined}
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
      ...members.filter((member) => next.has(member.id)).map((member) => member.id),
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
