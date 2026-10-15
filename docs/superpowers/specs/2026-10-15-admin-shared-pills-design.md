# Admin shared pills: member pills, weekday pills, segmented choice

Date: 2026-10-15. Status: approved by delegation (the owner waived review; decisions below are binding for the executor and for the six page reworks that consume this wave).

## Intent

The owner reviewed the reworked admin pages and wants one consistent look and behaviour for the three selection shapes that recur across admin:

1. **Member pills**: pick one member, or several, each pill in the member's own colour.
2. **Weekday pills**: a one-line row of seven toggles that follows the household week-start setting.
3. **Segmented choice**: pick exactly one of 2–4 options (e.g. reminder kind "Scheduled | Calendar-gated", Settings language and week start).

Six page reworks start in parallel right after this wave merges and will all use these components. So the API must be small, stable and documented, and this wave should not do page work beyond migrating call sites that are clearly the same pattern and cheap to move.

Success criteria:

- Page workers import `ChoicePills`, `MemberPills` and `WeekdayPicker` from `@/ui` (or their component files). They don't need to hand-roll pills, member colours, radiogroups or day ordering.
- Every pill is a native checkbox or radio laid over the whole pill, so keyboard use, form semantics, accessible names and the kiosk density minimum come for free. This is the technique `PillToggle` already uses.
- The weekday row follows `locale.weekStartDay` (0 = Sunday, 1 = Monday) and fits on one line inside the Routines "Assign routine" dialog at both densities.
- `npm run check:standard` passes and the affected e2e specs pass.

## Current state (verified by reading the code at `feat/admin-parity` 53515cf7)

- `src/client/components/PillToggle.tsx`: a checkbox pill. A `<label>` draws the pill, and an invisible native `<input type="checkbox">` (`absolute inset-0 h-[var(--control-height)] w-full opacity-0`) covers it. `selectedStyle` replaces the accent fill while the pill is checked, and is applied through an inline `style` that carries the `ui-policy/debt` disable. It is used by `CalendarView` (participants and filters, with `memberFilterStyle(colorKey)`), `HighlightRuleCard`, `ExternalSourceCard` and `RecipeDialog`.
- `src/client/calendar/member-event-style.ts` exports `memberFilterStyle(key)`, the selected member-pill tint (24% member colour mixed with `--member-mix-ground`, member border, foreground text).
- `src/client/components/WeekdayPicker.tsx` has two modes:
  - Multi (default): a `role="group"` of `CheckboxField`s, with `disabledDays` added by Briefing pause.
  - Single: a native `<select>` (the default) or `renderAs="radio"`, a `role="radiogroup"` of `RadioField`s.

  It always renders `CANONICAL_WEEKDAY_ORDER` (mon..sun) and ignores the household week start. `onChange` in multi mode emits canonical order. Call sites: Routines `AssignmentDialog`, Reminders (create form and inline edit), Time announcements, Daily briefing block matrix (with `disabledDays`, and `className="grid grid-cols-7 gap-2"` under a `<thead>` that also maps `CANONICAL_WEEKDAY_ORDER`), and Meals (single select).
- `src/client/daily-briefing/admin/BriefingMemberPills.tsx` is a `role="tablist"` of `Button role="tab"` with a colour dot from a static `MEMBER_DOT_CLASS` map. It also exports `pillMembers()`. It is used twice: `BriefingWorkspace` and `DailyBriefingManagement`. Unit tests assert `aria-selected` on two pills (`tests/client/daily-briefing-management.test.tsx:100`).
- `src/client/admin/SettingsManagement.tsx` has a local `ChoicePills` (described as "not a shared primitive"): a `role="radiogroup"` of `Button role="radio" aria-checked`, used for language and week start. Tests assert `aria-checked` (`tests/client/settings-management.test.tsx:218,234`, `tests/e2e/admin-settings.spec.ts:54`).
- The household week start comes from `useHouseholdSettings().weekStartDay` (`src/client/lib/householdSettings.tsx`). It is `null` outside a provider or before the load completes. The server accepts only 0 or 1.
- Tooling constraints:
  - `COMPONENTS.md` is generated from `src/client/ui.ts` re-exports. Each re-exported file must be `.tsx` and is listed by its exported declarations; `check:ui-catalog` fails on drift.
  - `no-restricted-syntax` forbids `*_CLASSES`/`*Classes` constants outside `src/client/lib/recipes.ts`.
  - `ui-policy/raw-controls` rejects raw `<input>`s unless there is an exact per-line disable. `ui-policy/debt` counts inline styles; the baseline is 140 and the current count is 13.
  - The accessible-names audit treats a control inside an ancestor `<label>` as strongly named.
  - The kiosk-density helper (`tests/client/helpers/density.ts`) measures the native input's height (48px) and font (18px) in kiosk.

## Decisions

**D1 — One drawing primitive, internal.** Add `src/client/components/PillControl.tsx`. It renders the pill `<label>` plus the stretched native `checkbox` or `radio`. It owns the pill class string, the single `ui-policy/raw-controls` disable and the single `ui-policy/debt` style forward, all moved verbatim from `PillToggle`, so the inline-style count stays at 13. It also supports a decorative `adornment` (`aria-hidden`) and a visible `note` that is part of the accessible name. It is not exported from `@/ui`, and page code must not import it. `PillToggle`, `ChoicePills` and `MemberPills` are its only consumers.

**D2 — `PillToggle` keeps its exact public API.** It becomes a thin wrapper over `PillControl type="checkbox"`. Its existing tests stay unchanged.

**D3 — Segmented choice = new `ChoicePills<T extends string>`** (`src/client/components/ChoicePills.tsx`). It is a `role="radiogroup"` of radio pills that share one `useId()` name, so arrow keys and exclusivity are native. It looks the same as `PillToggle`, so single-choice and multi-choice pills read as one visual language. It is not a joined segmented track. Settings' local `ChoicePills` is replaced by it; the local wrapper that adds the caption and description is renamed `ChoiceRow`. `PillToggle` is not stretched to cover radios, because its `onChange(checked)` contract is checkbox-shaped.

**D4 — Member pills = new `MemberPills`** (`src/client/components/MemberPills.tsx`). It has two modes, mirroring `WeekdayPicker`:
- `mode: "single"`: a radiogroup, `value: string | null`, `onChange(memberId)`.
- `mode?: "multi"` (the default): a `role="group"` of checkboxes, `value: readonly string[]`, `onChange(next)`. `next` lists the members in `members` order and keeps any selected id that isn't in `members` (it never silently drops a hidden member), appended in its original order.

Every pill shows a member-colour dot through a static class map (`MEMBER_DOT_CLASS`, moved from `BriefingMemberPills`; the name is singular so the class-constant lint does not apply). When selected, the pill takes `memberFilterStyle(colorKey)`, the same tint as the calendar member filters.

Per-member `disabled`. Per-member `inactiveLabel?: string`: when set, the pill is drawn inactive (dashed border) and shows `(inactiveLabel)` after the name, which also becomes part of the accessible name, so colour is never the only signal. Callers own every string; shared components don't call `useT()`, which is the existing convention.

**D5 — `WeekdayPicker` is extended, not duplicated.**
- Multi mode renders `PillToggle`s with `className="px-3"` (compact; `cn` merges this over `px-4`) in a `flex flex-wrap gap-1.5` group, so seven pills fit on one line in a `sm:max-w-xl` dialog at kiosk density. The estimate is about 62px per pill plus gaps ≈ 470px against about 500px of content width.
- `renderAs="radio"` renders through `ChoicePills`.
- The `select` rendering is unchanged.
- `disabledDays`, `groupLabel`, `labels` and `testIdPrefix` (still `${prefix}-${day}` on the native input) keep their meaning.

**D6 — Week start.** `WeekdayPicker` exports `weekdayDisplayOrder(weekStartDay: number | null | undefined): readonly WeekdayCode[]`. It returns Sunday-first for `0` and the canonical Monday-first order otherwise, including `null`.

`WeekdayPicker` displays days in `weekdayDisplayOrder(props.weekStartDay ?? useHouseholdSettings().weekStartDay)` in every mode, including the select. The optional `weekStartDay?: 0 | 1` prop exists for tests and for previews; callers normally omit it.

**Stored order never changes:** multi-mode `onChange` still emits `CANONICAL_WEEKDAY_ORDER` order, and `CANONICAL_WEEKDAY_ORDER` stays exported for storage and sorting.

**D7 — Keep the Daily briefing matrix aligned.** Its `<thead>` maps `CANONICAL_WEEKDAY_ORDER` above a `grid-cols-7` `WeekdayPicker`. With a Sunday-first household, the header and the pills would no longer line up. This wave changes that one header map to `weekdayDisplayOrder(useHouseholdSettings().weekStartDay)`. Nothing else in the file changes, apart from removing the import if it becomes unused (it doesn't, because lines 682–690, 1218 and 1380 still use the canonical order for data).

**D8 — Cheap migrations done in this wave:**
- `BriefingMemberPills`: the file and its props stay, but its body becomes `<MemberPills mode="single" …>`. Semantics change from tab to radio, and two unit assertions move from `aria-selected` to `toBeChecked()`. The call sites are untouched, and `pillMembers()` stays.
- Settings: uses the shared `ChoicePills`. Two unit assertions and one e2e assertion move from `aria-checked` to `toBeChecked()`.
- Every existing `WeekdayPicker` call site (Routines dialog, Reminders, Time announcements, Briefing) gets the pill look and week-start order automatically, with no call-site edit.

**D9 — Left for page workers (listed, not migrated):**
- Display-only weekday loops that still use the canonical order and should switch to `weekdayDisplayOrder(...)` when their page is reworked:
  - `src/client/routines/admin/RoutineWeekGrid.tsx:57`
  - `src/client/admin/RemindersManagement.tsx:928,941` (`AssignmentMatrixGrid`)
  - `src/client/admin/TimeAnnouncementsManagement.tsx:327,347`
  - `src/client/admin/DailyBriefingManagement.tsx` pause row (the `CheckboxField`s inside the same header now follow display order through D7)
- The Reminders kind control → `ChoicePills`.
- Member selection in the Reminders specific-targeting assignments, if the page keeps a member picker → `MemberPills`.
- `CalendarView` participants and filters (`PillToggle` + `memberFilterStyle`) → `MemberPills mode="multi"`. This is a family surface, not admin, so it's optional.
- The Daily briefing matrix repeats the day label inside each pill under a labelled column. That page's worker may want label-less cells; that's out of scope here.

**D10 — Not added:** `size`/`variant` props, a joined segmented track look, `aria-describedby` plumbing, audit-map entries in `tools/dev/audit-accessible-names.mjs` (the inner inputs are already strongly named by their wrapping `<label>`, and `groupLabel` is a required prop), and new i18n keys.

## Public API (stable contract for page workers)

All three are exported from `@/ui` (`src/client/ui.ts`) and listed in `COMPONENTS.md`.

```ts
// src/client/components/ChoicePills.tsx
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
export function ChoicePills<T extends string>(props: ChoicePillsProps<T>): JSX.Element;

// src/client/components/MemberPills.tsx
export interface MemberPillsMember {
  id: string;
  displayName: string;
  colorKey: MemberColorKey;
  disabled?: boolean;
  /** Localized marker such as "inactive"; when set the pill is drawn inactive and the marker
   * follows the name (and is part of its accessible name). */
  inactiveLabel?: string;
}
interface MemberPillsCommonProps {
  /** Display order. A MemberDTO/Member satisfies this structurally. */
  members: readonly MemberPillsMember[];
  /** Accessible name of the group (required, localized). */
  groupLabel: string;
  /** `${testIdPrefix}-${member.id}` on each native input. */
  testIdPrefix?: string;
  disabled?: boolean;
  className?: string;
}
export interface MemberPillsSingleProps extends MemberPillsCommonProps {
  mode: "single";
  value: string | null;
  onChange: (memberId: string) => void;
}
export interface MemberPillsMultiProps extends MemberPillsCommonProps {
  mode?: "multi";
  value: readonly string[];
  /** Selected ids in `members` order, followed by any selected ids not in `members`. */
  onChange: (next: string[]) => void;
}
export type MemberPillsProps = MemberPillsSingleProps | MemberPillsMultiProps;
export function MemberPills(props: MemberPillsProps): JSX.Element;

// src/client/components/WeekdayPicker.tsx (additions only; everything existing is unchanged)
export function weekdayDisplayOrder(weekStartDay: number | null | undefined): readonly WeekdayCode[];
// WeekdayPickerCommonProps gains:
//   /** Overrides the household week start (tests, previews). Normally omitted. */
//   weekStartDay?: 0 | 1;
```

Usage cheat sheet for page workers:

| Need                                  | Use                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| One independent on/off pill           | `PillToggle`                                                                    |
| Exactly one of 2–4 options            | `ChoicePills`                                                                   |
| One member / several members          | `MemberPills mode="single"` / `MemberPills` (multi)                             |
| Set of weekdays (one line)            | `WeekdayPicker` (multi), with `disabledDays` when a parent switch rules days out |
| One weekday                           | `WeekdayPicker mode="single"` (select by default, `renderAs="radio"` for pills) |
| Display-only weekday loop (grid, row) | `weekdayDisplayOrder(useHouseholdSettings().weekStartDay)`                      |
| Storing or sorting weekdays           | `CANONICAL_WEEKDAY_ORDER`                                                       |

## Visual and behavioural rules

- Pill (from `PillToggle`, unchanged): `h-[var(--control-height)] rounded-lg border px-4 text-control font-medium`, with a muted look when unchecked, the accent fill when checked (or `selectedStyle`), a 3px focus ring from `has-[:focus-visible]`, and `opacity-50 cursor-not-allowed` when disabled.
- `adornment` is rendered before the label as `<span aria-hidden="true" class="mr-2 inline-flex shrink-0">`.
- `note` is rendered after the label as `<span class="text-muted-foreground ml-1 font-normal"> ({note})</span>`.
- Member pill: a `size-3 rounded-full border border-background` dot in `bg-member-<key>-500`. When selected it uses `memberFilterStyle(colorKey)`; when inactive it adds `border-dashed`.
- Group layout: `flex flex-wrap gap-2` (members, choices) or `flex flex-wrap gap-1.5` (weekdays). A caller's `className` is merged last.
- Kiosk density: the native input is full control height, and the text uses `text-control`. Tests use `assertKioskDensityCompliant`.
- Keyboard: radiogroups move with the arrow keys natively (one tab stop per group). Checkbox pills each take a tab stop and toggle with Space.

## Testing

- New `tests/client/choice-pills.test.tsx`: named radiogroup; options in order; only the current value checked; `null` leaves none checked; clicking emits the value; group and option `disabled`; two instances get distinct native names; kiosk density.
- New `tests/client/member-pills.test.tsx`:
  - Multi: named group of checkboxes; toggling emits `members` order; keeps unknown ids; disabled member; inactive marker in the accessible name plus `border-dashed`; selected style carries the member token; testids.
  - Single: radiogroup; emits the id; `null` leaves none checked.
  - Kiosk density in both modes.
- `tests/client/weekday-picker.test.tsx` adds:
  - `weekdayDisplayOrder` unit cases (0, 1, null, undefined, 7).
  - The household week start of 0 puts Sunday first, read through a hoisted `vi.mock("@/lib/householdSettings")`.
  - The prop override wins over the household value.
  - Multi `onChange` still emits canonical order when Sunday-first.
  - Select mode follows the display order.
- Existing tests updated as listed in D8.
- e2e:
  - `tests/e2e/admin-routines.spec.ts` asserts that the seven weekday inputs of one assignment row share one line (equal `boundingBox().y`).
  - `tests/e2e/admin-settings.spec.ts:54` uses `toBeChecked()`.
- Inventory: resync `tests/fixtures/assembly-cohort.json`. That means coverage entries for the three new source files and remeasured entries for the changed ones, plus the vitest cohort for the new and changed tests, and the playwright ids, which are unchanged unless the routines spec changes test titles (it doesn't).

## Assumptions

- A1: Admin pages render under `HouseholdSettingsProvider` (verified: `src/client/shell/Shell.tsx:222` wraps all provisioned routes), so `WeekdayPicker` can read the week start without props.
- A2: jsdom does not apply Tailwind's `opacity-0` (the density injector compiles only the density candidates), so existing `toBeVisible()` assertions on testids that move onto stretched inputs keep passing. This is already the case for `PillToggle` call sites.
- A3: Playwright treats `opacity: 0` elements as visible and clickable. Existing `.check()`/`.click()` calls on weekday and member testids keep working (the `PillToggle` calendar pills already rely on this).
- A4: Importing `memberFilterStyle` from `@/calendar/member-event-style` into `src/client/components/` is acceptable. G5 restricts only `components/ui/*`. Moving the helper is not worth the churn now.
