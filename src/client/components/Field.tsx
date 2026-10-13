import * as React from "react";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

import { ErrorNotice } from "./ErrorNotice";

/** L2 composed component (FR-005 — wiring).
 * This component enforces the "label↔input↔error association." Every admin surface could
 * otherwise hand-roll this relationship (a `<label>` next to an
 * `<input>` with no `htmlFor`/`id` pair, an error string rendered as a plain paragraph with no
 * `aria-describedby` back-reference). A call site using `Field` cannot get that association wrong
 * because it never writes the ids itself.
 * `children` is the control being wrapped — an `<Input>`, a `<SelectTrigger>`, or any single
 * element accepting `id` / `aria-describedby` / `aria-invalid`. It is cloned once to inject those
 * three attributes; the control's own density-correct sizing (from `components/ui/*`) is
 * untouched.
 */
export interface FieldProps {
  /** Localized label text (call-site-owned; this component adds no i18n keys). */
  label: string;
  /** Localized hint/help text, rendered between the label and the control. */
  hint?: string;
  /** Localized error text. Presence sets `aria-invalid` on the wrapped control and renders an
   * `ErrorNotice` wired to it via `aria-describedby`. */
  error?: string | null;
  children: React.ReactElement<{
    id?: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean | "true" | "false";
  }>;
  id?: string;
  className?: string;
}

export function Field({ label, hint, error, children, id, className }: FieldProps) {
  const autoId = React.useId();
  const fieldId = id ?? `field-${autoId}`;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  const control = React.cloneElement(children, {
    id: fieldId,
    "aria-describedby": describedBy,
    "aria-invalid": error ? "true" : undefined,
  });

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Label htmlFor={fieldId}>{label}</Label>
      {hint && (
        <p id={hintId} className="text-muted-foreground text-control">
          {hint}
        </p>
      )}
      {control}
      <ErrorNotice id={errorId} message={error} />
    </div>
  );
}
