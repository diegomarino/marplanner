# Feature: Weather (kiosk pill + briefing block)

Behavior reference. The [owning contract](../architecture/contracts/weather.md) defines invariants and extension limits.

> Realizes the `weather` domain contract's boundary guarantees
> (WEATHER-AC-01..08; WEATHER-INV-01..12). Each Functional Requirement carries a
> `Contract: <ID>.` back-reference and the co-located `> Source <ID> — …`
> quote, per the Phase 2.4 traceability convention.

Weather is a non-critical, cross-cutting read view: a kiosk home-screen pill/modal
and a shared Daily Briefing weather block, fed by Open-Meteo for a single
household-configured location. It **owns no table** — its configuration is the App
Settings `weather` object and its only history lives in frozen briefing snapshots.
Absence, staleness, or external-API failure must never block navigation, routines,
printing, or briefing generation: the policy is silent absence.

## User workflows

### User Story 1 — See today's weather on the kiosk

A household member opens the kiosk home screen and sees a weather pill for the
configured location, with a localized condition label and rain probability; tapping
it opens current/hourly/daily detail. When no location is configured or the fetch
fails, the slot is simply empty — never an error.

### User Story 2 — Weather in the Daily Briefing

A parent generates a Daily Briefing for a date; a compact weather block for that
household-local date is included when the forecast covers it, frozen into the
snapshot. If the forecast lacks that date, the block is skipped rather than showing a
wrong-day fallback.

### User Story 3 — Configure or clear the location

A parent sets the weather location as one atomic `{lat, lon, label?}` object through
App Settings; browser geolocation may prefill the form but is not truth until saved.
An out-of-range or partial coordinate pair is rejected/disables weather rather than
being guessed, and a later coordinate change must not retroactively alter briefings
already generated.

### Edge Cases

- A partial or out-of-range `{lat, lon}` pair disables weather (no guessing).
- A blank location turns weather off on both kiosk and briefing — there is no
  environment-variable fallback.
- A forecast missing the briefing's household-local date skips the block.
- An Open-Meteo fetch that times out (5s) or fails hides the pill / skips the block
  and is logged via Client Logging, never console-only, never blocking.
- A location change must not serve stale wrong-location data from the browser cache
  within its TTL.
- An absent `label` renders no place label — never an empty city string.

## Requirements

### Functional Requirements

- **FR-001**: Given a weather location, when it is stored, then Weather MUST keep no owned table — configuration MUST live in the App Settings `weather` object and weather history MUST live only in Daily Briefing snapshots, and the browser cache MUST be treated as client-local rather than domain state. Contract: WEATHER-INV-01.

- **FR-002**: Given the weather location, when it is set or cleared, then it MUST be one atomic settings object `{lat, lon, label?}` set/cleared as a unit, and its `lat` MUST be range-validated to `[-90,90]` and `lon` to `[-180,180]` at the settings boundary, and a partial or invalid pair MUST disable weather without guessing. Contract: WEATHER-INV-02.

- **FR-003**: Given a weather location lookup, when the location is resolved, then App Settings MUST be the single source of truth with no environment fallback, and a blank location MUST turn weather off on both kiosk and briefing. Contract: WEATHER-INV-03.

- **FR-004**: Given a forecast request, when Open-Meteo is queried, then it MUST be requested with the household timezone rather than `auto`, and the resulting daily forecast dates MUST align with the household-local date. Contract: WEATHER-INV-04.

- **FR-005**: Given briefing generation, when the forecast lacks the briefing's household-local date, then the weather block MUST be skipped and a wrong-day fallback MUST NOT be substituted. Contract: WEATHER-INV-05.

- **FR-006**: Given a WMO weather code, when it is mapped to a condition, then one canonical WMO→condition-key map MUST be shared by kiosk and briefing, and condition, weekday, and date labels MUST be localized keys with no hardcoded English. Contract: WEATHER-INV-06.

- **FR-007**: Given a rain probability, when it is fetched, carried in the payload, and rendered, then it MUST be an integer percentage in `0..100` end-to-end. Contract: WEATHER-INV-07.

- **FR-008**: Given a place label, when it is supplied, then it MUST be optional manual text, and an absent label MUST render no label (no empty city), and reverse-geocoding MUST NOT be performed. Contract: WEATHER-INV-08.

- **FR-009**: Given a generated briefing weather block, when the coordinate later changes, then the snapshot MUST stay frozen and require regeneration, and it MUST NOT be retroactively mutated. Contract: WEATHER-INV-09.

- **FR-010**: Given an external forecast fetch, when it is performed, then it MUST target the fixed Open-Meteo endpoint passing only `lat/lon` params (no SSRF surface) with a 5s timeout, and on failure it MUST hide the pill or skip the block and MUST be logged via Client Logging rather than console-only, and it MUST NOT block any flow — the fetch is best-effort, never a hard dependency. Contract: WEATHER-INV-10.

- **FR-011**: Given the browser cache, when forecast data is stored, then it MUST be keyed by the coordinate pair plus schema version so that a location change MUST NOT serve stale wrong-location data within TTL. Contract: WEATHER-INV-11.

- **FR-012**: Given the non-critical weather widget, when weather is absent or stale, then it MUST follow a silent absence/stale policy and MUST NOT present a blocking error or retry UI. Contract: WEATHER-INV-12.

- **FR-013**: Given an out-of-range `{lat, lon}` coordinate, when it reaches the settings boundary, then Weather's range-validation (INV-02) MUST reject it, while atomic persistence of the location object remains App Settings' responsibility (ADR-028). Contract: WEATHER-AC-01.

- **FR-014**: Given a blank weather location, when kiosk or briefing resolves it, then weather MUST NOT be shown on either surface, and an environment fallback MUST NOT be used. Contract: WEATHER-AC-02.

- **FR-015**: Given a briefing forecast, when it is requested in the household tz, then the briefing MUST select the household-local date's entry and MUST skip if that entry is absent. Contract: WEATHER-AC-03.

- **FR-016**: Given a rain probability, when it flows from fetch to render, then it MUST stay a `0..100%` value, and web and briefing MUST share one WMO map, and labels MUST be localized. Contract: WEATHER-AC-04.

- **FR-017**: Given an Open-Meteo fetch failure, when it occurs, then it MUST be logged via Client Logging and MUST hide or skip the weather without blocking any flow. Contract: WEATHER-AC-05.

- **FR-018**: Given a location change, when it is saved, then it MUST invalidate the coordinate-keyed browser cache. Contract: WEATHER-AC-06.

- **FR-019**: Given an absent `label`, when the weather is rendered, then a place label MUST NOT be rendered. Contract: WEATHER-AC-07.

- **FR-020**: Given a coordinate change, when it is saved, then it MUST NOT mutate already-generated briefings, and reflecting it MUST require regeneration. Contract: WEATHER-AC-08.

### Key Entities

- **Weather location**: the App Settings `weather` object `{ lat: number|null,
lon: number|null, label?: string|null }` — range-validated, atomic, the single
  source of truth (no env fallback). Weather defines no endpoint of its own.
- **Forecast result**: normalized `current` / `hourly` / `daily` data for one
  location, fetched best-effort from the fixed Open-Meteo endpoint in the household
  timezone; consumed read-only by the kiosk hook and the briefing block.
- **Condition**: a canonical key derived from the WMO weather code via the one shared
  map, rendered as a localized label.
- **Briefing weather block**: a compact per-date shared block derived from the
  forecast for the briefing's household-local date, frozen into the snapshot.

## Success Criteria

- **SC-001**: 100% of out-of-range or partial `{lat, lon}` coordinate writes are
  rejected/disabled at the settings boundary — none persist as an active location.
- **SC-002**: A blank location yields 0 weather renders on kiosk and briefing, with no
  environment fallback ever consulted.
- **SC-003**: 0 Open-Meteo fetch failures block navigation, routines, printing, or
  briefing generation; every failure is recorded via Client Logging.
- **SC-004**: A coordinate change alters 0 already-generated briefing snapshots and
  serves 0 stale wrong-location cache hits within TTL.

## Assumptions

- App Settings owns the atomic persistence and the settings write boundary (ADR-028);
  Weather contributes the `lat/lon` range-validation (INV-02) and reads the resolved
  object.
- Household timezone and date-derivation primitives are provided per ADR-005; Daily
  Briefing owns snapshot freezing and the shared `daily_block_cache` rows (ADR-022).
- Client Logging (ADR-016) is the telemetry sink for fetch failures; Weather emits and
  subscribes to no bus events (ADR-040).
- Fresh v2 import (ADR-026) maps `weather_lat`/`weather_lon` into the object (empty →
  null); a partial pair is migration evidence, not a valid location.
