# Reminders Domain Contract

Status: maintained contract
Depends on decisions: `ADR-002`, `ADR-005`, `ADR-006`, `ADR-009`, `ADR-018`, `ADR-020`, `ADR-022`, `ADR-040`, `ADR-043`, `ADR-049`, `ADR-064`

## Purpose

Parent-authored prompts that appear in a member/date **Daily Briefing** when relevant.
Reminders are a **briefing content source**, not standalone alarms: they are evaluated
during briefing generation, do not notify in real time, and schedule no background jobs.

## Vocabulary

- **Reminder rule** — durable instruction that may emit one briefing item. A
  **discriminated union on `kind`** (`ADR-049`): `scheduled` | `calendar_gated`.
- **`scheduled` reminder** — **day-driven**: fires on its `weekdays`. Has `weekdays`, no
  query. Base mirrors Routines (weekday-recurring, evaluated at generation).
- **`calendar_gated` reminder** — **event-driven** ("whenever"): no `weekdays`; evaluated
  every day, emits on a date iff a matching assigned event exists. Has `query`/
  `queryFields`, no weekdays.
- **Targeting mode** (`ADR-064`) — a discriminated `targeting_mode`: `apply_to_all` (all
  active members) or `specific` (N **assignments**).
- **Assignment** (`ADR-064`) — a `specific`-mode link binding **one active member** to that
  member's own **weekday set** (`scheduled`), or member-membership only (`calendar_gated`,
  no weekdays). Mirrors the Routines/Chores assignment model; a reminder holds N
  assignments, so one prompt may reach different members on different days. (Distinct from
  Calendar's event→member `assignedTo`, INV-05/AC-05 — this is the rule→member link.)
- **Weekday set** — canonical `mon..sun` string codes (ADR-020); **`scheduled` only**. Held
  at rule level for `apply_to_all`, per **assignment** for `specific` (`ADR-064`).
- **Reminder calendar gate** — the `calendar_gated` condition: emit only if the member
  has an event that day that is **both** assigned to the member (`assignedTo`, strict)
  **and** matches `query`/`queryFields` (ADR-018). **Distinct from** Calendar's
  "title-derived member assignment" (member identification is Calendar's job; the rule
  only consumes existing explicit assignments and adds its text query).
- **Priority** — ordering of untimed reminder items in the briefing.

## Invariants

0. **REMINDERS-INV-01** **Kind discriminant** (ADR-049): a rule is `scheduled` (has `weekdays`, placed per
   `targeting_mode` — rule-level for `apply_to_all`, per-assignment for `specific` (ADR-064) — and no query) or
   `calendar_gated` (has `query`/`queryFields`, no `weekdays`). The opposite field
   combinations are rejected at the boundary — invalid kinds are unrepresentable. A
   `calendar_gated` rule is **always active** (no weekday restriction); it is evaluated
   every day and emits on the days its condition holds ("whenever", not "on Mondays").
1. **REMINDERS-INV-02** **Targeting:** `specific`-mode rules bind active members via **assignments**
   (ADR-002/ADR-064). A `specific`-mode rule with **zero assignments is rejected at write**
   (use `active:false` for a non-emitting rule). Archived members drop from active emission
   and self-heal on reactivation (read-tolerance, separate from write validation).
2. **REMINDERS-INV-03** **Weekdays** (`scheduled` only) canonical `mon..sun` (ADR-020); ISO `1..7` retired.
   Derivation via `weekdayOf` (ADR-005). Held at rule level for `apply_to_all`, per
   **assignment** for `specific` (ADR-064). `calendar_gated` rules have no weekday.
3. **REMINDERS-INV-04** **Dates** strict calendar-valid `YYYY-MM-DD` at the generation boundary (ADR-006).
4. **REMINDERS-INV-05** **Calendar gate reads only via `Calendar.getEvents`** (ADR-018) — never Calendar
   tables. This fixes the v1 production bug (local-only read, 0 local events → never
   matched). Calendar owns merge + text normalization. The gate passes `assignedTo:
member`, and per ADR-018 only events explicitly assigned to that member match
   (unassigned events do not gate a member's reminder).
5. **REMINDERS-INV-06** **Consistent generation snapshot:** the gate's `getEvents` call uses the briefing
   generation's read-transaction context, and events are fetched once per member/date
   and reused across that member's rules (ADR-018/ADR-043 I1).
6. **REMINDERS-INV-07** **Rule changes do not regenerate existing briefings** (ADR-022): a generated briefing
   is an immutable snapshot; edits/deletes affect future generation only. Reflecting a
   change in today's briefing uses the explicit regenerate path.
7. **REMINDERS-INV-08** **Rule + assignments writes are atomic** (ADR-043 class 1).
8. **REMINDERS-INV-09** **Per-member assignment discriminant** (ADR-064): targeting is a discriminated
   `targeting_mode`. A `specific`-mode rule holds N assignments, each binding **one** active
   member to that member's own weekday set (`scheduled`) or membership only
   (`calendar_gated`). Invalid combinations are **rejected at the boundary** (unrepresentable,
   mirroring INV-01): a rule-level weekday set on a `specific` rule, per-assignment weekdays
   on an `apply_to_all` rule, or any weekdays on a `calendar_gated` assignment. (`apply_to_all`
   carries a single rule-level weekday set for `scheduled`; emission semantics are AC-03.)

## Behaviors

- **Manage rules** (parent/admin): create/edit/delete/activate; `kind`-discriminated
  create flows. Editable fields per kind: `scheduled` → text, `targeting_mode` +
  assignments (rule-level weekdays for `apply_to_all`, per-member for `specific`), active,
  priority; `calendar_gated` → text, `targeting_mode` + assignments, query/queryFields,
  active, priority. (`ADR-064`.)
- **Evaluate for member/date briefing:** eligible = active `apply_to_all` rules + active
  `specific` rules with an assignment for that member. For a **`scheduled`** rule: emit if
  the date's weekday is in the applicable set — the rule-level set (`apply_to_all`) or that
  member's own assignment set (`specific`, `ADR-064`). For a **`calendar_gated`** rule (no weekday): query
  `Calendar.getEvents({source:all, assignedTo:member, query, queryFields, date})` and emit
  iff a matching assigned event exists. Emit **one item per matching rule** (not per
  event). Timed-event match attaches the earliest matched time range; all-day/`scheduled`
  emit untimed.
- **Render** in briefing: untimed first by priority desc, then timed by start asc; text
  emoji-stripped on output.
- **Emission diagnostic (ADR-049 peer-review I-Probe4):** the domain exposes a
  **dry-run / explain** capability — "would this rule emit for `(member, date)`, and if
  not, why" — so the authoring UI surfaces the opaque `calendar_gated` failure modes
  (no matching event / event found but **not assigned** to the member / wrong query).
  Reuses the same evaluation path; prevents a silently-never-firing rule from looking
  like a broken feature (the v1-style silent failure this domain exists to kill).

## Interfaces

- Inbound: reminder-rule + assignment CRUD (`kind`-discriminated); a **dry-run/explain**
  query for emission (`would-emit(member, date)` with reason). Consumed by Daily Briefing
  during generation (read of active rules); Reminders never exposes rule management to the
  briefing path.
- Surface (`ADR-064`): rule/assignment management + assignment-matrix visualization is
  **admin-only** (`admin/reminders`). Reminders has **no** user-facing dashboard widget —
  its user-facing render is the Daily Briefing (deferred to that slice). The outbound
  member/date read is independently demoable via the API before the briefing exists.

## Events

(ADR-040.) Reminders **emits** none (it is a pull-time content source). It **subscribes**
to none. It depends on `Calendar.getEvents` (interface call, not an event).

## Data / Setup Contract

Owned: reminder rules + reminder assignments (namespaced; `ADR-064` — `specific`-mode
assignments carry per-member weekdays for `scheduled`). Prod has 0 reminder rows;
behavior is from spec/seed, not production data. No legacy import (ADR-026).

## Acceptance Criteria

- **REMINDERS-AC-01** A `scheduled` rule has weekdays (rule-level for `apply_to_all`, per-assignment for
  `specific`, ADR-064) and no query; a `calendar_gated` rule has
  query/queryFields and no weekdays; opposite combinations are rejected (discriminated
  validation, ADR-049).
- **REMINDERS-AC-02** A `calendar_gated` rule is evaluated every day for its eligible members (`apply_to_all`
  = all active; `specific` = its assigned members) and emits iff a matching event exists
  that is both assigned to the member and matches its query (via `getEvents`, external
  events included — fixes the v1 local-only bug); no weekday gates it.
- **REMINDERS-AC-03** A `scheduled` rule emits on the applicable weekdays — rule-level for `apply_to_all`,
  the member's own assignment set for `specific` (ADR-064) — regardless of calendar.
- **REMINDERS-AC-04** A `specific`-mode rule with zero assignments is rejected; `active:false` is the non-emitting
  mechanism.
- **REMINDERS-AC-05** Member identification is never performed by the reminder; only explicit assignments are
  honored (strict `assignedTo`).
- **REMINDERS-AC-06** Editing a rule does not alter already-generated briefings.
- **REMINDERS-AC-07** Rule + assignments persist atomically.
- **REMINDERS-AC-08** Weekday/date writes follow ADR-020/ADR-006.
- **REMINDERS-AC-10** A `calendar_gated` rule's non-emission is explainable via the dry-run capability (no
  matching event / unassigned event / query miss).

## Peer Review

`ADR-049` peer-reviewed (blind-debate 2026-06-29). **No critical**; discriminated union
judged sound and proportionate (earns its cost vs the optional-gate ambiguity); dropping
weekday from `calendar_gated` confirmed correct YAGNI (the calendar IS the schedule);
strict `assignedTo` confirmed; daily evaluation has zero marginal cost (one `getEvents`
per member/date reused). Incorporated: (Important) explicit cross-kind write-time
invariants — `scheduled` rejects query/queryFields, `calendar_gated` rejects weekdays
(invariant 0 + acceptance); (Important) **dry-run/explain capability** for opaque
`calendar_gated` non-emission (added to Behaviors/Interfaces). Notes: snapshot divergence
after an event moves/deletes is acceptable (ADR-022, as with Routines streaks) and
regenerate stays cheap; `queryFields` is Calendar-normalized (carried open decision).

## Open Decisions

- `queryFields` set shared with Calendar (title/description/location); **provider-
  normalized by `Calendar.getEvents`** (note the portability seam across calendar
  providers). Finalized in the Calendar contract.
- Whether rule text may store emoji that output strips — deferred (cosmetic).
