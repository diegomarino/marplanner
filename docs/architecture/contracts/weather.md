# Weather Domain Contract

Status: maintained contract
Depends on decisions: `ADR-005`, `ADR-007`, `ADR-015`, `ADR-016`, `ADR-022`, `ADR-026`,
`ADR-028`, `ADR-030`, `ADR-040`, `ADR-052`

## Purpose

A non-critical, cross-cutting weather view: a kiosk home-screen pill/modal and a shared
Daily Briefing block, fed by Open-Meteo for a household-configured location. **Owns no
table.** Absence, staleness, or external-API failure must never block navigation,
routines, printing, or briefing generation.

## Vocabulary

- **Weather location** — the App Settings `weather` object `{ lat, lon, label? }`.
- **Forecast result** — normalized `current` / `hourly` / `daily` data for one location.
- **Condition** — a canonical key derived from the WMO weather code (localized label).
- **Briefing weather block** — compact per-date shared block derived from the forecast.

## Invariants

1. **WEATHER-INV-01** **No owned table** (`ADR-052`): configuration is the App Settings `weather` object;
   history lives only in Daily Briefing snapshots (`ADR-022`). The browser cache is
   client-local, not domain state.
2. **WEATHER-INV-02** **Location is one atomic settings object** `{lat, lon, label?}` (`ADR-028`/`ADR-009`),
   set/cleared as a unit; `lat ∈ [-90,90]`, `lon ∈ [-180,180]` **range-validated** at the
   settings boundary. A partial/invalid pair disables weather (no guessing).
3. **WEATHER-INV-03** **Single source of truth — no env fallback** (`ADR-052`): App Settings is the only
   weather location; blank location = weather off on both kiosk and briefing.
4. **WEATHER-INV-04** **Forecast tz = household tz** (`ADR-005`): Open-Meteo is requested with the household
   timezone (not `auto`); daily forecast dates align with the household-local date.
5. **WEATHER-INV-05** **Missing date → skip** (`ADR-052`): if the forecast lacks the briefing's household-local
   date, the block is skipped — never a wrong-day fallback.
6. **WEATHER-INV-06** **Canonical mappings** (`ADR-015`): one WMO→condition-key map shared by kiosk + briefing;
   condition, weekday, and date labels are localized keys (no hardcoded English).
7. **WEATHER-INV-07** **Rain probability is 0..100 integer %** end-to-end (fetch/payload/render).
8. **WEATHER-INV-08** **Place label** is optional manual text; absent → no label rendered (no empty city). No
   reverse-geocoding.
9. **WEATHER-INV-09** **Snapshot** (`ADR-022`): generated briefing weather is frozen; coordinate change needs
   regeneration, never retroactive mutation.
10. **WEATHER-INV-10** **Best-effort external fetch:** fixed Open-Meteo endpoint (no SSRF surface — only
    `lat/lon` params), 5s timeout; failure hides the pill / skips the block and is logged
    via Client Logging (`ADR-016`), never console-only, never blocking.
11. **WEATHER-INV-11** **Browser cache keyed by coordinate pair (+ schema version)** so a location change
    cannot serve stale wrong-location data within TTL.
12. **WEATHER-INV-12** **Silent absence/stale** policy: no blocking error or retry UI for the non-critical
    widget.

## Behaviors

- **Kiosk pill/modal:** home-route-only hook reads the location, validates the pair,
  checks the coordinate-keyed cache, fetches on miss; renders current/hourly/daily with
  localized labels; absent/failed → empty slot, no error.
- **Briefing weather block (shared per date):** resolve location from settings; use shared
  cache when present else fetch in household tz; select the daily entry for the briefing's
  household-local date or **skip**; map WMO→condition; freeze the payload (`ADR-022`).
  `weatherText` delegates to the canonical `weather` block.
- **Set/clear location:** via the unified `ADR-028` settings write (atomic object); browser
  geolocation may prefill the form but is not truth until saved.

## Interfaces

- Inbound: weather location read/write via App Settings (`ADR-028`) — Weather defines no
  endpoint of its own.
- Outbound (consumed): a normalized forecast for a location, used by the kiosk hook and
  the Daily Briefing block (read interface; no cross-module table access).
- External: Open-Meteo forecast (fixed endpoint, coordinate params, 5s timeout).

## Events

(`ADR-040`.) **Emits: none. Subscribes: none.** Weather is a pull-time read service
(kiosk hook + briefing generation). Fetch failures are a Client Logging telemetry write
(`ADR-016`), not a bus event.

## Data / Setup Contract

No owned table. App Settings `weather` object `{ lat: number|null, lon: number|null,
label?: string|null }`, range-validated, atomic. **No env fallback.** Fresh v2
(`ADR-026`): import `weather_lat`/`weather_lon` into the object (empty → null); a partial
pair is migration evidence, not a valid location. Historical briefing weather payloads are
preserved as-is (never recomputed). Shared `daily_block_cache` weather rows are Daily
Briefing cache, not Weather-owned.

## Acceptance Criteria

- **WEATHER-AC-01** An out-of-range `{lat, lon}` coordinate is rejected by Weather's range-validation at the settings boundary (INV-02); atomic persistence of the location object is App Settings' (ADR-028).
- **WEATHER-AC-02** Blank location → no weather on kiosk or briefing (no env fallback).
- **WEATHER-AC-03** Forecast requested in household tz; briefing selects the household-local date's entry
  and skips if absent.
- **WEATHER-AC-04** Rain probability is 0..100% from fetch to render; web + briefing share one WMO map;
  labels localized.
- **WEATHER-AC-05** A fetch failure is logged via Client Logging and hides/skips without blocking any flow.
- **WEATHER-AC-06** A location change invalidates the coordinate-keyed browser cache.
- **WEATHER-AC-07** An absent `label` renders no place label.
- **WEATHER-AC-08** A coordinate change does not mutate already-generated briefings (regen required).

## Open Decisions

- None blocking. Stale-indicator UX is intentionally "silent absence".

## Peer Review

Not peer-reviewed: minimal external surface (fixed Open-Meteo endpoint, no SSRF; only
range-validated `lat/lon`), no owned table, no new data-loss surface. Work is correctness
(household-tz forecast, skip-not-guess, single-source location, unified mappings)
inheriting `ADR-005`/`ADR-015`/`ADR-022`/`ADR-028`. (Same rationale as Time Announcements /
Day Periods.)
