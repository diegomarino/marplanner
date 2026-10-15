import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Internal drawing primitive behind `PillToggle`, `ChoicePills` and `MemberPills`. It is NOT
 * exported from `@/ui`: page code uses one of those three instead.
 * The `<label>` draws the pill; a native checkbox or radio is laid invisibly over the whole pill,
 * so the touch target is the full control (density minimum), keyboard and assistive tech get the
 * native semantics, and the label text is the accessible name.
 */
export interface PillControlProps {
  type: "checkbox" | "radio";
  checked: boolean;
  /** The input's new checked state. A radio only fires when it becomes checked. */
  onChange: (checked: boolean) => void;
  /** Localized label text (call-site-owned). */
  label: string;
  /** Visible muted text after the label, e.g. "inactive". Part of the accessible name. */
  note?: string;
  /** Decorative node before the label (hidden from assistive tech), e.g. a colour dot. */
  adornment?: ReactNode;
  /** Replaces the accent fill while selected. Pass only semantic colour tokens. */
  selectedStyle?: CSSProperties;
  /** Native radio group name. */
  name?: string;
  value?: string;
  disabled?: boolean;
  className?: string;
  /** Placed on the native input. */
  "data-testid"?: string;
}

export function PillControl({
  type,
  checked,
  onChange,
  label,
  note,
  adornment,
  selectedStyle,
  name,
  value,
  disabled,
  className,
  "data-testid": testId,
}: PillControlProps) {
  return (
    <label
      // eslint-disable-next-line ui-policy/debt -- Forwards the caller's semantic colour tokens for the selected state.
      style={checked ? selectedStyle : undefined}
      className={cn(
        "border-input bg-background text-muted-foreground text-control relative inline-flex h-[var(--control-height)] cursor-pointer items-center rounded-lg border px-4 font-medium",
        "not-has-[:checked]:hover:bg-primary/10 not-has-[:checked]:hover:text-foreground",
        "has-[:checked]:bg-accent has-[:checked]:text-accent-foreground",
        "has-[:focus-visible]:ring-ring/50 has-[:focus-visible]:ring-[3px]",
        disabled && "cursor-not-allowed opacity-50",
        className
      )}
    >
      {/* eslint-disable-next-line ui-policy/raw-controls -- Invisible native checkbox or radio stretched over the token-sized label, which draws its state. */}
      <input
        type={type}
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        data-testid={testId}
        onChange={(event) => onChange(event.target.checked)}
        className="absolute inset-0 h-[var(--control-height)] w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
      />
      {adornment ? (
        <span aria-hidden="true" className="mr-2 inline-flex shrink-0">
          {adornment}
        </span>
      ) : null}
      {label}
      {note ? (
        <>
          {" "}
          {/* The space sits outside the span: accessible-name computation trims a span's leading space. */}
          <span className="text-muted-foreground ml-1 font-normal">({note})</span>
        </>
      ) : null}
    </label>
  );
}
