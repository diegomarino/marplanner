# ADR-049 Reminder Kind Split (scheduled vs calendar_gated)

Status: accepted
Owner: product + architecture
Decision date: 2026-06-29

## Decision

Refines the Reminders model (`ADR-018` / `reminders.md`): the previous "one rule with an
**optional** calendar gate" shape is replaced by a **discriminated union on `kind`**,
because the two reminder kinds are triggered by different things and need different
fields. Mixing them in one shape left half-valid states representable (a gate set but
empty `query`; a non-gated rule carrying an orphan `query`).

**`kind: scheduled` — day-driven ("on these days").**

- Trigger: the weekday. Required: `text`, `weekdays` (`mon..sun`, `ADR-020`), targeting.
- No `query`/`queryFields`. The base mirrors Routines/Chores (weekday-recurring,
  evaluated at briefing generation, frozen in the snapshot).

**`kind: calendar_gated` — event-driven ("whenever there is a matching event").**

- Trigger: the existence, on the briefing date, of a calendar event that satisfies BOTH
  conditions (AND): **(1)** it is **assigned to the member** (Calendar's member
  assignment — often the "title-derived member assignment"; consumed strictly via
  `assignedTo:member`, so unassigned family events never count, `ADR-018`), **and (2)**
  it matches the rule's `query` over `queryFields` (the reminder's own text condition).
- Required: `text`, targeting, `query`, `queryFields`.
- **No `weekday` concept at all.** The essence is the "whenever", not a day — it is
  evaluated every day and emits on days the condition holds. Adding an optional weekday
  filter would reintroduce day-thinking the kind exists to remove; dropped (YAGNI; add
  later only if a real need appears).

Member identification is **Calendar's responsibility** (assignment, detected/created
separately), distinct from the **reminder calendar gate** (the rule's text query). The
reminder never detects members; it consumes existing explicit assignments.

**Emission diagnostic (peer-review).** Because a `calendar_gated` rule can silently never
fire when the matching event lacks an explicit member assignment (common with
title-derived assignment on external calendars), the domain **exposes a dry-run/explain**
capability — "would this rule emit for `(member, date)`, and if not, why" (no matching
event / event found but not assigned / query miss). It reuses the evaluation path and
lets the authoring UI show emit/no-emit-with-reason, so an unassigned-event silent
failure is debuggable instead of looking broken. This is a contract requirement, not a
UX nicety.

**Unchanged from the accepted model:** evaluation is pull-time during briefing
generation (no real-time, no jobs); calendar reads only via
`Calendar.getEvents({source:all, assignedTo:member, query, queryFields, date})`
(`ADR-018`, never Calendar tables); strict `assignedTo`; one read per member/date reused
across rules in the generation read-transaction (`ADR-043` I1); emit one item per
matching rule (not per event); timed match attaches earliest time range, all-day emits
untimed; render order untimed-by-priority then timed-by-start; targeting active members
with zero-target specific rules rejected at write (`active:false` to silence, `ADR-002`);
rule changes do not regenerate existing briefings (`ADR-022`); rule + targets writes
atomic (`ADR-043` Class 1).

## Rationale

The two kinds are not "with/without a gate" — they are different trigger models with
disjoint required fields. A discriminated `kind` makes invalid combinations
unrepresentable (the recurring project pattern: `ADR-028` settings union, weekday
strings, half-open dates) and gives the UI two clear authoring flows instead of one
toggle that reconfigures half the form. Dropping weekday from `calendar_gated` captures
the user's core requirement ("siempre que haya entrenamiento", not "los lunes") and is
more robust than v1: the reminder delegates the "when" to the calendar instead of
duplicating a schedule, so it keeps working if the event moves day.

## Affected Specs

- `../../07-reminders.md`, `../../06-calendar.md`, `../../11-daily-briefing.md`

## Data / Setup Implications

Owned: reminder rules with a `kind` discriminant + rule member-targets (namespaced).
`scheduled` rows carry weekdays (no query); `calendar_gated` rows carry query/queryFields
(no weekdays). Prod has 0 reminder rows; no legacy import (`ADR-026`) — v1 rows (if any)
map to `scheduled` (no gate) or `calendar_gated` (gate present) by their gate presence.

## Acceptance Criteria

- A `scheduled` rule has weekdays and no query; a `calendar_gated` rule has
  query/queryFields and no weekdays; the opposite combinations are rejected at the
  boundary (discriminated validation).
- A `calendar_gated` rule is evaluated every day and emits on a date iff an event exists
  that is both assigned to the member and matches its query (via `getEvents`).
- A `scheduled` rule emits on its weekdays regardless of calendar.
- Member identification is never performed by the reminder; only explicit assignments are
  honored (strict `assignedTo`).
- All unchanged invariants (pull-time, `getEvents`-only, snapshot, atomic writes,
  targeting) continue to hold.

## Peer Review

codex-peer-review blind-debate (2026-06-29). **No critical.** Discriminated union judged
sound and proportionate (earns its cost vs optional-gate ambiguity); weekday-drop on
`calendar_gated` confirmed correct YAGNI; strict `assignedTo` confirmed; daily evaluation
zero marginal cost (one `getEvents` per member/date reused, `ADR-043` I1); no duplicate
emission. Incorporated: explicit cross-kind write-time invariants (already present;
reaffirmed) and a **dry-run/explain capability** for opaque `calendar_gated`
non-emission. Notes: snapshot divergence after an event change is acceptable (`ADR-022`,
as with Routines streaks); `queryFields` is Calendar-normalized (a cross-provider
portability seam to note).

## Open Questions

- `queryFields` allowed set (title/description/location) — finalized in the Calendar
  contract (carried from `ADR-018`); provider-normalized by `Calendar.getEvents`.

## Traceability

- Related prior: refines `ADR-018` and the Reminders cluster outcome.
- Domain grill: `../domain-grills/calendar-reminders-routines.md` (R3) +
  `../domain-grills/daily-messages.md` (Reminders revisit)
- Related: `ADR-002`, `ADR-005`, `ADR-006`, `ADR-020`, `ADR-022`, `ADR-040`, `ADR-043`
