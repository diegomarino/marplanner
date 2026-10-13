import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

/** L2 composed component (wiring and accessibility).
 * An on/off choice drawn as a pill: plain when off, filled when on. Use it where several
 * independent choices sit side by side (filters, the people on an event, the meals a recipe
 * suits) and a column of checkboxes would spend more room than the choice deserves.
 * It stays a native checkbox for keyboard and assistive tech. The input is laid invisibly over
 * the whole pill, so the touch target is the full control and meets the density minimum.
 */
export interface PillToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Localized label text (call-site-owned). */
  label: string;
  /** Replaces the accent fill while selected — a member's own colour, for instance. Pass only
   * semantic colour tokens.
   */
  selectedStyle?: CSSProperties;
  disabled?: boolean;
  className?: string;
  "data-testid"?: string;
}

export function PillToggle({
  checked,
  onChange,
  label,
  selectedStyle,
  disabled,
  className,
  "data-testid": testId,
}: PillToggleProps) {
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
      {/* eslint-disable-next-line ui-policy/raw-controls -- Invisible native checkbox stretched over the token-sized label, which draws its state. */}
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        data-testid={testId}
        onChange={(event) => onChange(event.target.checked)}
        className="absolute inset-0 h-[var(--control-height)] w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
      />
      {label}
    </label>
  );
}
