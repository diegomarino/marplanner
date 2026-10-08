# ADR-005 Household Timezone Contract

Status: accepted
Owner: architecture
Decision date: 2026-06-27

## Decision

`locale.timezone` (the IANA timezone name stored in App Settings) is the single canonical source for all business-date computation in this system. Server timezone, browser timezone, and external API timezone inference are never used for business dates.

### Rules

**Business dates are `YYYY-MM-DD` strings in household timezone.**
Any field that represents a calendar day (briefing date, meal date, chore date, reminder date, message date) is stored and exchanged as a `YYYY-MM-DD` string interpreted in `locale.timezone`. These are never UTC timestamps.

**Operational timestamps are UTC instants.**
`createdAt`, `updatedAt`, and similar audit fields are UTC. They record when something happened, not a business date.

**Server-side "today" is computed from `locale.timezone` read from the database.**
`getIsoDateInTz(new Date(), tz)` where `tz = loadHouseholdTimezone(db)`. The server never uses server-local date getters (`new Date().getDate()`, `setHours`, etc.) for calendar-day logic.

**Client-side "today" is computed from `locale.timezone` read from `useAppSettings()`.**
`getIsoDateInTz(new Date(), timezone)`. The client never uses `new Date().toISOString().slice(0,10)` (which yields UTC date) for any business date.

**Day-boundary queries use `zonedDayBoundsUtc(isoDate, tz)`.**
Server queries over timestamped rows use half-open UTC intervals `[localMidnight, nextLocalMidnight)` derived from the household timezone. These are DST-safe.

**The scheduler fires at household-local wall-clock times.**
`nextOccurrenceInTz(at, tz, now)` determines the next UTC instant at which `HH:MM` occurs in `locale.timezone`. The daily briefing fires at 06:00 household-local, regardless of what time that is in UTC.

**Weather uses `locale.timezone`, not `timezone: "auto"`.**
Open-Meteo receives the household IANA timezone for forecast date alignment. Browser-inferred timezone is never passed to external weather APIs.

**Backup timestamps display in household-local time.**
Backup filenames and admin-visible timestamps use `locale.timezone` for display. Internally, backup record timestamps remain UTC.

**Timezone changes do not trigger regeneration of existing generated content.**
Generated briefings are snapshots of the data at generation time. If the household timezone changes, already-generated briefings retain their original date context. No automatic invalidation or regeneration occurs.

## Implementation Reference

The former monorepo path and phase checklist are historical. Current shared calendar/time primitives live in `src/shared/householdTime.ts`; server household-date readers live in `src/server/lib/household-date.ts`. Timed-event storage and originating timezone are refined by `ADR-062`; audit encoding is governed by `ADR-063`. Source locations are not execution evidence.

## Affected Specs

- [the app settings registry feature](../../features/app-settings-registry.md) — timezone key ownership
- the daily briefing feature (deferred) — scheduler, day bounds, briefing date
- the meals recipes feature (deferred) — week start, meal date, plan bucketing
- the routines chores feature (deferred) — chore date keys
- the calendar feature (deferred) — range queries, event bucketing
- the reminders feature (deferred) — calendar-match date windows
- the daily messages feature (deferred) — today's messages date
- the time announcements feature (deferred) — wall-clock matching
- the weather feature (deferred) — forecast timezone alignment
- the backups feature (deferred) — backup timestamp display
- [the background jobs scheduler feature](../../features/background-jobs-scheduler.md) — fire times

## Data / Setup Implications

Fresh setup seeds `locale.timezone` with the default `Europe/Madrid`. Any process that needs "today" must read this value from the database (server) or from `useAppSettings()` (client). Business date fields in the database are `text` `YYYY-MM-DD` columns, never integer timestamps.

## Acceptance Criteria

- Given `locale.timezone = "America/New_York"` and a server running in UTC, when the daily briefing scheduler fires, it fires at 06:00 New York local time.
- Given an event stored at `2026-06-28T22:30:00Z` and `locale.timezone = "Europe/Madrid"` (UTC+2 in summer), when the calendar queries events for `2026-06-29`, the event is included (it is 00:30 Madrid-local on that day).
- Given `locale.timezone = "Europe/Madrid"` and a client browser set to UTC, when the client computes "today" for a meal plan query, it returns the Madrid-local calendar date.
- Given a timezone change from `Europe/Madrid` to `America/New_York`, when an admin saves the new locale, already-generated briefings are not regenerated or invalidated.
- Given weather configured with coordinates in Spain and `locale.timezone = "Europe/Madrid"`, the forecast date labels align with the household calendar, not the browser timezone.

## Open Questions

- None.

## Traceability

- Conflicts: `CR-005`, `CR-020`
- Related prior: `ADR-005`
- Implementation: `fix/timezones` branch, `packages/shared/src/datetime/zoned.ts`
