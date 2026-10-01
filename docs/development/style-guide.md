# UI style guide

A shared component is justified when it owns state, coordinates multiple elements, or carries an accessibility or keyboard contract. A reusable class combination with none of those responsibilities is a recipe. The class string lives once in `src/client/lib/recipes.ts`; this guide explains when to use it. Check existing primitives in `src/client/components/` and `src/client/components/ui/` before adding either.

A recipe is documented here with its export name, purpose and constraints, without copying its class string. Shared primitive changes require checks across consumers. The [component contract](../ui/component-contract.md) defines density, tokens, accessible names and the exception-list ratchet.

## Adding a recipe

1. Reuse an existing control if its state, wiring and accessibility contract match.
2. When the new shape has no state, wiring or accessibility of its own, export its class string from `src/client/lib/recipes.ts`.
3. Add a section below naming the export, purpose and reuse constraint. Keep the exact class value in code only.
4. Import the recipe at call sites. Review duplicate class strings in affected consumers and record any out-of-scope duplication for later work.

Identical strings across many call sites remain recipes. A composed component is justified by a shared structural or behavioral contract, not a count of string uses.

## The recipes

### `LABEL_INLINE_CLASSES`

See `src/client/lib/recipes.ts` for the current class string — deliberately not quoted here (see
_Mechanization_ below for why a copy in this file has no way to stay in sync with the module).

**What it's for**: a single-line caption+control inline pair, the control nested **inside** the
`<label>` — e.g. a checkbox or native `<select>` with a short trailing/leading caption. The
wrapping `<label>` is what associates caption and control; nothing else is needed for a
single-line pair. Mirrors `CheckboxField`/`RadioField`'s own `inline-flex items-center gap-2`
shape, so this recipe keeps a plain (non-Field) caption+control pair visually consistent with the
components that _do_ carry that wiring.

**Why it's a recipe, not a component** — fails all three D3 tests for this shape:

- **State**: none. There is nothing to open/close or hold pending.
- **Wiring**: none beyond what the native `<label>` wrapper already gives for free — nesting a
  control inside a `<label>` is an implicit association the browser provides, not something this
  recipe coordinates.
- **Accessibility**: none beyond the same native wrapping. No role, no live region, no keyboard
  contract of its own.

**Constraints on use**:

- **Single-line pairs only.** A multi-line control (e.g. a `<textarea>`) does not fit inside an
  inline-flex label the way a single-line caption+input pair does — use a **sibling** `<label>`
  with an explicit `htmlFor`/`id` pair instead (see the multiline-input guidance below for the
  textarea case, and the correction this project made in `MealsManagement.tsx` after an earlier
  revision wrongly wrapped one).
- **`text-xs` does not scale with density** (HIGH-3, independent review on PR #760): FR-004 shipped
  no typography token for kiosk-scaled caption text, so a caption using this recipe stays 12px in
  both comfortable and kiosk density, while every control around it grows 14px → 18px. Tracked in
  #754 — there is no better option until a caption/label font-size token lands. A batch adopting
  this recipe inherits that gap; it is not something to work around locally.
- **The "no wiring needed" premise is deferred for some call sites**, not universally settled.
  Issue #764 found that specific label+control pairs claimed to be "a simple, already-correctly
  associated caption" (the reasoning that justified rejecting `Field` here) were in fact missing
  real association or a visible label entirely — a `Field`-shaped need, not this recipe's. Workers
  have no network egress in this fleet, so **the operative text is this summary, not the issue
  number**: a batch citing `MealsManagement.tsx` as D3 precedent for skipping `Field` must weigh the
  finding above, not just this entry's D3 verdict, before assuming the label+control pair it's
  copying is actually already correctly associated.

---

### `NATIVE_SELECT_CLASSES`

See `src/client/lib/recipes.ts` for the current class string.

**What it's for**: styles a plain native `<select>` to the token dialect (border colour, density-
aware height and text size) without adopting the Radix-based `src/client/components/ui/select.tsx`
primitive.

**Why it's a recipe, not a component** — fails all three D3 tests:

- **State**: none owned here. A native `<select>` already owns its own open/closed state; this
  recipe contributes nothing beyond CSS classes.
- **Wiring**: none. There is only one element; nothing is coordinated.
- **Accessibility**: none beyond what the native `<select>` element already carries — its own role
  and keyboard contract are the browser's, not this recipe's.

**Constraint on use**: prefer the `ui/select.tsx` primitive by default — **only** reach for this
recipe when something external depends on a real native `<select>` element. The concrete case that
justified it: `tests/e2e/meals.spec.ts` drives the control via Playwright's `.selectOption()`,
which requires a native `<select>`; swapping in the Radix primitive would have broken that test.
Adopting this recipe elsewhere without an equivalent external constraint reintroduces exactly the
inconsistency the primitive layer exists to remove — check whether the constraint still applies
before copying this recipe into a new surface.

---

### Multiline inputs

Use `Textarea` from `@/ui`. The former `NATIVE_TEXTAREA_CLASSES` stand-in is retired after its last consumer migrated. `rows`, native editing/selection, localized labels and taller minimums remain caller-owned; height and font density come from the primitive.

---

### `BARE_CHECKBOX_INPUT_CLASSES`

See `src/client/lib/recipes.ts` for the current class string.

**What it's for**: a density-sized `<input type="checkbox">` with no visible label — the one
render site `WeekdayPicker`'s own file header names as its deliberate exception,
`admin/RemindersManagement.tsx`'s `AssignmentMatrixGrid` (a member × weekday table: day labels
live once in `<thead>`, each `<td>` holds a bare checkbox whose `onChange` needs a `memberId`
dimension `WeekdayPicker`'s signature has no room for). Wrapping it in `CheckboxField` instead
would work functionally but renders `CheckboxField`'s own visible `label` text inline after the
input — repeating a day abbreviation in every one of `members × 7` cells, which the table's own
`<thead>` already provides once per column.

**Why it's a recipe, not a component** — fails all three D3 tests: **State** — none, the checkbox
owns its own checked state via the controlled `checked`/`onChange` props already, same as any
native checkbox. **Wiring** — none, a single element, nothing coordinated. **Accessibility** —
none beyond the native checkbox's own role; sizing classes carry no role/live-region/keyboard
contract of their own.

**Constraint on use**: dropping the visible label is only safe when the call site supplies a REAL
`aria-label` per control — the table's row/column headers do not automatically become the
checkbox's accessible name (a screen reader's table-navigation announcement of the row/column
headers is a separate channel from the control's own accessible name, which `audit-accessible-
names.mjs` correctly scores `NONE` for a bare, unlabelled checkbox). `AssignmentMatrixGrid`
combines the member's display name and the day's own localized label into one `aria-label` per
cell for exactly this reason. A call site adopting this recipe without an equivalent per-control
label reintroduces the unnamed-control defect this recipe's own adoption was meant to close.

---

## Enforcement and review limits

The recipe rule catches variables and object properties whose names end in `Classes` or `_CLASSES`, regardless of initializer shape (including concatenation, arrays, `join`, `cn`, casts and exports). It can flag unrelated values with those names; justify a necessary suppression at the line. Renamed values and inline class strings still need review. This is a naming-convention net, not a general expression evaluator.

Control text uses the shared `text-control` utility. `cn` registers it as a font-size class with tailwind-merge, so semantic foreground classes do not erase density typography.

Native selects are a supported platform choice for these forms, not a defect imposed by tests. Use `NATIVE_SELECT_CLASSES` consistently; changing a select to Radix requires a concrete interaction need and native/browser test migration.

Keep each recipe value in `src/client/lib/recipes.ts` only. A copied value in this guide can drift while typecheck, lint and focused tests remain green. The entries above explain purpose and constraints without duplicating the class strings.

## Portalled controls and browser tests

Radix dialogs and other portalled content render outside the surface's DOM subtree. When adopting `ConfirmDialog` or another portal, inspect browser locators that scope a control to a parent row or container. If the scope was only an incidental way to find a unique dialog, update the locator to a role or stable dialog target and verify the same user action. If the ancestor relation is itself the behavior under test, preserve that contract and explain the choice. A portal does not by itself make a shared component unsuitable.

## User-authored labels in buttons

`Button` uses a compact, single-line base for fixed actions such as Save and Cancel. For a label supplied by a household member, use `<Button wrap>` or `<StatusToggle wrap>` so the control can grow vertically and shrink inside a flex row. The variant includes `wrap-anywhere` for long unbroken strings; `whitespace-normal` or `break-words` alone leaves an `inline-flex` control's minimum width too large. The `shrink` override also matters: a button can fit its own content while pushing its parent row outside the viewport.

Test long labels at both densities. Check the control's horizontal and vertical scroll dimensions and, in a flex layout, the row's width. A page-level horizontal scroll check alone can miss a local overlap. Changes to `buttonVariants` or `StatusToggle` forwarding need their own component tests and affected surface checks. The `wrap` variant belongs to the existing primitive because it changes that primitive's layout contract; it is not a recipe. A different control such as `SelectTrigger` needs its own review before adopting the same rule.
