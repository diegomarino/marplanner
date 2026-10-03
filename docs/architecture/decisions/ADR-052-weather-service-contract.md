# ADR-052 Weather Service Contract (tz, single-source location, correctness fixes)

Status: accepted
Owner: product + architecture
Decision date: 2026-06-29

## Decision

Weather is a **cross-cutting, non-critical service with no owned table**: configuration
is an App Settings object; history lives only in Daily Briefing snapshots. Absence,
staleness, or external-API failure must never block navigation, routines, printing, or
briefing generation.

**Location = one App Settings object `{lat, lon, label?}`, set/cleared as a unit**
(`ADR-028`/`ADR-009` per-object atomic write). Replaces the v1 two-key admin
weather-location endpoint and the split-pair hazard. `lat`/`lon` are **range-validated**
at the settings boundary (`lat ∈ [-90,90]`, `lon ∈ [-180,180]`), not merely parsed finite;
a partial/invalid pair disables weather (no guessing).

**Single source of truth — env fallback dropped.** The v1 server-side `WEATHER_LAT`/
`WEATHER_LON` env fallback is **removed**. App Settings is the only weather location;
"Weather Location blank = weather off everywhere" (kiosk and briefing agree). This
eliminates the v1 incoherence where the briefing showed weather from env while the kiosk
showed none. A deployer wanting a default seeds the settings value.

**Forecast timezone = household timezone** (`ADR-005`, fixes latent L9). Open-Meteo is
requested with the **household timezone**, not `timezone=auto`, so daily forecast dates
align with the household-local date the briefing matches against. No more wrong-day drift
when the forecast location's tz differs from the household tz.

**Missing briefing date in forecast → skip the block.** If the forecast does not contain
the briefing's household-local date, the weather block is **skipped** (normal no-block),
never the v1 first-daily-entry fallback that silently showed the wrong day. "Missing data
= skip, never wrong data."

**Place label = optional manual field, no geocoding.** `label` is an optional free-text
household display name in the weather object; when absent, **no place label is rendered**
(never an empty-string city). **No reverse-geocoding** — that would add another external
call + a privacy surface for a cosmetic value.

**Correctness/consistency fixes (free wins):**

- **One canonical WMO-code → condition-key map**, shared by the kiosk and the briefing
  block (fixes the v1 divergent buckets); condition labels are i18n keys (`ADR-015`), as
  are weekday/date labels (fixes hardcoded English).
- **Rain probability has one canonical unit end-to-end:** 0..100 integer percent across
  fetch / payload / render (fixes the v1 0..1-vs-raw-% inconsistency).
- **Browser cache keyed by coordinate pair (+ schema version)** so a location change
  cannot serve stale wrong-location data within the TTL.
- **Silent absence/stale** remains the policy for the non-critical widget — no blocking
  error/retry UI.

**Snapshot + telemetry + permissions (precedent).** Generated briefing weather is frozen
(`ADR-022`); a coordinate change needs regeneration, never retroactive mutation. Fetch
failures route through **Client Logging** (`ADR-016`), not console-only. Coordinate writes
use the shared settings write capability (`ADR-007`/`ADR-030`); no weather-specific policy.

**External surface.** Open-Meteo is the **default endpoint** with coordinate parameters (not a
user-supplied URL) → no SSRF surface (unlike calendar ICS feeds). Only input is the
range-validated `lat/lon`. 5-second fetch timeout; failure → hide/skip per caller.

> **Amendment (2026-06-30, host-coupling re-scan, peer-reviewed):** the endpoint is
> **operator-overridable via `WEATHER_ENDPOINT`** (env, default `https://api.open-meteo.com`),
> with `WEATHER_ENABLED=false` to disable the feature. This is **not** an SSRF reopening — SSRF
> applies to _user/plugin_-supplied URLs reaching `fetch()`; an operator setting an env var on
> their own deployment is already trusted. The override is a standard portability affordance for
> egress-restricted / proxied / air-gapped self-hosters. Default stays fixed. Registered in
> `../target-dx-contract-v2.md` § _Operator Configuration & Runtime Environment_.

## Rationale

Weather's value is a glanceable, never-blocking widget. v1's real defects were temporal
(forecast-tz drift, wrong-day fallback) and coherence (env-vs-settings split, divergent
condition maps, inconsistent rain units) — all fixed by anchoring to the household tz,
making App Settings the single source, skipping rather than guessing, and unifying the
mappings. The external surface is minimal (fixed endpoint), so the work is correctness,
not security.

## Affected Specs

- `../../14-weather.md`, `../../03-app-settings-registry.md` (weather object gains
  `label?` + range validation), `../../11-daily-briefing.md` (weather block)

## Data / Setup Implications

No owned table. App Settings `weather` object: `{ lat: number|null, lon: number|null,
label?: string|null }`, range-validated, atomic. No env fallback. Fresh deployment (`ADR-026`):
import `weather_lat`/`weather_lon` as the object's values (empty → null); a partial pair is
migration evidence, not a valid location. Historical briefing weather payloads preserved
as-is (not recomputed). Browser cache is client-local (coordinate-keyed), not domain state.

## Acceptance Criteria

- Saving the location writes `{lat, lon}` atomically; an out-of-range coordinate is
  rejected at the settings boundary.
- With the location blank, neither the kiosk nor the briefing shows weather (no env
  fallback).
- The forecast is requested in the household tz; the briefing selects the daily entry for
  the household-local date, and **skips** if that date is absent.
- Rain probability is 0..100% consistently from fetch to render.
- Web and briefing use the same WMO→condition mapping; labels are localized.
- A weather fetch failure is logged via Client Logging and skips the block/hides the pill;
  no user-facing flow is blocked.
- A location change invalidates the coordinate-keyed browser cache.
- An absent `label` renders no place label (no empty-string city).

## Open Questions

- None blocking. (Stale-indicator UX remains "silent absence" by decision.)

## Traceability

- Related prior: resolves spec `14` open questions (`ADR-005`/`ADR-007`/`ADR-009` weather
  applications).
- Domain grill: `../domain-grills/weather.md`
- Related: `ADR-005`, `ADR-007`, `ADR-015`, `ADR-016`, `ADR-022`, `ADR-026`, `ADR-028`,
  `ADR-030`
