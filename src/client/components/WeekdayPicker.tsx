import { useId } from "react";
import { CheckboxField } from "./CheckboxField";
import { RadioField } from "./RadioField";
import { cn } from "@/lib/utils";

/** L2 composed component (FR-005, SC-009 — wiring and accessibility).
 * Provides the canonical weekday order used by five admin surfaces:
 * `admin/RoutinesManagement.tsx` (`WEEKDAYS`), `admin/RemindersManagement.tsx`
 * (`WEEKDAYS`), `admin/MealsManagement.tsx` (`WEEKDAYS`), `admin/TimeAnnouncementsManagement.tsx`
 * (`WEEKDAYS`) and `admin/DailyBriefingManagement.tsx` (`CANONICAL_WEEKDAYS`) — each also
 * redeclares the seven-day literal array itself, drifting the canonical `mon..sun` order into
 * five separate places.
 * Those five files contain * seven* individual weekday-rendering sites (a constant can be
 * looped over more than once per file): `RoutinesManagement` (1), `RemindersManagement` (3 — the
 * create-form weekday set, `ReminderCard`'s inline-edit weekday set, and `AssignmentMatrixGrid`'s * per-member table), `MealsManagement` (1), `TimeAnnouncementsManagement` (1) and
 * `DailyBriefingManagement` (1). This component is designed to replace * six* of those seven —
 * five in * multi* mode (`RoutinesManagement`, `RemindersManagement`'s create form and inline
 * edit, `TimeAnnouncementsManagement`, `DailyBriefingManagement`) and one in * single* mode
 * (`MealsManagement`, via `renderAs="select"` — see below).
 * * The one deliberate exception* `RemindersManagement`'s `AssignmentMatrixGrid`. It is a
 * member × weekday table — day labels appear once in `<thead>`, and each `<td>` holds a bare,
 * label-less checkbox with an `onChange` that carries a `memberId` dimension this component's
 * `onChange` signature has no room for. This component always renders a `role="group"` wrapper
 * of seven *labelled* fields; forcing the matrix through it would render 7×N day labels inside
 * the table body and break `tests/e2e/reminders.spec.ts`'s positional cell indexing. SC-009's
 * "one canonical order, not five" still holds for the matrix without migrating its markup: it
 * can import `CANONICAL_WEEKDAY_ORDER` from this file for its two `.map` loops instead of
 * keeping its own local literal.
 * The six replaced sites are NOT all shaped the same, which is why this component has two modes:
 * - * multi* a set of days, toggled independently — checkbox semantics. Used by
 * `RoutinesManagement`, `RemindersManagement`'s create form and `ReminderCard`'s inline edit,
 * `TimeAnnouncementsManagement`, and `DailyBriefingManagement` (per-member, per-block weekday
 * overrides) — all select an arbitrary subset of days.
 * - * single* exactly one day — radio or `<select>` semantics, per `renderAs`.
 * `MealsManagement`'s recurring-entry authoring form picks the single weekday a recipe
 * repeats on via a native `<select value={weekday}>`, not a checkbox group — collapsing it
 * into "multi" would let a caller select zero or several days for a control that means
 * exactly one, silently changing behaviour (the enforcement contract explicitly forbids
 * that: "No behaviour change"). `renderAs` defaults to `"select"` so adopting this component
 * preserves that surface's existing dropdown instead of forcing it into seven radios.
 * * Wiring:* coordinates a group of controls (checkbox, radio, or `<select>`)
 * that today each of the six replaced sites re-derives independently, including the day ORDER
 * and the loop/label-association shape. * Accessibility* — the group role (`"group"` for an
 * independently-toggled set, `"radiogroup"` for a mutually exclusive choice) and, in single
 * radio mode, the native `name` grouping that makes arrow-key/exclusive-selection semantics
 * work — none of the six existing implementations sets a group role today.
 * Internally built on `CheckboxField`/`RadioField` (this file is not a thin style wrapper around
 * either — it owns the mode branch, the canonical day order, and the group-level a11y role).
 */

export type WeekdayCode = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

/** Canonical weekday order, Monday through Sunday. */
export const CANONICAL_WEEKDAY_ORDER: readonly WeekdayCode[] = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
];

export type WeekdayLabels = Readonly<Record<WeekdayCode, string>>;

interface WeekdayPickerCommonProps {
  /** Localized day labels (call-site-owned — every existing call site has its own translation
   * namespace for these, e.g. `routines.assignments.weekday.mon` vs `meals.plan.weekday.mon`;
   * this component introduces no shared i18n keys and does not force one namespace on all five). */
  labels: WeekdayLabels;
  disabled?: boolean;
  className?: string;
  /** Accessible name for the group. Required — not defaulted — because three of the six
   * replaced call sites render their own visible caption as a flex sibling and MUST still pass a
   * localized `groupLabel` for the accessible name (a caller that forgets ships the English
   * literal "Weekdays" as the accessible name on every non-English kiosk, which no runtime check
   * can catch; requiring the prop makes the compiler catch it instead). */
  groupLabel: string;
  /** Prefix for each day's `data-testid` (`${testIdPrefix}-${day}`, or `${testIdPrefix}-select`
   * in single `renderAs="select"` mode), matching the existing per-surface `data-testid`
   * convention (e.g. `time-announcements-weekday-mon` today). */
  testIdPrefix?: string;
}

export interface WeekdayPickerMultiProps extends WeekdayPickerCommonProps {
  mode?: "multi";
  value: readonly WeekdayCode[];
  onChange: (next: readonly WeekdayCode[]) => void;
}

export interface WeekdayPickerSingleProps extends WeekdayPickerCommonProps {
  mode: "single";
  value: WeekdayCode;
  onChange: (next: WeekdayCode) => void;
  /** How the single-day choice renders. Defaults to `"select"` — a native `<select>` — so
   * `MealsManagement`'s existing dropdown (and its `.selectOption(...)`-driven e2e coverage,
   * `tests/e2e/meals.spec.ts`) keeps working unchanged when it adopts this component. Pass
   * `"radio"` for a call site that wants the labelled radiogroup instead. */
  renderAs?: "select" | "radio";
}

export type WeekdayPickerProps = WeekdayPickerMultiProps | WeekdayPickerSingleProps;

export function WeekdayPicker(props: WeekdayPickerProps) {
  const { labels, disabled, className, groupLabel, testIdPrefix } = props;
  // Called unconditionally, before the mode branch — hooks cannot sit inside a conditional.
  const instanceId = useId();

  if (props.mode === "single") {
    const { value, onChange, renderAs = "select" } = props;

    if (renderAs === "select") {
      return (
        <select
          aria-label={groupLabel}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value as WeekdayCode)}
          className={cn(
            "border-input h-[var(--control-height)] rounded-md border px-2 text-[length:var(--control-font-size)]",
            className
          )}
          data-testid={testIdPrefix ? `${testIdPrefix}-select` : undefined}
        >
          {CANONICAL_WEEKDAY_ORDER.map((day) => (
            <option key={day} value={day}>
              {labels[day]}
            </option>
          ))}
        </select>
      );
    }

    // The group name MUST be instance-unique. A shared fallback made two radio-mode pickers on the
    // same page one NATIVE radio group, so selecting in one cleared the other and arrow keys moved
    // focus across them — and the props permit rendering without a testIdPrefix.
    // `useId` is per-instance, so the collision cannot occur even when a caller omits the prefix.
    // ALWAYS instance-scoped, not just as a fallback. Deriving it from testIdPrefix left two
    // pickers that share a prefix in one native radio group — a narrower guard than the defect
    // class, and the safe form costs nothing since the name is never asserted on by callers.
    const groupName = `${testIdPrefix ?? "weekday-picker"}-${instanceId}`;
    return (
      <div
        role="radiogroup"
        aria-label={groupLabel}
        className={cn("flex flex-wrap gap-3", className)}
      >
        {CANONICAL_WEEKDAY_ORDER.map((day) => (
          <RadioField
            key={day}
            name={groupName}
            value={day}
            checked={value === day}
            onChange={() => onChange(day)}
            label={labels[day]}
            disabled={disabled}
            data-testid={testIdPrefix ? `${testIdPrefix}-${day}` : undefined}
          />
        ))}
      </div>
    );
  }

  const { value, onChange } = props;
  /** Always emits in `CANONICAL_WEEKDAY_ORDER`, regardless of click order, so callers can
   * save weekdays without sorting them again. */
  const toggle = (day: WeekdayCode) => {
    const next = new Set(value);
    if (next.has(day)) {
      next.delete(day);
    } else {
      next.add(day);
    }
    onChange(CANONICAL_WEEKDAY_ORDER.filter((d) => next.has(d)));
  };

  return (
    <div role="group" aria-label={groupLabel} className={cn("flex flex-wrap gap-3", className)}>
      {CANONICAL_WEEKDAY_ORDER.map((day) => (
        <CheckboxField
          key={day}
          checked={value.includes(day)}
          onChange={() => toggle(day)}
          label={labels[day]}
          disabled={disabled}
          data-testid={testIdPrefix ? `${testIdPrefix}-${day}` : undefined}
        />
      ))}
    </div>
  );
}
