# Time Announcements Domain Contract

Status: maintained contract
Depends on decisions: `ADR-005`, `ADR-013`, `ADR-015`, `ADR-020`, `ADR-026`, `ADR-028`,
`ADR-030`, `ADR-035`, `ADR-040`, `ADR-051`

## Purpose

Household-wide spoken time reminders: a parent/admin defines a wall-clock `HH:MM` + the
weekdays it should play; each connected kiosk browser speaks a short localized phrase at
matching minutes. Server owns the rules; speech is a client-side runtime behavior.

## Vocabulary

- **Time announcement (rule)** — `{ id, time (HH:MM), weekDays (mon..sun), isActive,
createdAt, updatedAt }`.
- **Fire** — a browser speaking the phrase for a rule at its matching local minute.
- **Dedupe key** — `(household-local date, HH:MM, ruleId)`, browser-local.

## Invariants

1. **TIME-ANNOUNCEMENTS-INV-01** **Wall-clock + weekday in household tz** (`ADR-005`): `time`, weekday, local date, and
   dedupe keys all resolve in the household timezone — never UTC, never browser tz.
2. **TIME-ANNOUNCEMENTS-INV-02** **`time`** is strict `HH:MM` 24h (`00:00`–`23:59`), rejected (not normalized) at write.
3. **TIME-ANNOUNCEMENTS-INV-03** **Weekdays** are a non-empty `mon..sun` set (`ADR-020`); `weekdayOf` derivation.
4. **TIME-ANNOUNCEMENTS-INV-04** **Active-overlap rule:** two **active** rules must not share `HH:MM` + an overlapping
   weekday; inactive rules may overlap (they don't fire). Checked at write against the
   latest persisted rows (concurrency: LWW by id, conflict re-checked at save).
5. **TIME-ANNOUNCEMENTS-INV-05** **`isActive`** soft-disables (editable/listable, doesn't fire); **delete is permanent**
   (no archive tier — rules are cheap, no historical value).
6. **TIME-ANNOUNCEMENTS-INV-06** **Firing is client-side, per connected browser** (`ADR-035`/`ADR-051`): the server owns
   rule data only and never fires. Within a browser, tabs elect one leader; dedupe is
   per-browser by the dedupe key.
7. **TIME-ANNOUNCEMENTS-INV-07** **Multi-device double-speak accepted** (`ADR-051`): no cross-device coordination (unlike
   printing's atomic claim — double-speech is harmless). Each device may speak.
8. **TIME-ANNOUNCEMENTS-INV-08** **Speech is best-effort** (`ADR-035`): missing/blocked speech is a no-op, swallowed,
   never crashes the scheduler; no persisted retry/failure state. A dedupe/localStorage
   failure never silences a legitimate announcement.
9. **TIME-ANNOUNCEMENTS-INV-09** **Speech language = household locale always** (`ADR-015`): utterance `lang` is the
   household locale (matching voice if present, else browser-default voice + correct
   `lang` + logged miss). Phrase wording is localized product copy (keys), not hardcoded
   Spanish.
10. **TIME-ANNOUNCEMENTS-INV-10** **No new settings** (`ADR-051`): no master switch / quiet hours / volume·rate·pitch /
    per-device enablement in v2. Household-wide.
11. **TIME-ANNOUNCEMENTS-INV-11** **Invalid timezone is unreachable** (`ADR-028` validates IANA at the settings
    boundary); the scheduler is defensive regardless (format failure → no fire + health
    signal, never crash).

## Behaviors

- **CRUD (admin):** list (incl. inactive, ordered by time), create, partial edit, toggle
  active, delete. Write validates `HH:MM`, non-empty weekdays, and active-overlap.
- **Schedule + fire (client):** the shell-mounted scheduler (`ADR-035`) computes the next
  active fire using tz-aware calendar arithmetic (DST-safe), arms a timeout, and on match
  the leader tab speaks; visibility-resume + a safety interval re-evaluate. Inactive /
  empty-weekday rules are ignored.
- **Speak:** cancel the current speech queue, build a localized phrase for the
  hour/minute (special wording for midnight/noon/quarters/half), speak with `lang` =
  household locale.
- **Test voice (admin):** speak the form's unsaved time locally; creates/fires no rule.

## Interfaces

- Inbound: rule CRUD (admin write capability, `ADR-030`); schedule list (kiosk-visible).
- Consumed: household `timezone` + `language` via the settings surface (`ADR-005`/
  `ADR-015`); shell mount + connection state (`ADR-035`).

## Events

(`ADR-040`.) **Emits: none. Subscribes: none.** Rules are read by the client scheduler on
load/refetch (pull), not via the bus. Firing is browser-local. A best-effort speech/voice
failure may increment a local health counter (`ADR-035`), not a domain event.

## Data / Setup Contract

Owned: `time_announcements` (id, time, weekDays, isActive, createdAt, updatedAt). Fresh v2
(`ADR-026`); 7 prod rows evidence only (validate `HH:MM`/weekday on any import, quarantine
corrupt rows rather than failing the whole list). Dedupe state is browser-local, not
server state. No owned settings object.

## Acceptance Criteria

- **TIME-ANNOUNCEMENTS-AC-01** Malformed `HH:MM` / empty weekdays rejected; no row created.
- **TIME-ANNOUNCEMENTS-AC-02** Active rule overlapping another active rule (same time + shared weekday) rejected;
  inactive overlaps allowed.
- **TIME-ANNOUNCEMENTS-AC-03** Scheduler fires by household-local weekday + `HH:MM`, DST-safe.
- **TIME-ANNOUNCEMENTS-AC-04** Within one browser, at most one speak per minute (leader + dedupe); across devices each
  may speak.
- **TIME-ANNOUNCEMENTS-AC-05** Utterance `lang` is the household locale; wording localized, not hardcoded Spanish.
- **TIME-ANNOUNCEMENTS-AC-06** Speech/dedupe failure changes no rule state and never crashes the scheduler.
- **TIME-ANNOUNCEMENTS-AC-07** Rule CRUD requires admin write; listing is kiosk-visible.
- **TIME-ANNOUNCEMENTS-AC-08** No master switch / quiet hours / per-device / audio-control settings exist.

## Open Decisions

- Voice/rate/volume/quiet-hours as future App Settings — deferred, not built.
- Activation conflict-resolution UI (vs plain write rejection) — UI detail, deferred.

## Peer Review

Not peer-reviewed: low-risk domain, no new security or data-loss surface; firing placement
inherits `ADR-035`, language inherits `ADR-015`, weekdays/tz inherit `ADR-020`/`ADR-005`.
The only judgment call (accept multi-device double-speak vs server-coordinate) is a
proportionality decision recorded in `ADR-051`. (Same rationale as Day Periods / Daily
Messages.)
