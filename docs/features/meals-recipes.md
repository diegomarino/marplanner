# Feature: Meals & Recipes (additive household meal planning)

Behavior reference. The [owning contract](../architecture/contracts/meals-recipes.md) defines invariants and extension limits.

Low-friction household meal planning, patterned on Routines: reusable **recipes**
(catalogue items, never meals); recurring `meal_plan` **templates** with no date
window ("lasts forever") that say "what we usually eat"; ad-hoc **one-off entries**
for concrete dated meals; and a **menu** that is _derived on read_, never
materialized. Everything is **additive** — adding an entry never displaces a sibling.
Resolved per-slot label lists are surfaced on the kiosk dashboard and frozen verbatim
into the Daily Briefing. Replaces v1's error-prone weekly-window plan (one exclusive
recipe-or-note meal per slot).

## User workflows

### User Story 1 — Plan the usual week with a reusable recipe

A parent creates a recipe ("Taco Tuesday"), then adds it to an active `meal_plan` as a
recurring entry for `tue + dinner`. Every Tuesday's dinner menu now derives that entry
on read, alongside any one-off entries for that exact date — additively, never
replacing what is already there.

### User Story 2 — Drop in a one-off without disturbing the plan

A parent adds an ad-hoc one-off entry (a free-text note "leftovers night") for a
specific date + slot. It joins that `(date, slot)` menu additively next to the
recurring entries, and removing it later touches no sibling. Non-always-recurring meals
go in as one-offs, never into a plan.

### User Story 3 — Retire a recipe with eyes open

A parent deletes a recipe. The domain first surfaces a split dependent count
(`recurring_count` / `one_off_count`) so the blast radius is visible, then atomically
deletes the recipe and every referencing entry — while leaving any now-emptied
`meal_plan` rows intact. A stale kiosk tab that tries to write the deleted id gets
not-found, and any racing read renders a tombstone rather than erroring.

### Edge Cases

- An entry written with **both** a recipe ref and a note, or **neither**, is rejected
  at the domain boundary; empty "filled" entries are never created.
- A read that still sees a deleted-recipe reference (a delete/read race) renders a
  tombstone label, never a read error or a silent omission.
- Deactivating a `meal_plan` removes its entries from derived menus without deleting
  them; reactivating restores them.
- A recipe with only a non-blank `name` (no ingredients/instructions) is accepted;
  blank-after-trim `name` is rejected; absent or empty `slots` means all-slots.
- Two concurrent adds to the same `(date, slot)` both succeed; a double-delete is a
  no-op/not-found; concurrent edits of one entry resolve last-write-wins.

## Requirements

### Functional Requirements

- **FR-001**: Given a `(date, slot)` with existing entries, when a new entry is added to it, then the slot MUST hold the full union of N entries with no "one per slot" cap and no slot-level recipe-XOR-note rule, and the add MUST NOT displace any sibling. Contract: MEALS-RECIPES-INV-01.

- **FR-002**: Given an entry write, when its content is validated at the domain boundary, then it MUST carry exactly one content source — a recipe ref or a non-empty note — and a write with both or neither MUST be rejected, and empty "filled" entries MUST never be created. Contract: MEALS-RECIPES-INV-02.

- **FR-003**: Given a `(date, slot)`, when its menu is requested, then it MUST be derived on read as the union of recurring entries of all active `meal_plan`s whose `weekday = weekdayOf(date, householdTz)` plus one-off entries for that exact date, and no occurrence rows MUST be materialized or stored. Contract: MEALS-RECIPES-INV-03.

- **FR-004**: Given a derived menu, when its entries are ordered, then they MUST follow the canonical order — recurring entries before one-off, then `meal_plan` name ASC, then `createdAt` ASC — so the same logical menu always renders identically and briefing snapshots are reproducible. Contract: MEALS-RECIPES-INV-04.

- **FR-005**: Given a recurring entry, when a single matching date should be skipped, then no per-occurrence skip MUST exist — editing or deactivating the entry or plan MUST change every matching weekday — and a non-always-recurring meal MUST instead be entered as a one-off entry. Contract: MEALS-RECIPES-INV-05.

- **FR-006**: Given any recipe, plan, or entry, when it is created or targeted, then it MUST be household-wide only with no per-member targeting field accepted (the per-member seam is deferred). Contract: MEALS-RECIPES-INV-06.

- **FR-007**: Given a date, when "today", week boundaries, weekday derivation, or same-day matching are computed, then dates MUST be strict `YYYY-MM-DD` and all derivations MUST use household tz, and the weekly grid MUST be a view over 7 local dates from `weekStartDay` + tz with no stored week window. Contract: MEALS-RECIPES-INV-07.

- **FR-008**: Given a recipe with referencing entries, when it is deleted, then the recipe plus every referencing recurring and one-off entry MUST be deleted in one atomic transaction, the owning `meal_plan` rows MUST NOT be cascaded (an emptied plan survives), and the domain MUST expose an advisory split dependent count `recurring_count`/`one_off_count`. Contract: MEALS-RECIPES-INV-08.

- **FR-009**: Given a deleted-recipe reference, when a menu is derived on read, then the stale reference MUST render as a tombstone label (an ADR-015 key) and MUST never produce a read error or a silent omission, serving as a defensive net for races only. Contract: MEALS-RECIPES-INV-09.

- **FR-010**: Given a deleted recipe or entry id, when a write is issued against it, then it MUST return not-found and MUST never recreate the row, so stale kiosk tabs cannot resurrect cascade-deleted rows and per-entry last-write-wins stays safe. Contract: MEALS-RECIPES-INV-10.

- **FR-011**: Given a recipe write, when its shape is validated, then `name` MUST be required, trimmed, and non-blank; `ingredients`/`instructions` MUST be optional (shell recipes allowed); `slots` MUST be optional with absent-or-empty meaning suitable for all slots (picker suggestion only, never invalidating existing entries); and `ingredients` MUST normalize one-per-line with blanks dropped while blank `instructions` normalize to absent. Contract: MEALS-RECIPES-INV-11.

- **FR-012**: Given concurrent writes, when they target meal data, then concurrency MUST be last-write-wins per entry with no etag/version, such that concurrent adds both succeed, a double-delete is a no-op/not-found, and a concurrent edit of one entry resolves LWW on that entry. Contract: MEALS-RECIPES-INV-12.

- **FR-013**: Given displayed and stored text, when it is rendered, then slot labels, form labels, empty states, errors, and the tombstone label MUST be product (i18n) keys, while user-authored recipe text and notes MUST be shown as authored and never translated, and the domain MUST store note text verbatim (sanitization being an interface-layer concern). Contract: MEALS-RECIPES-INV-13.

- **FR-014**: Given a permission check, when menus or today's widget are viewed, then they MUST be household/kiosk-visible, and when recipes, plans, or entries are created/edited/deleted, then the write MUST use the shared parent/admin write model with no meals-specific permission model. Contract: MEALS-RECIPES-INV-14.

- **FR-015**: Given a `(date, slot)`, when an entry is added to it, then the slot MUST accept N entries and the add MUST NOT delete a sibling. Contract: MEALS-RECIPES-AC-01.

- **FR-016**: Given an entry write, when it carries both a recipe ref and a note, or neither, then it MUST be rejected. Contract: MEALS-RECIPES-AC-02.

- **FR-017**: Given a `(date, slot)`, when its menu is read, then it MUST equal the on-read union of active-plan recurring entries matching the weekday plus one-off entries for the date in canonical order, no occurrence rows MUST persist, and two reads of an unchanged menu MUST match exactly. Contract: MEALS-RECIPES-AC-03.

- **FR-018**: Given a recurring entry or its plan, when it is edited or deactivated, then every matching weekday MUST change and there MUST be no single-date skip. Contract: MEALS-RECIPES-AC-04.

- **FR-019**: Given more than one active `meal_plan`, when a menu is derived, then the active plans MUST union additively. Contract: MEALS-RECIPES-AC-05.

- **FR-020**: Given a recipe delete, when it is committed, then it MUST remove the recipe plus all referencing entries atomically, the dependent count MUST be exposed split recurring/one-off, emptied `meal_plan` rows MUST survive, and a write against the deleted id MUST return not-found without recreating it. Contract: MEALS-RECIPES-AC-06.

- **FR-021**: Given a deleted-recipe reference, when it is derived for a menu, dashboard, or briefing, then it MUST render as a tombstone and the derivation/dashboard/briefing MUST never error or silently drop it. Contract: MEALS-RECIPES-AC-07.

- **FR-022**: Given a recipe write, when `name` is blank after trim it MUST be rejected, when only `name` is supplied the recipe MUST be accepted, and when `slots` is absent or empty the recipe MUST appear in all slot pickers. Contract: MEALS-RECIPES-AC-08.

- **FR-023**: Given a date input, when it is outside strict `YYYY-MM-DD` it MUST be rejected, and when week or "today" are computed they MUST use household tz plus `weekStartDay`. Contract: MEALS-RECIPES-AC-09.

- **FR-024**: Given a consumer (Daily Briefing or dashboard), when it requests a slot's resolved labels, then it MUST receive a per-slot resolved-label list and the briefing MUST freeze that list verbatim at generation time. Contract: MEALS-RECIPES-AC-10.

### Key Entities

- **Recipe**: a reusable catalogue item (never a meal). Attributes: `name` (required,
  trimmed, non-blank); optional `ingredients`, `instructions`; optional `slots`
  suitability (absent/empty = all slots). Recipe→entry FK is `ON DELETE CASCADE`.
- **`meal_plan`**: a named, activatable, household-wide recurring template with **no**
  date window ("lasts forever"). Multiple may be active; deactivation removes its
  entries from derived menus without deleting them. The analog of a Routine.
- **Recurring entry**: a `meal_plan` member — `weekday (mon..sun) + slot + content`.
- **One-off entry**: a concrete dated meal — `date (YYYY-MM-DD local) + slot + content`.
- **Content**: per entry, a recipe reference OR a non-empty note (markdown-capable free
  text). Exclusive per entry; never per slot.
- **Menu**: the derived-on-read set of entries for a `(date, slot)` — never materialized.

## Success Criteria

- **SC-001**: 100% of entry writes with both content sources, or neither, are rejected;
  no empty "filled" entry is ever persisted.
- **SC-002**: Two reads of an unchanged `(date, slot)` menu return byte-identical
  canonical-ordered label lists, with zero occurrence rows stored.
- **SC-003**: A recipe delete removes the recipe + every referencing entry atomically,
  leaves emptied `meal_plan` rows intact, and returns not-found on a subsequent write to
  the deleted id — with the split dependent count surfaced before the delete.

## Assumptions

- Fresh v2 data store (ADR-026); the 7 `meal_plans` / 33 `meals` / 0 `recipes` and empty
  meal rows from prod are evidence only, never imported.
- Household tz, `weekStartDay`, and `weekdayOf` date derivation primitives are provided
  per ADR-005/ADR-006; atomicity per ADR-043.
- i18n product keys and the tombstone label key are provided per ADR-015; note markdown
  sanitization is handled at the interface layer (the domain stores text verbatim).
- The shared parent/admin write model and household/kiosk read visibility are provided
  per ADR-013/ADR-030; no meals-specific permission model is introduced.
- Per-member meal targeting (ADR-002) and per-date recurring-entry skip (Option B) are
  deferred future seams, not realized here.
