# Meals & Recipes Domain Contract

Status: maintained contract
Depends on decisions: `ADR-002`, `ADR-005`, `ADR-006`, `ADR-013`, `ADR-015`, `ADR-020`,
`ADR-022`, `ADR-026`, `ADR-030`, `ADR-043`, `ADR-045`, `ADR-046`, `ADR-047`

## Purpose

Low-friction household meal planning, patterned on Routines/Chores: reusable recipes, a
recurring "what we usually eat" layer, ad-hoc one-off meals, all **additive**, surfaced
on the kiosk dashboard and the Daily Briefing. Replaces the v1 weekly-window plan model
(one exclusive recipe-or-note meal per slot) that the household found error-prone.

## Vocabulary

- **Recipe** — reusable catalogue item: `name` (required, non-blank), optional
  `ingredients`, optional `instructions`, optional `slots` suitability. Not a meal.
- **`meal_plan`** — a named, activatable, household-wide **recurring template** with
  **no date window** ("lasts forever"). The analog of a Routine. Multiple may be active.
- **Recurring entry** — `meal_plan` member: `weekday (mon..sun) + slot + content`. The
  analog of a chore/assignment.
- **One-off entry** — concrete dated meal: `date (YYYY-MM-DD local) + slot + content`.
- **Content** — per entry: a **recipe reference** OR a **non-empty note** (free text,
  markdown-capable). Exclusive per entry; never per slot.
- **Slot** — `breakfast | lunch | snack | dinner`. (Meal slots ≠ day periods.)
- **Menu** — the **derived-on-read** set of entries for a `(date, slot)`.

## Invariants

1. **MEALS-RECIPES-INV-01** **Additive: a `(date, slot)` holds N entries** (`ADR-045`). No "one per slot", no
   slot-level recipe-XOR-note. Adding an entry never displaces another. (v1's exclusivity
   was application-layer only; the table already allowed it.)
2. **MEALS-RECIPES-INV-02** **Each entry has exactly one content source** — a recipe ref or a non-empty note;
   both or neither is rejected at the domain boundary (`ADR-045`). Empty "filled" entries
   are never created (`ADR-026` evidence rows are not imported).
3. **MEALS-RECIPES-INV-03** **Menu is derived on-read, never materialized** (`ADR-045`/`ADR-043` Class 2): for a
   `(date, slot)`, the union of (a) recurring entries of **all active `meal_plan`s**
   whose `weekday = weekdayOf(date, householdTz)` and (b) one-off entries for that exact
   date. No occurrence rows are stored.
4. **MEALS-RECIPES-INV-04** **Canonical order** (`ADR-045`): recurring entries before one-off, then `meal_plan`
   name ASC, `mealPlanId` ASC (tie-breaking equal names), `createdAt` ASC, then entry ID ASC. The same logical menu always renders identically;
   briefing snapshots are reproducible.
5. **MEALS-RECIPES-INV-05** **No per-occurrence skip (Option A, `ADR-045`):** a recurring entry never skips a
   single date; editing/deactivating the entry or plan changes every matching weekday
   (retroactive reinterpretation accepted, as with Routines streaks). Non-always-recurring
   things go in as **one-off entries**, not into a plan.
6. **MEALS-RECIPES-INV-06** **Household-wide only** (`ADR-045`): no per-member targeting (`ADR-002` not applied;
   deferred seam).
7. **MEALS-RECIPES-INV-07** **Dates are strict `YYYY-MM-DD`** (`ADR-006`); "today", week boundaries, weekday
   derivation and same-day matching all use household tz (`ADR-005`). No stored week
   window; the weekly grid is a **view** over 7 local dates from `weekStartDay` + tz.
8. **MEALS-RECIPES-INV-08** **Recipe deletion = informed cascade** (`ADR-046`): deleting a recipe deletes the
   recipe **+ every referencing entry** (recurring + one-off) in one atomic transaction
   (`ADR-043` Class 1). `meal_plan` rows are **not** in the cascade — an emptied plan
   survives untouched. The domain exposes a dependent count split
   `recurring_count`/`one_off_count` (advisory) for blast-radius confirmation.
9. **MEALS-RECIPES-INV-09** **Stale recipe reference → tombstone, never break** (`ADR-045`/`ADR-046`): on-read
   derivation renders a deleted-recipe reference as a tombstone label (`ADR-015` key),
   never a read error or silent omission. With cascade this is a **defensive net** for
   races only; normal deletion leaves no dangling refs.
10. **MEALS-RECIPES-INV-10** **Strict update-by-id writes** (`ADR-046`): a write against a deleted recipe/entry id
    returns not-found and never recreates it; stale kiosk tabs cannot resurrect
    cascade-deleted rows. This makes per-entry LWW safe (invariant 12).
11. **MEALS-RECIPES-INV-11** **Recipe shape** (`ADR-047`): `name` required, trimmed, non-blank. `ingredients` /
    `instructions` optional (shell recipes allowed). `slots` optional; **absent or empty
    = suitable for all slots** (picker suggestion only; never invalidates existing
    entries). Ingredients normalized (one/line, blanks dropped); blank `instructions`
    normalize to absent.
12. **MEALS-RECIPES-INV-12** **Concurrency: last-write-wins per entry** — no etag/version. The additive model
    removed the destructive replace; concurrent adds both succeed, double-delete →
    no-op/not-found, concurrent edit of one entry → LWW on that entry. Single household.
13. **MEALS-RECIPES-INV-13** **i18n** (`ADR-015`): slot labels, form labels, empty states, errors, the tombstone
    label are product keys; recipe text and notes are user-authored, shown as authored,
    never translated. Note markdown sanitization is an interface-layer concern; the
    domain stores note text verbatim.
14. **MEALS-RECIPES-INV-14** **Permissions:** viewing menus + today's widget is household/kiosk-visible;
    create/edit/delete of recipes, plans and entries uses the shared parent/admin write
    model (`ADR-013`/`ADR-030`). No meals-specific permission model.

## Behaviors

- **View week / day:** derive the 7 local dates (or one date) and compute each
  `(date, slot)` menu on-read (invariant 3) in canonical order. Pure read; a missing
  menu is absence, not a created placeholder.
- **Add entry:** as recurring (`meal_plan` + weekday + slot + content) or one-off
  (date + slot + content). Additive — never deletes a sibling.
- **Edit / delete entry:** strict update-by-id (invariant 10); deletes are independent
  per entry. No plan-level destructive replace (the v1 delete-all-then-reinsert is gone).
- **Manage `meal_plan`:** create/rename/activate/deactivate/soft-edit; multiple active
  plans union on-read. Deactivation removes a plan's entries from derived menus without
  deleting them.
- **Recipe CRUD:** create/edit (partial, update-by-id), list, search-by-name; **delete =
  informed cascade** (invariant 8) — expose split dependent counts, then atomic delete.
- **Provide menu to consumers:** Daily Briefing + dashboard receive a **per-slot list**
  of resolved labels in canonical order; the briefing freezes the list verbatim at
  generation time (`ADR-022`).

## Interfaces

- Inbound (host API): recipe CRUD (+ dependent-count query for delete); `meal_plan` CRUD
  - activate/deactivate; recurring-entry and one-off-entry add/edit/delete; derived
    menu read for a date or week range; recipe search-by-name.
- Outbound: a per-`(date, slot)` resolved-label **list** consumed by Daily Briefing and
  the dashboard widget (read interface; no cross-module table access, Rule B). Daily Briefing projects each included slot to ordered `{kind: "recipe" | "note", label: string}` entries and freezes labels verbatim, including tombstones, punctuation and emoji (ADR-045/022).

## Events

(`ADR-040`; in-memory, at-most-once, post-commit.) **Emits: none** — no domain state
events are required for this system (consumers read on demand; the briefing snapshots at
generation). May emit a change signal later if a consumer needs cache invalidation; none
needed now. **Subscribes: none.**

## Data / Setup Contract

Fresh deployment (`ADR-026`). Owned (logical): `recipes` (name non-null; ingredients,
instructions, slots nullable/optional; timestamps); `meal_plans` (id, name, active,
timestamps — **no** week window); entries (`mealPlanId?`, `weekday?` for recurring;
`date` for one-off; `slot`; recipe ref or note; `createdAt`). Recipe→entry FK is
`ON DELETE CASCADE`. The single-table-with-nullable-discriminator vs two-tables split is
an implementation choice; this contract fixes the logical model. No materialized
occurrences, no `weekStart`/`weekEnd` columns. The 7 `meal_plans` / 33 `meals` / 0
`recipes` and empty meal rows from prod are **evidence only**, never imported.

## Acceptance Criteria

- **MEALS-RECIPES-AC-01** A `(date, slot)` accepts N entries; adding never deletes a sibling.
- **MEALS-RECIPES-AC-02** An entry with both recipe ref and note, or neither, is rejected.
- **MEALS-RECIPES-AC-03** The menu equals the on-read union (active-plan recurring matching the weekday +
  one-off for the date) in canonical order; no occurrence rows persist; two reads of an
  unchanged menu match exactly.
- **MEALS-RECIPES-AC-04** Editing/deactivating a recurring entry/plan changes all matching weekdays; there is no
  single-date skip.
- **MEALS-RECIPES-AC-05** Multiple active plans union additively.
- **MEALS-RECIPES-AC-06** Recipe delete removes the recipe + all referencing entries atomically; the dependent
  count is exposed split recurring/one-off; emptied `meal_plan` rows survive; a write
  against a deleted id returns not-found without recreating.
- **MEALS-RECIPES-AC-07** A deleted-recipe reference renders as a tombstone; derivation/dashboard/briefing never
  error or silently drop.
- **MEALS-RECIPES-AC-08** Recipe `name` blank-after-trim rejected; name-only recipe accepted; absent/empty
  `slots` ⇒ all pickers.
- **MEALS-RECIPES-AC-09** Dates outside strict `YYYY-MM-DD` rejected; week/today use household tz + `weekStartDay`.
- **MEALS-RECIPES-AC-10** Consumers receive a per-slot resolved-label list. Daily Briefing freezes ordered `{kind: "recipe" | "note", label: string}` lists for lunch, snack and dinner, preserving labels verbatim, including punctuation, emoji and recipe tombstones (ADR-045/022). Source edits leave the stored lists unchanged until regeneration; existing scalar-slot snapshots remain readable without rewriting. Breakfast inclusion remains the separate decision below.

## Open Decisions

- **Breakfast in the Daily Briefing** — deferred to the briefing block catalogue;
  preference = include all 4 slots. Not owned here.
- Per-member meal targeting — deferred future seam (`ADR-002` not applied).
- Per-date recurring-entry skip (Option B) — deferred unless a real need appears.
- Markdown subset/sanitization for notes — interface-layer detail.

## Peer Review

`ADR-045` peer-reviewed (blind-debate 2026-06-29): model sound; 3 underspecification
fixes folded in (list-shape consumer payload + `ADR-022` freeze; canonical on-read order;
stale-ref tombstone floor). `ADR-046`/`ADR-047` peer-reviewed together (2026-06-29): no
critical; conditions folded in — split dependent count, strict update-by-id (no
resurrection), `meal_plan` survives empty cascade, advisory count; recipe name
trim-non-blank, absent≡empty slots, instructions blank→absent. No over-engineering flags;
Routines parity judged appropriate for a single-household SQLite kiosk.
