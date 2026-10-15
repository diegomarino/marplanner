# Admin parity: Settings rework and Overview uptime

Date: 2026-10-15. Scope: `/admin/settings` and `/admin` (overview) only. Source of behaviour: the
reference app `/Users/diego/Dev/marplanner` (read-only): `apps/web/src/features/settings/SettingsAdmin.tsx`,
`packages/shared/src/constants/timezones.ts`. Our app: `/Users/diego/Dev/marplanner-project`.

## Understanding (from the brief)

The owner wants the reference app's Settings behaviour in ours without losing our extras:

- Language and week start become pill choices, each with a short description line.
- The time zone picker is a curated, grouped list with friendly labels. The stored value is always
  selectable even when it is not in the curated list, and UTC stays.
- One Save writes locale (language, time zone, week start) and the weather location together.
  A "Saved" confirmation hides by itself. A failed load offers Retry.
- We keep the weather place label plus Clear, and the embedded day periods editor.
- The Overview gains an Uptime row. This needs a backend field. The reference's service-worker
  panel is skipped (we have no service worker).

Constraints: reuse `src/client/components/ui/*` and the shared composites; add no new shared
primitive; all strings in `src/client/i18n/messages.ts` (en + es) in one contiguous block per
locale under a `// admin-settings-overview` comment placed after the last existing admin key;
update OpenAPI and feature docs for the backend change; keep edits to shared files minimal.

## Current state (verified in code)

- `src/client/admin/SettingsManagement.tsx`: Radix `Select` for language, time zone (all
  `Intl.supportedValuesOf("timeZone")` plus `UTC` plus the current value) and week start. A Save
  button writes `PUT /api/settings {object:"locale", settings}`, then `household.retry()`. It embeds
  `DayPeriodsManagement` and, inside `<PluginContribution pluginId="weather" group="admin"
contributionId="weather">`, `WeatherManagement`.
- `src/client/admin/WeatherManagement.tsx`: self-contained. It does its own `GET /api/settings`,
  has its own Save (`PUT {object:"weather"}`) and an immediate Clear (`PUT {lat:null,lon:null}`),
  a "Use current location" geolocation prefill (never persisted until Save, FR-010), and
  both-or-neither validation. Test ids: `weather-management`, `weather-lat-input`,
  `weather-lon-input`, `weather-label-input`, `weather-locate`, `weather-save`, `weather-clear`,
  `weather-error`.
- Server: `GET/PUT /api/settings` (`src/server/routes/settings.ts`). `weather` is absent from the
  response when the weather plugin is not active (`src/server/modules/settings/index.ts:198`).
  `validateWeather` (`src/server/modules/weather/index.ts:41`) replaces the whole object: omitting
  `label` clears it; a partial lat/lon pair is rejected. `locale.timezone` is validated with
  `Intl.DateTimeFormat`, so any IANA zone (and UTC) is accepted.
- Overview: `src/client/admin/AdminOverview.tsx` reads `GET /api/telemetry/system-status`
  (`src/server/routes/telemetry.ts:~120`, type `SystemStatus` at `src/shared/index.ts:654`,
  OpenAPI schema `SystemStatus` in `docs/api/telemetry/openapi.yaml:177`, `additionalProperties:
false`). Boundary test: `tests/boundary/system-status.test.ts` pins the exact key list.
- Tests that pin today's behaviour: `tests/client/settings-management.test.tsx`,
  `tests/client/weather-management.test.tsx`, the weather describes (from "WeatherManagement —
  kiosk density" to the end) in `tests/client/network-weather-admin.test.tsx`,
  `tests/client/admin-overview.test.tsx`, `tests/boundary/system-status.test.ts`,
  `tests/e2e/weather.spec.ts` (helper `saveWeatherLocation`), plus specs that only open the page
  (`admin-unlock-resilience.spec.ts` uses `settings-save`; `day-periods.spec.ts`,
  `plugin-lifecycle*.spec.ts` use `admin-nav-settings` / `weather-management`).

## Design

### 1. Time zones: a curated module

New client-only file `src/client/admin/timezones.ts` (client-only because only the Settings page
uses it; this avoids touching `src/shared/index.ts`).

- `TIME_ZONE_GROUPS`: ordered groups `europe`, `americas`, `asiaPacific`, `africaMiddleEast`, each
  `{ id, options: { value, label }[] }`. The 37 zones and labels are the reference's list (for
  example `Europe/Madrid` -> "Madrid (CET/CEST)"). Labels are place names plus abbreviations, so
  they are not translated; only group headings are (`admin.settings.tzGroup.*`).
- A separate `UTC` option, value `UTC`, label "UTC", in its own group `utc` listed first.
- `timeZoneGroups(current: string)` returns the groups to render. If `current` is not the value of
  any option, a leading group `current` (heading "Current setting") holds one option
  `{ value: current, label: current.replaceAll("_", " ") }`. So the stored value is always
  selectable and never duplicated.
- Every curated value must pass `Intl.DateTimeFormat(undefined, { timeZone })` (unit test), because
  the server rejects invalid zones.

### 2. Settings page

`SettingsManagement` owns all form state and the single Save.

State: `persisted` and `form`, both `{ locale: LocaleObject; weather: WeatherFormState | null }`.
`weather` is `null` when `GET /api/settings` has no `weather` key (plugin inactive), in which case
the weather panel is not rendered and weather is never written. One `GET /api/settings` per mount
(and per Retry) fills both. The household context still does not refresh after a write, so the page
keeps reading on mount.

Layout, top to bottom:

1. `AdminPanel` "Settings" (heading level unchanged, test id `settings-management` on the root):
   - Language: radio-group of two pills (English, Español) plus a description line.
   - Week starts on: radio-group of two pills (Monday, Sunday) plus a description line.
   - Time zone: Radix `Select` with `SelectGroup`/`SelectLabel` per group (existing primitives),
     plus a description line. Trigger keeps `data-testid="settings-timezone"`.
2. `WeatherManagement` (inside the existing `PluginContribution`), now a controlled panel: lat, lon,
   label, "Use current location", "Clear location". No Save of its own.
3. Save row: `ErrorNotice` (`settings-error`), then the Save button (`settings-save`) and a
   "Saved" message (`settings-saved`, `role="status"`).
4. `DayPeriodsManagement`, unchanged, with its own save (it edits a different resource and has its
   own conflict handling). The page copy states that the Save button covers the sections above it.

Pills: a small local component `ChoicePills` inside `SettingsManagement.tsx` renders a
`role="radiogroup"` of `Button`s with `role="radio"` and `aria-checked` (variant `default` when
selected, `outline` otherwise). It is not shared (brief rule 13). Test ids
`settings-language-en|es`, `settings-week-start-1|0`.

Save semantics (one click, up to two requests; the API has no multi-object write):

1. If locale differs from persisted: `PUT {object:"locale", settings: form.locale}`.
2. If weather exists and differs: `PUT {object:"weather", settings}`, where `settings` is
   `{lat, lon}` as numbers or `null`, plus `label` only when non-blank (omission clears it).
3. Requests run in this order, sequentially. After each success the matching `persisted` and `form`
   slice are replaced by the response, so a failure in step 2 leaves step 1 saved and only the
   weather still dirty. On any failure: stop, show the localized fallback message
   (`admin.settings.saveError`, or the `LocalizedApiError` message for weather: unchanged rule that
   the server's raw text is never shown for locale), keep the user's edits.
4. If at least one request succeeded, call `household?.retry()` so the app reloads language, time
   zone, week start and the weather pill.
5. Only when every needed request succeeded: set `saved`, which auto-hides after 3 seconds
   (cleared on unmount and on the next edit).

Save is disabled when nothing is dirty, while saving, or while the weather pair is invalid
(partial or non-numeric). In that case a hint under the weather fields says why
(`admin.settings.weatherIncomplete`).

Clear location: empties lat, lon and label in the form (staged, not written). It is persisted by
Save. This replaces the old immediate clear, which would otherwise bypass the one-Save rule.
Documented as a behaviour change in `docs/features/weather.md`.

Load error: `ErrorNotice` plus a Retry button (`settings-retry`) that reruns the load; no form is
shown meanwhile.

### 3. Overview uptime

- `SystemStatus` gains `uptimeSeconds: number` (integer seconds since the server process started,
  `Math.floor(process.uptime())`). Server: `telemetry.ts` handler. OpenAPI: add the property, required,
  `type: integer`, `minimum: 0`. Boundary test: key list becomes
  `["build","checkedAt","status","uptimeSeconds"]` and the value is a non-negative integer.
- UI: a new row "Uptime" in the System Status card after "Last check". Format with
  `Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "narrow" })`, up to the two largest
  non-zero units among day, hour, minute (for example `2d 3h`), and seconds only below one minute
  (`42s`). While loading it shows an ellipsis; if the field is missing or not a number (older server
  during a deploy) it shows an em dash. The formatting lives in an exported pure function
  `formatUptime(seconds, locale)` in `AdminOverview.tsx`, unit tested.
- "Check now" already re-reads status, so uptime refreshes with it.

### 4. i18n

New keys, in one block per locale, placed after `"admin.overview.logs.loadError"` /
`"admin.notFound.description"` (the last existing admin keys in each locale), under the comment
`// admin-settings-overview`:

| Key                                       | en                                                                                               | es                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `admin.overview.uptime`                   | Uptime                                                                                           | Tiempo en marcha                                                                                                          |
| `admin.settings.languageDescription`      | The language used across the household screens.                                                  | El idioma de todas las pantallas del hogar.                                                                               |
| `admin.settings.weekStartDescription`     | The first day shown in weekly views.                                                             | El primer día que se muestra en las vistas semanales.                                                                     |
| `admin.settings.timezoneDescription`      | Used for dates, schedules and daily rollovers.                                                   | Se usa para fechas, horarios y cambios de día.                                                                            |
| `admin.settings.tzGroup.current`          | Current setting                                                                                  | Valor actual                                                                                                              |
| `admin.settings.tzGroup.utc`              | UTC                                                                                              | UTC                                                                                                                       |
| `admin.settings.tzGroup.europe`           | Europe                                                                                           | Europa                                                                                                                    |
| `admin.settings.tzGroup.americas`         | Americas                                                                                         | América                                                                                                                   |
| `admin.settings.tzGroup.asiaPacific`      | Asia-Pacific                                                                                     | Asia-Pacífico                                                                                                             |
| `admin.settings.tzGroup.africaMiddleEast` | Africa & Middle East                                                                             | África y Oriente Medio                                                                                                    |
| `admin.settings.saved`                    | Saved                                                                                            | Guardado                                                                                                                  |
| `admin.settings.saving`                   | Saving…                                                                                          | Guardando…                                                                                                                |
| `admin.settings.retry`                    | Retry                                                                                            | Reintentar                                                                                                                |
| `admin.settings.weatherIncomplete`        | Enter both latitude and longitude, or clear both.                                                | Introduce latitud y longitud, o borra ambas.                                                                              |
| `admin.settings.scopeNote`                | Save applies to language, week start, time zone and weather. Day periods are saved on their own. | Guardar aplica al idioma, el inicio de semana, la zona horaria y el tiempo. Los periodos del día se guardan por separado. |

Existing keys reused unchanged: `admin.settings.title|description|language|timezone|weekStart|monday|
sunday|save|loadError|saveError`, `weather.management.*` (loading/loadError/saveError/clearError/
saving/save become unused after the refactor; delete them from both locales so no dead keys remain,
and update `tests/client/weather-i18n-parity.test.ts` only if it names them).

The weather-management keys that remain used: title, description, latLabel, lonLabel, labelLabel,
labelPlaceholder, locate, locating, geolocationError, clear.

## Decisions / Assumptions

1. Client-only timezone list in `src/client/admin/timezones.ts`, not in `src/shared`, to avoid the
   shared-file conflict hotspot. Reference list copied as is; the reference file is marked as dead
   code upstream, so there is nothing to keep in sync.
2. The pills are a local component, not a shared primitive. If the owner wants them shared, that is
   a separate change.
3. One Save = up to two sequential PUTs (locale, then weather). The settings API writes one object
   per request; making it multi-object is out of scope. Partial success is handled as above.
4. Clear location becomes staged (needs Save). This is the only way to honour "one Save".
5. Day periods keep their own save. They are a different resource with their own validation and
   neighbour-derived ends; merging them is not in the brief.
6. Weather is shown only when `GET /api/settings` includes `weather` and the plugin contribution is
   active (existing gating), matching the current behaviour and the plugin e2e specs.
7. Uptime is process uptime, not host uptime, in whole seconds.
8. The `Saved` text replaces the `✓ Save` button label; the button keeps its normal label.
9. The reference's blank-zone default (`APP_SETTING_DEFAULTS`) is irrelevant: our server owns defaults.
10. Language switch note: after Save the app reloads household settings, so the page language changes
    immediately; the "Saved" text is rendered in the new language. Acceptable.

## Out of scope

Service-worker panel, a multi-object settings write, merging day periods into the Save, reference
"Detect automatically" wording (we keep "Use current location").

## Testing

- Unit/component (vitest, `tests/client`): timezones module, `formatUptime`, `WeatherManagement`
  controlled behaviour, `SettingsManagement` (pills, grouped zones, current value selectable, one
  Save with locale only / weather only / both, partial failure, auto-hide of Saved, Retry,
  weather absent), `AdminOverview` uptime row.
- Server (vitest boundary): system-status body now has `uptimeSeconds`.
- E2E (port 43208): `weather.spec.ts` adapted to the single Save; new
  `tests/e2e/admin-settings.spec.ts` covering pills, Save and persistence; unaffected specs that
  open the page re-run.
- Gate: `npm run check:standard` from a clean committed tree.
