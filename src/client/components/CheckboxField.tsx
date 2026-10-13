import * as React from "react";

import { cn } from "@/lib/utils";

/** L2 composed component (FR-005 — wiring).
 * Admission test: * Wiring* — coordinates the checkbox and its label (an implicit
 * label-wraps-input association every current call site already writes by hand, e.g.
 * `admin/RoutinesManagement.tsx`'s weekday checkboxes or `admin/TimeAnnouncementsManagement.tsx`'s * "active" checkbox) AND applies the density tokens that call site currently never
 * applies at all — a bare `<input type="checkbox">` has no density story today: it renders at the
 * browser's intrinsic ~13px box regardless of `data-density`, which is a live SC-001 violation in
 * every surface that has one. `CheckboxField` is the one place that gap closes.
 * Consumed by `WeekdayPicker`'s multi-select mode (this file is not decorative — it carries real
 * load inside this same component set).
 */
export interface CheckboxFieldProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Localized label text (call-site-owned). */
  label: string;
  disabled?: boolean;
  className?: string;
  "data-testid"?: string;
  /** Optional accessible-name override for call sites that render the SAME visible `label` on
   * every row of a list, where an ADJACENT visible text (e.g. the row's entity name) is what
   * disambiguates rows for sighted users. Compose it from the visible texts only — this is a
   * mirror of what is already on screen, never an invisible name. Without it,
   * otherwise every row's checkbox announces identically when the visible label is repeated. */
  "aria-label"?: string;
}

export function CheckboxField({
  checked,
  onChange,
  label,
  disabled,
  className,
  ...rest
}: CheckboxFieldProps) {
  return (
    <label
      className={cn(
        "inline-flex items-center gap-2 text-control",
        disabled && "opacity-50",
        className
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className={cn(
          // Hit area: the full density-sized native input, with the platform rendering switched off.
          "grid size-[var(--control-height)] shrink-0 appearance-none place-items-center text-control outline-none",
          // Drawn box: half the control height, centred in the hit area, on the field surface.
          "before:col-start-1 before:row-start-1 before:aspect-square before:w-[calc(var(--control-height)/2)] before:rounded-[calc(var(--radius)/4)] before:border before:border-muted-foreground before:bg-field before:transition-[color,box-shadow]",
          "checked:before:border-primary checked:before:bg-primary",
          "focus-visible:before:border-ring focus-visible:before:ring-ring/50 focus-visible:before:ring-[3px]",
          // Check mark: two borders of a rotated box, shown only when checked.
          "after:col-start-1 after:row-start-1 after:aspect-[1/2] after:w-[calc(var(--control-height)/8)] after:-translate-y-px after:rotate-45 after:border-r-2 after:border-b-2 after:border-primary-foreground after:opacity-0 checked:after:opacity-100",
          // Forced colours: hand the control back to the platform, which draws it in system colours.
          "forced-colors:appearance-auto forced-colors:before:hidden forced-colors:after:hidden"
        )}
        {...rest}
      />
      {label}
    </label>
  );
}
