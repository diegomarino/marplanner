import * as React from "react";

import { cn } from "@/lib/utils";

/** L2 composed component (FR-005 — wiring).
 * Admission test: * Wiring* — same rationale as `CheckboxField` (label association + the
 * density-token sizing no raw `<input type="radio">` gets today), plus the native-grouping
 * relationship a `name` attribute establishes: every radio in a group must share it, which a
 * call site can get subtly wrong (a stale/duplicated `name` silently breaks mutual exclusivity)
 * and which `WeekdayPicker`'s single-select mode now derives once instead of per call site.
 * Consumed by `WeekdayPicker`'s single-select mode (`admin/MealsManagement.tsx`'s recurring-entry
 * weekday selection is the one call site that picks exactly one day, not a set).
 */
export interface RadioFieldProps {
  name: string;
  value: string;
  checked: boolean;
  onChange: (value: string) => void;
  /** Localized label text (call-site-owned). */
  label: string;
  disabled?: boolean;
  className?: string;
  "data-testid"?: string;
}

export function RadioField({
  name,
  value,
  checked,
  onChange,
  label,
  disabled,
  className,
  ...rest
}: RadioFieldProps) {
  return (
    <label
      className={cn(
        "inline-flex items-center gap-2 text-[length:var(--control-font-size)]",
        disabled && "opacity-50",
        className
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onChange(value)}
        className="accent-primary border-input size-[var(--control-height)] shrink-0 text-[length:var(--control-font-size)]"
        {...rest}
      />
      {label}
    </label>
  );
}
