import { NATIVE_SELECT_CLASSES } from "@/lib/recipes";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { ChoicePills } from "./ChoicePills";
import { PillToggle } from "./PillToggle";
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
 * Rendering: multi mode is a row of compact `PillToggle`s sized to fit one line in a dialog; single
 * mode is a native `<select>` or, with `renderAs="radio"`, `ChoicePills`. Days are SHOWN in the
 * household week-start order (`weekdayDisplayOrder`, from `useHouseholdSettings().weekStartDay`,
 * overridable with the `weekStartDay` prop); values are always EMITTED in
 * `CANONICAL_WEEKDAY_ORDER`, so storage never depends on the display order.
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

const SUNDAY_FIRST_ORDER: readonly WeekdayCode[] = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
];

/** The order weekdays are SHOWN in for a household week start (`locale.weekStartDay`: 0 = Sunday,
 * 1 = Monday). Anything but 0 — including null while settings load — is Monday-first. Use it for
 * display-only weekday loops (grids, table headers); store and sort with `CANONICAL_WEEKDAY_ORDER`. */
export function weekdayDisplayOrder(
  weekStartDay: number | null | undefined
): readonly WeekdayCode[] {
  return weekStartDay === 0 ? SUNDAY_FIRST_ORDER : CANONICAL_WEEKDAY_ORDER;
}

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
  /** Overrides the household week start (tests, previews). Normally omitted: the picker reads
   * `useHouseholdSettings().weekStartDay`. */
  weekStartDay?: 0 | 1;
}

export interface WeekdayPickerMultiProps extends WeekdayPickerCommonProps {
  mode?: "multi";
  value: readonly WeekdayCode[];
  onChange: (next: readonly WeekdayCode[]) => void;
  /** Days rendered disabled (still showing their value) — e.g. weekdays a parent setting has
   * switched off. Multi mode only. */
  disabledDays?: readonly WeekdayCode[];
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
  const household = useHouseholdSettings();
  const order = weekdayDisplayOrder(props.weekStartDay ?? household.weekStartDay);

  if (props.mode === "single") {
    const { value, onChange, renderAs = "select" } = props;

    if (renderAs === "select") {
      return (
        <select
          aria-label={groupLabel}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value as WeekdayCode)}
          className={cn(NATIVE_SELECT_CLASSES, className)}
          data-testid={testIdPrefix ? `${testIdPrefix}-select` : undefined}
        >
          {order.map((day) => (
            <option key={day} value={day}>
              {labels[day]}
            </option>
          ))}
        </select>
      );
    }

    // ChoicePills scopes the native radio group name per instance (useId), so two radio-mode
    // pickers on one page never share a group, with or without a testIdPrefix.
    return (
      <ChoicePills
        value={value}
        onChange={onChange}
        groupLabel={groupLabel}
        disabled={disabled}
        className={className}
        options={order.map((day) => ({
          value: day,
          label: labels[day],
          "data-testid": testIdPrefix ? `${testIdPrefix}-${day}` : undefined,
        }))}
      />
    );
  }

  const { value, onChange, disabledDays } = props;
  /** Always emits in `CANONICAL_WEEKDAY_ORDER`, regardless of click or display order, so callers
   * can save weekdays without sorting them again. */
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
    <div role="group" aria-label={groupLabel} className={cn("flex flex-wrap gap-1.5", className)}>
      {order.map((day) => (
        <PillToggle
          key={day}
          checked={value.includes(day)}
          onChange={() => toggle(day)}
          label={labels[day]}
          disabled={disabled || disabledDays?.includes(day)}
          // Compact padding so seven pills fit one line in a dialog at kiosk density.
          className="px-3"
          data-testid={testIdPrefix ? `${testIdPrefix}-${day}` : undefined}
        />
      ))}
    </div>
  );
}
