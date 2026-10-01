// Recipes — documented class combinations for plain HTML controls
// that do not need a shared component for state, wiring or accessibility and are
// therefore NOT shared components under `src/client/components/`.
//
// This module is the ONE place a recipe's class string is DEFINED. The prose reasoning for each —
// why it is a recipe and not a component, and any constraint on its use — lives in
// `docs/development/style-guide.md`, not here (cite, never restate). If this module and the guide
// ever disagree on a VALUE, this module wins; the guide documents, it does not define.
//
// Owner: each new recipe is added here and documented in the style
// guide in the same change. A private,
// undocumented class-string constant declared inside a surface file is exactly the anti-pattern
// this module exists to end — see the `no-restricted-syntax` selector in
// `eslint.config.mjs` that flags one outside this file.

/** A single-line caption+control pair, the control nested INSIDE the `<label>` (implicit
 * label/control association) — e.g. `<label className={LABEL_INLINE_CLASSES}><input.../> Week
 * of</label>`. See the style guide for the accessibility constraints. */
export const LABEL_INLINE_CLASSES = "text-muted-foreground inline-flex items-center gap-2 text-xs";

/** A plain native `<select>`, styled to the token dialect without adopting the Radix
 * `components/ui/select.tsx` primitive. See the style guide for why (`.selectOption` in
 * `tests/e2e/meals.spec.ts` requires a real native element). */
export const NATIVE_SELECT_CLASSES =
  "border-input h-[var(--control-height)] rounded-md border bg-transparent px-2 text-control";

/** A bare, density-sized `<input type="checkbox">` with NO visible label — the one shape
 * `WeekdayPicker`/`CheckboxField` deliberately does not cover (a member × weekday matrix cell,
 * `admin/RemindersManagement.tsx`'s `AssignmentMatrixGrid`, per `WeekdayPicker`'s own file-header
 * doc comment). Mirrors `CheckboxField`'s internal `<input>` classlist exactly (density-token
 * sizing via `size-[var(--control-height)]`) minus the wrapping `<label>` + visible text, which
 * would repeat a day abbreviation in every table cell. See the style guide for why this is a
 * recipe and the accessible-name obligation that comes with dropping the visible label. */
export const BARE_CHECKBOX_INPUT_CLASSES =
  "accent-primary border-input size-[var(--control-height)] shrink-0 rounded-sm text-control";
