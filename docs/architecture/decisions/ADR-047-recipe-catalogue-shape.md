# ADR-047 Recipe Catalogue Shape (slot suitability + shell recipes)

Status: accepted
Owner: product
Decision date: 2026-06-29

## Decision

Resolves two recipe-catalogue spec open questions.

**Slot suitability: absent/empty `slots` = suitable for ALL slots (fixes v1 bug).**
A recipe's `slots` is an optional set of `{breakfast, lunch, snack, dinner}`. When
**absent or empty**, the recipe is offered in **every** slot's picker; when non-empty,
only in the listed slots. This fixes the v1 contradiction where docs said "empty = all
slots" but the form filtered `recipe.slots?.includes(slot)` so an empty array was
suggested for **no** slot. **`slots` is picker-suggestion only** — it never invalidates
or removes existing entries if a recipe's tags later change (already a spec invariant).
**No minimum of one tag is required.** **Absent and empty `[]` are equivalent on both
read and write** (peer-review m-3) — both mean "all slots"; storage canonicalization
(normalizing `[]` to null) is optional implementation policy, not a cross-layer contract
requirement, but every consumer must read both as equivalent.

**Shell recipes allowed: only `name` is required.** `name` is required and **trimmed
before validation; blank-after-trim is rejected** (peer-review I-1) — a whitespace-only
name would pass `min 1` yet render as an empty label in pickers, delete confirmations
and the `ADR-045` tombstone, violating the displayable-label floor at creation time. The
trimmed value is persisted. `ingredients` and `instructions` are **optional** — a recipe
may be a bare reusable label ("Pizza"). Rationale: what distinguishes a recipe from a
note is **reusability** (a named catalogue item referenced by N entries), not richness;
forcing ingredients/instructions creates friction and produces fake-filled fields that
defeat validation. `ingredients` are normalized (one per line, blank lines dropped) when
present; **optional `instructions` are trimmed and blank-after-trim normalizes to
absent** (peer-review m-4), matching the ingredient-normalization spirit.

## Rationale

Calibrated to low-friction family use: a recipe is frequently just a named dish reused
across the week. Requiring prose instructions adds friction without value. The
slot-suitability fix removes a real v1 defect (untagged recipes vanishing from every
picker) and keeps slots as a soft hint, consistent with `ADR-045`'s rule that suitability
never invalidates planned entries.

## Affected Specs

- [meals-recipes](../../features/meals-recipes.md) (recipe schema: required fields, slot semantics)

## Data / Setup Implications

- `recipes`: `name` NOT NULL (min 1); `ingredients`, `instructions` nullable/optional;
  `slots` optional (absent/empty = all). No legacy import (`ADR-026`).

## Acceptance Criteria

- A recipe with no `slots` (or empty `[]`) appears in all four slot pickers; both
  representations are read as equivalent.
- A recipe with `slots = [dinner]` appears only in the dinner picker.
- Changing a recipe's `slots` does not alter or remove existing entries referencing it.
- A recipe with only a `name` (no ingredients, no instructions) is accepted.
- A recipe with an empty or whitespace-only `name` is rejected (trimmed before
  validation; trimmed value persisted).
- Ingredient blank lines are dropped on save; whitespace-only `instructions` normalize
  to absent.

## Peer Review

codex-peer-review blind-debate (2026-06-29), reviewed with `ADR-046`. **No critical.**
Incorporated: `name` trimmed-before-validation, blank-after-trim rejected (I-1, protects
the displayable-label floor); absent vs empty `slots` equivalent on read+write,
canonicalization optional (m-3); optional `instructions` blank→absent normalization
(m-4). Confirmed: recipe-vs-note boundary stays coherent (content invariant is at entry
level; a name-only recipe is still a valid recipe ref); no new briefing/picker seam; no
over-engineering.

## Open Questions

- None.

## Traceability

- Related prior: resolves recipe-catalogue open questions in spec `04`.
- Domain grill: `domain-grills/meals-recipes.md` (historical record, not preserved in this repository) (Q3, Q4)
- Related: `ADR-045`, `ADR-015`
