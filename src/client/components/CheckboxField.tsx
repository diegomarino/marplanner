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
        "inline-flex items-center gap-2 text-[length:var(--control-font-size)]",
        disabled && "opacity-50",
        className
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="accent-primary border-input size-[var(--control-height)] shrink-0 rounded-sm text-[length:var(--control-font-size)]"
        {...rest}
      />
      {label}
    </label>
  );
}
