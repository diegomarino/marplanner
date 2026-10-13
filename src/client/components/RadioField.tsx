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
        "inline-flex items-center gap-2 text-control",
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
        className={cn(
          // Hit area: the full density-sized native input, with the platform rendering switched off.
          "grid size-[var(--control-height)] shrink-0 appearance-none place-items-center text-control outline-none",
          // Drawn circle: half the control height, centred in the hit area, on the field surface.
          "before:col-start-1 before:row-start-1 before:aspect-square before:w-[calc(var(--control-height)/2)] before:rounded-full before:border before:border-muted-foreground before:bg-field before:transition-[color,box-shadow]",
          "checked:before:border-primary checked:before:bg-primary",
          "focus-visible:before:border-ring focus-visible:before:ring-ring/50 focus-visible:before:ring-[3px]",
          // Dot: a smaller circle on top of the drawn one, shown only when checked.
          "after:col-start-1 after:row-start-1 after:aspect-square after:w-[calc(var(--control-height)/6)] after:rounded-full after:bg-primary-foreground after:opacity-0 checked:after:opacity-100",
          // Forced colours: hand the control back to the platform, which draws it in system colours.
          "forced-colors:appearance-auto forced-colors:before:hidden forced-colors:after:hidden"
        )}
        {...rest}
      />
      {label}
    </label>
  );
}
