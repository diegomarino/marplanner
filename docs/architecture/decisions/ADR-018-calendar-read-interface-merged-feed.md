# ADR-018 Calendar Read Interface and Merged Feed

Status: accepted
Owner: architecture
Decision date: 2026-06-29

## Decision

Calendar-backed generated content (Reminders calendar gate, Daily Briefing agenda,
any future consumer) reads calendar data **only through a single parameterized
Calendar read interface** — never by direct access to Calendar's tables (Rule B /
ADR-040). Calendar owns the _how_ (merge local + active external, resolve `ext:`
references, apply status, normalize text); callers pass **filters, not policy**.

Conceptual interface `Calendar.getEvents({ ... })`:

- **`source`**: `all` | `local` | `external` — scope chosen by the caller.
- **`assignedTo`**: `memberId` (optional) — events assigned to that member.
- **`query`** + **`queryFields`** (e.g. `[title, description]`) — text match performed
  **inside** Calendar, reusing its existing case/diacritic normalization.
- date range in household tz (ADR-005); cancelled/disabled events excluded by default.

The interface exposes **capabilities, not policies**: it must not bake in any single
consumer's matching rules.

**`assignedTo` semantics (peer-review I3):** when `assignedTo` is provided, only events
with an **explicit assignment row for that member** are returned. Events with no
assignment records do **not** match any `assignedTo` filter (they are returned only when
`assignedTo` is omitted). This is the safe default for a gating mechanism — a reminder
must not fire on an unassigned family event the member was never deliberately assigned
to. (Production has 1804 external events, many unassigned, so this is load-bearing.)

**Consistent reads (peer-review I1):** `getEvents` accepts a caller-supplied read-
transaction context so a multi-read generation (Daily Briefing: this plus
`Routines.getMemberStreak`) sees one consistent snapshot. Calendar events for a member/
date are fetched once and reused across that member's reminder rules.

## Rationale

Production has 1804 external events and 0 local events, yet v1 Reminders' calendar
gate reads only the local `events` table — so in production it can never match
anything. The root cause is a **direct table read instead of a domain read
interface**. Making Calendar the sole owner of "what the feed is" means no consumer
can silently desync when that definition changes (merge rules, status filtering,
external inclusion). Parameterizing keeps the interface reusable by future consumers
without Calendar knowing about them (avoids inverted coupling), and consolidates text
normalization in one place instead of duplicating the matcher in Reminders.

## Affected Specs

- `../../06-calendar.md`, `../../07-reminders.md`, `../../11-daily-briefing.md`

## Data / Setup Implications

Member assignment over external events already exists (all 572 prod assignment rows
are `ext:`), so per-member external matching has its data; only the read path
changes. No legacy import (ADR-026).

## Acceptance Criteria

- Given a Reminders calendar gate, when evaluated, then it queries
  `Calendar.getEvents` with `source:all`, the member, and `query`/`queryFields` —
  never a Calendar table directly.
- Given a caller requesting `source:local`, when served, then external events are
  excluded.
- Given the merged feed, when read, then cancelled/disabled-source events are absent
  by default.

## Open Questions

- Exact field allowed in `queryFields` (title/description/location) finalized in the
  Calendar contract; collapses the former Reminders `calendarMatchField` question.

## Traceability

- Pre-v2: `ADR-018`
- Domain grill: `../domain-grills/calendar-reminders-routines.md` (S1, R3)
- Related: `ADR-040` (Rule B), `ADR-002`, `ADR-005`
