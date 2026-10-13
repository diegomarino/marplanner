import * as React from "react";

import { cn } from "@/lib/utils";

/** L2 composed component (FR-005/FR-006 — accessibility).
 * The one place SC-011 ("100% of error states across migrated surfaces are announced to
 * assistive technology") lives. Today some surfaces wrap an error string in
 * `<p role="alert">...</p>` (e.g. `admin/BackupsManagement.tsx`) and most do not — a plain
 * `<p className="text-red-600">` renders visibly but announces nothing. This component is the
 * ONE way every migrated surface reports an error from now on, so the live-region wiring is
 * written once, correctly, and never re-derived (or omitted) per surface.
 * * Accessibility* — owns the live-region role and politeness a
 * call site would otherwise reimplement inconsistently or skip entirely.
 * `message` is call-site-owned, already localized text (FR-019: translations stay with the
 * surface that owns the copy — this component has no i18n context of its own and introduces zero
 * new message keys, matching `components/ui/dialog.tsx`'s `closeLabel` convention). `null` /
 * `undefined` renders nothing — a surface with no active error mounts no live region at all,
 * which is itself a deliberate, testable contract (see this file's spec: a message re-appearing
 * after being cleared is a fresh DOM insertion, which every screen reader announces).
 */
export interface ErrorNoticeProps {
  /** The localized error message. Absent/`null` renders nothing. */
  message?: string | null;
  /** `"assertive"` (default) interrupts immediately — appropriate for most product errors, which
   * block a user action. `"polite"` waits for the current speech to finish — for a
   * non-blocking/background notice a surface wants to raise without interrupting.
   */
  politeness?: "assertive" | "polite";
  id?: string;
  className?: string;
  "data-testid"?: string;
}

export function ErrorNotice({
  message,
  politeness = "assertive",
  id,
  className,
  ...rest
}: ErrorNoticeProps) {
  if (!message) {
    return null;
  }

  return (
    <p
      id={id}
      role="alert"
      aria-live={politeness}
      aria-atomic="true"
      className={cn(
        "text-destructive border-destructive/40 bg-destructive/10 rounded-md border px-3 py-2 text-control font-medium",
        className
      )}
      {...rest}
    >
      {message}
    </p>
  );
}
