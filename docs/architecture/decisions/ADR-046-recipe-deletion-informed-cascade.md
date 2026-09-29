# ADR-046 Recipe Deletion = Informed Cascade

Status: accepted
Owner: product + architecture
Decision date: 2026-06-29

## Decision

Resolves the v1 conflict (storage `set null` vs endpoint docs "pointer kept") and the
deferred recipe-deletion question from `ADR-045`.

**Deleting a recipe cascades: the recipe and every entry that references it (recurring
entries inside `meal_plan`s and one-off entries) are deleted together, atomically.**
This matches the user's mental model — "delete a recipe = make it disappear
everywhere" — rather than leaving auto-generated note ghosts the user did not ask for.

**Single delete behavior, not dual-mode.** No "cascade vs convert-to-note" choice is
exposed. Dual-mode would double the surface (two params/endpoints, two confirmations,
two test paths) for a single-household kiosk. The **manual escape hatch is free**:
entries are editable, so a user who wants to keep a dish as a note converts it by hand
_before_ deleting the recipe. Not wired into the domain.

**Informed, not silent (free correctness win).** The only real risk of cascade is a
silent blast radius (deleting "Pizza" silently wipes the recurring Friday dinner + N
one-off uses). The domain therefore exposes a **dependent count, split as
`recurring_count` + `one_off_count`** (peer-review I-3) — never a single flat total,
because one recurring entry affects an unbounded future stream of derived dates while
one one-off affects a single date; collapsing them would mislead. The UI may show a
headline total but the domain must expose both. Recipe deletion is a parent/admin write
(shared write model; `ADR-013`/`ADR-030`). In practice deletion is rare because entries
are editable. **The pre-confirm count is advisory** (peer-review m-1): it may not equal
the actually-deleted count if entries are added between count and delete; the cascade
transaction is the integrity guarantee, not the count. The delete may return the actual
deleted counts for post-delete feedback.

**FK + atomicity.** The recipe→entry reference becomes `ON DELETE CASCADE` (was v1
`set null`). Recipe deletion + dependent-entry deletion is one transaction (`ADR-043`
Class 1). With cascade there are no dangling references in normal operation.
**`meal_plan` rows survive** (peer-review m-2): cascade deletes entry rows (recipe is
the parent of entries, not of plans), so a `meal_plan` left empty by the cascade is
**never** deleted, deactivated, or mutated. No opportunistic empty-plan cleanup.

**Strict update-by-id writes (peer-review I-2 — no resurrection).** Because cascade's
whole justification is "make it disappear everywhere", the write path must not undo it.
Recipe and entry writes are **strict update-by-id**: a write (edit) against a
cascade-deleted recipe or entry id returns **not-found** and **never implicitly
recreates** the row. This applies to direct recipe edits and to entry edits that
reference a recipe (a stale kiosk tab must not resurrect a deleted recipe/entry). This
is the safeguard that makes per-entry last-write-wins safe; no etag/versioning needed.

**Tombstone reclassified to defensive net.** `ADR-045`'s "stale recipe reference →
tombstone label, never read error / never silent omission" stops being an expected
flow and becomes **defense-in-depth** only — e.g. a race between deleting the recipe
and concurrently adding an entry that references it. The on-read derivation still must
never error or silently drop, but normal cascade leaves nothing to tombstone.

## Rationale

Cascade is the honest implementation of the user's intent and avoids fabricating
content (notes) the user never authored. Single-mode keeps the API and UX small; the
edit-then-delete path already covers the rare "keep as a note" case without new
machinery. Surfacing the dependent count converts a silent destructive action into an
informed one — the cheap correctness guard appropriate to the threat/value model.

## Affected Specs

- `../../04-meals-recipes.md` (recipe delete behavior; resolves the spec open question
  and the route/storage contradiction)

## Data / Setup Implications

- `recipe_id` reference on entries: `ON DELETE CASCADE`. No legacy import (`ADR-026`).
- Delete path: count dependents (for UI confirmation) → atomic delete of recipe + all
  referencing entries.

## Acceptance Criteria

- Deleting a recipe removes the recipe and every recurring + one-off entry referencing
  it, atomically (all-or-nothing).
- Before confirmation, the dependent count is available to the UI **split as
  `recurring_count` + `one_off_count`**, not a single flat number.
- The pre-confirm count is advisory; the cascade transaction is the integrity guarantee.
- Deleting a recipe never deletes, deactivates, or mutates a `meal_plan` row; an
  emptied plan survives.
- A write against a cascade-deleted recipe or entry id returns not-found and never
  recreates the row (strict update-by-id).
- No "convert to note" mode exists in the domain API; manual edit-before-delete remains
  possible because entries are editable.
- After a cascade delete, no entry references the deleted recipe; on-read derivation
  does not error.
- A stale reference arising from a race still renders as a tombstone (never error /
  silent drop) per `ADR-045`.

## Peer Review

codex-peer-review blind-debate (2026-06-29), reviewed with `ADR-047` and whole-domain
consistency. **No critical**; structure sound and proportionate. Incorporated: split
dependent count `recurring_count`/`one_off_count` (I-3); strict update-by-id, stale
writes → not-found never recreate (I-2); `meal_plan` survives empty cascade (m-2);
pre-confirm count is advisory, integrity = the transaction (m-1). Confirmed: cascade is
consistent with on-read derivation and Class 1 atomicity; no over-engineering.

## Open Questions

- None for deletion. Remaining recipe-catalogue questions (no-slot-tag semantics,
  empty-ingredients drafts) are separate.

## Traceability

- Pre-v2: resolves the recipe-deletion open question in `ADR-009`/spec `04`.
- Domain grill: `../domain-grills/meals-recipes.md` (Q2)
- Related: `ADR-043`, `ADR-045`, `ADR-013`, `ADR-030`, `ADR-026`
