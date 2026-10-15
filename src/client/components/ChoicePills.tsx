import { useId } from "react";

import { cn } from "@/lib/utils";
import { PillControl } from "./PillControl";

/** L2 composed component (wiring and accessibility).
 * Exactly one of a few options (2–4), drawn as the same pills as `PillToggle` — the admin's
 * segmented choice (Settings language and week start, a reminder's kind). It is a native radio
 * group: one tab stop, arrow keys move the choice, and the group name is instance-unique so two
 * groups on one page never share a native radio group.
 */
export interface ChoicePillsOption<T extends string> {
  value: T;
  /** Localized, call-site-owned. */
  label: string;
  disabled?: boolean;
  /** Placed on the option's native radio input. */
  "data-testid"?: string;
}

export interface ChoicePillsProps<T extends string> {
  /** null = nothing chosen yet. */
  value: T | null;
  onChange: (value: T) => void;
  /** 2–4 options in display order. */
  options: readonly ChoicePillsOption<T>[];
  /** Accessible name of the radiogroup (required, localized). */
  groupLabel: string;
  disabled?: boolean;
  className?: string;
}

export function ChoicePills<T extends string>({
  value,
  onChange,
  options,
  groupLabel,
  disabled,
  className,
}: ChoicePillsProps<T>) {
  const name = useId();
  return (
    <div
      role="radiogroup"
      aria-label={groupLabel}
      className={cn("flex flex-wrap gap-2", className)}
    >
      {options.map((option) => (
        <PillControl
          key={option.value}
          type="radio"
          name={name}
          value={option.value}
          checked={option.value === value}
          onChange={() => onChange(option.value)}
          label={option.label}
          disabled={disabled || option.disabled}
          data-testid={option["data-testid"]}
        />
      ))}
    </div>
  );
}
