# ADR-051 Time Announcements: Firing Model and Product Surface

Status: accepted
Owner: product + architecture
Decision date: 2026-06-29

## Decision

Resolves the open Time Announcements questions. Most of the domain is settled by
precedent (`ADR-005` tz, `ADR-015` speech language, `ADR-020` weekdays, `ADR-035`
placement, `ADR-030` auth, `ADR-026` no import); this decision fixes the firing/dedupe
model and the product surface.

**Firing/dedupe = client per-browser, no server coordination.** Speech is inherently
client-side (Web Speech API), so per `ADR-035` it is a **UI-bound service mounted per
connected browser**, running on all connected routes (incl. admin). The server **owns
only the rule data** (CRUD) and does **not** fire. Within a browser, tabs elect one
leader (e.g. BroadcastChannel) to avoid multi-tab double-speak; dedupe is keyed by
`(household-local date, HH:MM, ruleId)`.

**Multi-device double-speak is accepted, not coordinated.** Leader election and dedupe
are **per browser/device**, not cross-device. Two physical displays will each speak the
same minute. This is **deliberate**: unlike printing (where the `ADR-035` atomic-claim
exists because double-print wastes paper), double-speech is harmless and arguably
desirable per display, so a server-coordinated single-speaker (atomic claim) would be
over-engineering for the single-display family-kiosk value model. A dedupe/localStorage
failure must never silence a legitimate announcement or crash the scheduler.

**No server/external TTS.** Browser Web Speech only; no server-rendered or external TTS
backend (YAGNI for a family kiosk). Speech is best-effort: missing/blocked speech is a
no-op, swallowed, never crashes the kiosk; no persisted retry or failure record (a
best-effort failure _count_ may feed the health indicator, `ADR-035`, but is not state).

**Product surface kept minimal (no new settings).**

- **No master switch / quiet hours / volume·rate·pitch controls** in this system — per-rule
  `isActive` already pauses; the rest is YAGNI (noted as possible future App Settings).
- **No per-device enablement** — household-wide (which device speaks is the Q1 model, not
  a setting).
- **Delete + isActive both kept:** `isActive` soft-disables (editable/listable, doesn't
  fire); **delete is permanent**. A rule is cheap and has no historical value (unlike
  meals/briefings), so no archive tier.

**Validation / invariants.**

- `time` = strict `HH:MM` 24h (`00:00`–`23:59`), rejected (not normalized) at write.
- Non-empty weekday set required (`mon..sun`, `ADR-020`).
- Two **active** rules must not share `HH:MM` + an overlapping weekday; inactive rules may
  overlap (they don't fire). Overlap is checked at write **against the latest persisted
  rows** (concurrency: last-write-wins by id, conflict re-checked at save).
- **Invalid timezone is unreachable:** `ADR-028` validates `timezone` as a valid IANA name
  at the settings boundary, so the scheduler never receives an invalid persisted tz. The
  scheduler is defensive anyway (a formatting failure → no fire + health signal, never a
  crash).

**Speech language** (restating `ADR-015`): the utterance `lang` is **always the household
locale** (matching voice if present, else browser-default voice with the correct `lang`
set + logged miss). The phrase wording (midnight/noon/quarters/etc.) is product copy in
the household language (`ADR-015` keys), not hardcoded Spanish.

## Rationale

Speech can only happen in a browser, so the server can't own firing; `ADR-035` already
places it as a per-browser UI service. The only real fork was cross-device coordination,
and the printing analogy clarifies it: atomic-claim exists to prevent a _costly_ double
action; speaking the time twice costs nothing, so the cheap per-device model wins. The
product surface stays minimal because per-rule active state already covers pausing, and a
family kiosk doesn't need an audio mixing console.

## Affected Specs

- [time-announcements](../../features/time-announcements.md)

## Data / Setup Implications

Owned: `time_announcements` (id, time `HH:MM`, weekDays `mon..sun`, isActive,
createdAt, updatedAt). Fresh deployment (`ADR-026`); 7 prod rows evidence only. Dedupe state is
browser-local (not server state). No new settings object.

## Acceptance Criteria

- A malformed `HH:MM` or empty weekday set is rejected; no row created.
- An active rule overlapping another active rule at the same time + a shared weekday is
  rejected at write; inactive overlaps are allowed.
- The scheduler fires by household-local weekday + `HH:MM` (`ADR-005`), surviving DST.
- Within one browser, multiple tabs speak at most once (leader + local dedupe); across
  devices, each device may speak (accepted).
- The utterance `lang` is the household locale; phrase wording is localized, not hardcoded
  Spanish.
- Speech/dedupe failure changes no rule state and never crashes the scheduler.
- Rule CRUD requires an admin write capability; listing is kiosk-visible.
- No master switch / quiet hours / per-device / audio-control settings exist in this system.

## Open Questions

- Voice/rate/volume/quiet-hours as future App Settings — deferred, not built.
- Activation conflict-resolution UI (vs plain write rejection) — UI detail, deferred.

## Traceability

- Related prior: resolves spec `09` open questions.
- Domain grill: `domain-grills/time-announcements.md` (historical record, not preserved in this repository)
- Related: `ADR-005`, `ADR-013`, `ADR-015`, `ADR-020`, `ADR-026`, `ADR-028`, `ADR-030`,
  `ADR-035`
