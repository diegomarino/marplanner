import type { CSSProperties } from "react";

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
  /** Custom properties the caller's classes read (e.g. `--member-color`). Semantic tokens only. */
  tokenStyle?: CSSProperties;
  /** Reserve the semibold label's width so a caller that bolds the checked state never shifts
   * the pills beside it: an invisible, zero-height bold copy of the label sizes the same grid. */
  reserveBoldLabel?: boolean;
  /** "colour": a caller class sets `--pill-color` (checked border) and `--pill-color-selected`
   * (checked ground). Unchecked it is muted like a member pill; checked it has foreground text in
   * semibold. "default" (the default) is the plain accent pill. */
  tone?: "default" | "colour";
  /** Native radio group name. */
  name?: string;
  value?: string;
  disabled?: boolean;
  className?: string;
  /** Placed on the native input. */
  "data-testid"?: string;
}

/** The coloured tone. A transparent border keeps the box identical in both states. */
const COLOUR_TONE_CLASS =
  "border-transparent bg-muted text-muted-foreground has-[:checked]:border-[var(--pill-color)] has-[:checked]:bg-[var(--pill-color-selected)] has-[:checked]:text-foreground has-[:checked]:font-semibold";

export function PillControl({
  type,
  checked,
  onChange,
  label,
  note,
  tokenStyle,
  reserveBoldLabel,
  tone = "default",
  name,
  value,
  disabled,
  className,
  "data-testid": testId,
}: PillControlProps) {
  return (
    <label
      // eslint-disable-next-line ui-policy/debt -- Forwards the caller's semantic colour token custom properties.
      style={tokenStyle}
      className={cn(
        "border-input bg-background text-muted-foreground text-control relative inline-flex h-[var(--control-height)] cursor-pointer items-center rounded-lg border px-4 font-medium",
        "not-has-[:checked]:hover:bg-primary/10 not-has-[:checked]:hover:text-foreground",
        "has-[:checked]:bg-accent has-[:checked]:text-accent-foreground",
        "has-[:focus-visible]:ring-ring/50 has-[:focus-visible]:ring-[3px]",
        tone === "colour" && COLOUR_TONE_CLASS,
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
      {reserveBoldLabel ? (
        <span
          data-text={label}
          className="inline-grid after:invisible after:h-0 after:overflow-hidden after:font-semibold after:content-[attr(data-text)]"
        >
          {label}
        </span>
      ) : (
        label
      )}
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
