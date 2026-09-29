import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

/** Composed status control with a shared accessibility contract.
 * The pressed-state contract combines `aria-pressed`, `aria-busy`, and disabled state.
 * `chores/ChoresBoard.tsx`'s mark-complete button hand-wires `aria-pressed` on a raw
 * `<button>` styled entirely with inline `style={{...}}` (a real, if correctly-implemented,
 * accessibility contract reimplemented ad hoc) with no `aria-busy` guard against a double-tap
 * while a previous toggle request is still in flight.
 * Admission test: * Accessibility* — owns `aria-pressed` (announces the current state) and
 * `aria-busy` + `disabled` (the in-flight guard) together, which is exactly the "role... or
 * keyboard contract call sites would otherwise reimplement or omit.
 * Built on `components/ui/button.tsx`, so it inherits density-token sizing for free —
 * this component never sets its own height or text size.
 * This component has no opinion on when a call site shows a
 * confirmation before toggling — that direction-specific guard belongs to `ConfirmDialog` and the
 * call site wiring them together (see `ConfirmDialog`'s file header). `StatusToggle` alone must
 * remain a single, ungated tap; do not add a confirmation step inside this component itself, or
 * every call site — including the constructive, unguarded direction — would inherit it.
 */
export interface StatusToggleProps {
  /** Current pressed/"done" state. */
  pressed: boolean;
  /** Localized VISIBLE button text — call-site-owned. For the chores convention this already
   * reflects the action a tap performs (e.g. "Mark done" / "Mark not done"). */
  label: ReactNode;
  /** Accessible-name override (call-site-owned, localized). REQUIRED — not defaulted to `label`.
   * `aria-pressed` is only coherent when the
   * accessible name is STATE-INVARIANT. A toggle whose name changes with its state is the
   * documented ARIA anti-pattern — pairing an action-shaped `label` (names what a tap DOES, e.g.
   * "Deactivate") with `aria-pressed` makes a screen reader announce the action as if it were
   * the state ("Deactivate, pressed" when the thing being toggled is actually active). That is
   * exactly what a `label`-defaulted accessible name produces whenever `label` is action-shaped —
   * and action-shaped labels in meals and chores would make this default incorrect. Making this
   * required forces every call site to make a deliberate choice instead of silently inheriting
   * the bug through the documentation (the same argument `WeekdayPicker`'s own `groupLabel` doc
   * already makes for the identical reason — required, not defaulted, because a forgotten prop
   * is a real, unenforced failure mode otherwise).
   * Pass a STATE-INVARIANT name — usually the entity's own name (e.g. "Weeknights", never
   * "Weeknights active") — and let `label` stay the action for sighted users. `aria-pressed`
   * already carries the state; a name that ALSO carries it announces the state twice and goes
   * stale the moment it flips. The name must not change when the state does. For a call site whose
   * `label` is ALREADY state-invariant (e.g. a chore's own name, unaffected by its completion
   * state), pass the same string as `label` — do NOT invert `label`'s meaning to make it
   * default-safe; that would silently change what chores' existing convention shows. */
  accessibleName: string;
  onPress: () => void;
  /** True while a previous press's request is still in flight — disables the control and sets
   * `aria-busy` so a call site cannot fire a second request by tapping again. */
  busy?: boolean;
  /** Pass `true` when `label` is USER-AUTHORED DATA (a chore/recipe/plan name) rather than a
   * fixed action string — forwards to `Button`'s `wrap` variant so a long label wraps
   * and grows instead of overflowing past this control's own box. Leave unset/`false` for a
   * fixed action label (e.g. "Activate"/"Deactivate"), which should stay single-line. */
  wrap?: boolean;
  className?: string;
  "data-testid"?: string;
}

export function StatusToggle({
  pressed,
  label,
  accessibleName,
  onPress,
  busy = false,
  wrap = false,
  className,
  ...rest
}: StatusToggleProps) {
  return (
    <Button
      type="button"
      variant={pressed ? "secondary" : "outline"}
      wrap={wrap}
      aria-pressed={pressed}
      aria-busy={busy || undefined}
      aria-label={accessibleName}
      disabled={busy}
      onClick={onPress}
      className={cn("justify-start", className)}
      {...rest}
    >
      {label}
    </Button>
  );
}
