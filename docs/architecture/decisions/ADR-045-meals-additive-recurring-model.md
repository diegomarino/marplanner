# ADR-045 Meals Additive Recurring Model (recurring entries + one-off entries, derived on-read)

Status: accepted
Owner: architecture + product
Decision date: 2026-06-29

## Reconciliation (2026-10-08)

The additive menu is implemented, but the briefing meals block currently joins labels into scalar strings and removes emoji before snapshot persistence. That does not preserve the structured list verbatim. The requirement below remains open implementation work; changing it to a scalar contract requires an explicit decision, not a compliance claim in a code comment.

## Decision

Replaces the v1 Meals model (one weekly `meal_plan` window owning at-most-one
exclusive recipe-or-note meal per `(date, slot)`) with an **additive, recurring
model patterned on Routines/Chores** (`ADR-020`/`ADR-043`).

**Two entry kinds, both additive, both household-wide, both recipe-or-note:**

1. **Recurring entry** — `weekday + slot + content`, lives inside a **`meal_plan`**.
   A `meal_plan` is a **named, activatable, household-wide template that "lasts
   forever"** (no date window). It is the analog of a Routine; its recurring entries
   are the analog of chore/assignments. The household may have **multiple `meal_plan`s
   active at once.**
2. **One-off entry** — `date (YYYY-MM-DD local) + slot + content`. A concrete dated
   row, independent of any `meal_plan`.

`content` per entry = a **recipe reference OR a free-text note** (exclusive _per
entry_, never per slot). `slot ∈ {breakfast, lunch, snack, dinner}`.

**Additivity is the core rule.** A `(date, slot)` admits **N entries**. There is no
"at most one per slot" constraint and no slot-level recipe-XOR-note rule (those were
v1 application-layer orchestration, not data-model constraints — the v1 `meals` table
already had nullable `recipe_id`/`note` and no unique key). Adding a dish never
displaces an existing one.

**The day's menu for `(date, slot)` is derived on-read (no materialization):**
the union of (a) recurring entries from **all active `meal_plan`s** whose `weekday`
matches `weekdayOf(date, householdTz)` (`ADR-020`, `ADR-005`) and (b) one-off entries
for that exact date. Zero materialized occurrence rows ⇒ nothing to desync ⇒ this is
`ADR-043` Class 2 ("the best cache is no cache").

**Canonical ordering (peer-review I1 — determinism).** The on-read union has a **fixed
sort** so the same logical menu always renders in the same sequence (SQLite gives no
order without `ORDER BY`; rowid reuse/VACUUM would otherwise reshuffle, and two
briefings generated seconds apart could differ with no semantic change):
**recurring entries before one-off entries, then by `meal_plan` name ASC, then by
`mealPlanId` ASC (tie-breaking equal names), `createdAt` ASC, then entry ID ASC.** This also makes briefing snapshots reproducible across regenerations.

**Briefing/consumer payload is a LIST per slot, not a single label (peer-review C1).**
Because a `(date, slot)` holds N entries, every consumer of the derived menu — Daily
Briefing, the dashboard widget — receives **`list<{ kind: recipe|note, label: string }>`
per slot** (the resolved display labels in canonical order), not a singular
"lunch label". Daily Briefing freezes that **list verbatim** in its snapshot at
generation time (`ADR-022`); the meals block in `daily-briefing.md` stores resolved
date-specific labels, never plan/rule IDs. This closes the seam between additive
N-per-slot (ADR-045) and the single-label framing ADR-022/the briefing spec previously
assumed.

**Stale recipe reference must render as a tombstone, never break the read (peer-review
I2 — floor invariant).** A recurring or one-off entry whose recipe reference points at
a deleted recipe **MUST** be displayed as a tombstone label (e.g. an i18n
`[deleted recipe]` key, `ADR-015`) — **never** a read error and **never** a silent
omission, so on-read derivation, the dashboard, and briefing generation cannot break.
This is the minimum floor; the full recipe-deletion policy is resolved by `ADR-046` (informed cascade), without weakening this tolerant-read floor.

**No per-occurrence exception/skip (option A).** A recurring entry never "skips" a
single date. To change it, edit or deactivate the rule/plan (affects all matching
weekdays — same accepted retroactive reinterpretation as Routines streaks). **Product
guidance:** if something is not _always_ recurring, do not put it in a `meal_plan` —
add it as a **one-off entry** on its date. A per-date tombstone (option B) is a cheap
later addition if it ever proves necessary; not built now.

**The weekly grid is a view, not stored state.** The v1 `meal_plan` weekly window
(`weekStart`/`weekEnd` as instants — the documented timezone bug seed) is **dropped**.
"The week" is a query over 7 household-local dates derived from `weekStartDay` + tz
(`ADR-005`). `meal_plan` no longer means "a specific week's meals"; it means "a
recurring template."

**Targeting: household-wide only (for now).** Recurring and one-off entries are not
member-targeted (no `ADR-002` child targeting like chores). "We do not split so fine
as to decide what each person eats." Per-member meals remain a future seam, not built.

## Rationale

The v1 friction the user rejected ("having meal_plans that prevent adding food as
notes") came entirely from **application-layer orchestration imposed on an
already-additive schema**: the form forced recipe-XOR-note, and the upsert endpoint
forced one-per-slot via delete-then-insert. Removing those rules and embracing
additivity is _subtraction_, not addition.

Reusing the Routines/Chores shape (recurring rule + derive-on-read, no materialized
occurrences) gives the "always Mondays soup / Fridays pizza" recurrence the user wants
**without** an exception engine — the single most complex part of recurring systems.
Multiple active plans union for free because entries just union on-read, and they map
cleanly onto the user's two real examples (a school-snacks plan + a home-dinners plan)
without forcing them into one artificial object.

## Affected Specs

- `../../04-meals-recipes.md` (Mon–Sun additive recurring rewrite; drops weekly-window
  plan entity), `../../11-daily-briefing.md` (meals block reads the derived menu),
  `../../02-day-periods.md` (slots unaffected; meal slots ≠ day periods)

## Data / Setup Implications

- Owned tables (v2, fresh — `ADR-026`): `recipes` (unchanged catalogue), `meal_plans`
  (now: id, name, active, timestamps — **no** week window), recurring entries
  (`mealPlanId, weekday, slot, content`), one-off entries (`date, slot, content`).
  Final table split (one entries table with nullable `mealPlanId`+`weekday` vs two
  tables) is an implementation call; the contract fixes the logical model.
- No materialized occurrence rows. No `weekStart`/`weekEnd` columns.
- No legacy import (`ADR-026`): the 7 `meal_plans` / 33 `meals` / 0 `recipes` and the
  empty meal rows are evidence only.

## Acceptance Criteria

- A `(date, slot)` can hold N entries; adding one never deletes another.
- An entry carries exactly one content source (recipe ref or non-empty note); both or
  neither is rejected at the domain boundary.
- The menu for a date is the on-read union of active-plan recurring entries matching
  the weekday (household tz) plus that date's one-off entries; no occurrence rows are
  persisted.
- Editing/deactivating a recurring entry or plan changes every matching weekday's
  derived menu (retroactive reinterpretation expected); there is no single-date skip.
- Multiple active `meal_plan`s union additively.
- Entries are household-wide; no member targeting.
- Week boundaries/"today" use household tz + `weekStartDay`; no stored week window.
- The derived menu is returned in the canonical order (recurring before one-off, then
  plan name ASC, then `createdAt` ASC); two reads/regenerations of an unchanged menu
  produce identical sequences.
- Consumers receive a per-slot **list** of resolved labels; the briefing freezes the
  list verbatim (`ADR-022`).
- An entry whose recipe reference is deleted renders as a tombstone label; on-read
  derivation, dashboard, and briefing generation never error or silently drop it.

## Open Questions

- Recipe deletion is resolved by `ADR-046`: informed cascade with surviving plans.
- Recipe suitability and shell-recipe rules are resolved by `ADR-047`; empty slots mean all slots.
- Daily Briefing slot coverage (breakfast inclusion) — separate question.
- Per-date recurring-entry skip (option B) — deferred unless needed.
- Per-member targeting — deferred future seam.

## Peer Review

codex-peer-review blind-debate (2026-06-29). No critical over-engineering; model judged
sound and proportionate for a single-household SQLite kiosk (multiple active plans +
on-read union are cheap). 3 blocking underspecification gaps found and **all
incorporated above**: (C1) briefing/consumer payload must be a per-slot **list** of
resolved labels frozen verbatim by `ADR-022` — closes the seam vs the prior single-label
framing; (I1) on-read union needs a **canonical `ORDER BY`** for determinism/snapshot
reproducibility; (I2) a **stale recipe reference must render as a tombstone**, never a
read error or silent omission (floor for the deferred recipe-deletion policy). Dismissed:
Option-A no-skip is a stated/accepted tradeoff; multi-plan provenance is acceptable for
one household.

## Traceability

- Related prior: refines `ADR-009` atomicity scope (plan-window create/replace/delete flows
  disappear).
- Domain grill: `../domain-grills/meals-recipes.md` (Q1 model)
- Related: `ADR-002`, `ADR-005`, `ADR-006`, `ADR-015`, `ADR-020`, `ADR-022`, `ADR-026`,
  `ADR-043`
