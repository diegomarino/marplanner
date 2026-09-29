# ADR-028 Settings Write API Contract: Discriminated Union per Object

Status: accepted
Owner: architecture
Decision date: 2026-06-27

## Decision

`PUT /settings` accepts a body of the form `{ "object": OBJECT_NAME, "settings": { ... } }`.

`OBJECT_NAME` is a member of the canonical settings object registry. The server validates `settings` against the schema defined for that object and persists the entire object atomically. Unknown object names are rejected. Fields missing from a required object schema are rejected.

`GET /settings` returns the complete effective settings map structured as an object whose top-level keys mirror the canonical object names.

`PATCH /settings` does not exist. There are no per-key or batch-array write endpoints.

### Canonical object registry (v2 initial)

| Object name        | Fields                                 | Notes                                                                                                                                                                                                                                           |
| ------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `locale`           | `timezone`, `language`, `weekStartDay` | Grouped as household display identity. Timezone must be a valid IANA timezone name. Language constrained to supported locales. weekStartDay is 0 (Sunday) or 1 (Monday).                                                                        |
| `weather`          | `lat`, `lon`                           | Coordinate pair written and cleared as a unit. Both must be finite numbers within valid lat/lon ranges, or both must be null/empty to clear.                                                                                                    |
| `printer`          | `paperWidthDots`                       | Transport-independent base config. (`enabled`/`autoprint` removed by ADR-038/Printing contract: "printing available" = plugin active; "automatic" = an active automatic trigger bound, not a flag.)                                             |
| `printerTransport` | `type`, `config`                       | Nested discriminated union. `type` selects the transport (`bluetooth` in v2). `config` is validated against the schema for that type. Only `bluetooth` is a valid type in v2; `wifi` and `usb` are added when those transports are implemented. |

## Plugin Settings Extension

Per ADR-029, plugins (Weather, Printing, Daily Briefing, etc.) register their own object names in the settings registry. `GET /settings` returns core objects plus all active plugin objects in a single response. `PUT /settings` accepts any registered object name, whether core or plugin. The core server does not need to know the schema of plugin objects statically — plugins register their object name and schema at activation.

Core objects: `locale` only.
Plugin objects (examples): `weather` (Weather plugin), `printer` + `printerTransport` (Printing plugin).

## Rationale

The flat `{ key, value }[]` batch from the current implementation has two problems: it allows unrelated settings to be grouped arbitrarily (no semantic coupling), and it requires a transaction as an afterthought to achieve atomicity. The discriminated union makes coupling explicit in the schema — you cannot submit a partial weather coordinate pair because the `weather` object requires both fields — and atomicity is a natural consequence of persisting one object at a time.

The `locale` grouping (timezone + language + weekStartDay) reflects that these three settings define the household's display identity and are typically reviewed together. Saving them as a unit prevents inconsistent intermediate states such as a new timezone paired with a stale language.

A single `/settings` endpoint for both core and plugin settings simplifies cold-boot for the kiosk client: one fetch returns everything the kiosk needs to render correctly, regardless of which plugins are active.

## Affected Specs

- [the app settings registry feature](../../features/app-settings-registry.md) — §4 behaviors, §5 permissions, §9 interface surface, §11 quirks

## Data / Setup Implications

Fresh v2 setup seeds canonical default values for all object fields. The effective settings response always returns all objects with all fields, filling any missing persisted value from its default. No legacy flat key/value rows are migrated; they are evidence only under `ADR-026`.

## Acceptance Criteria

- Given an unknown object name, when a client submits `PUT /settings`, then the server returns a 400/422 error.
- Given a `weather` object with only `lat` and no `lon`, when a client submits `PUT /settings`, then the server rejects the request.
- Given a valid `locale` object, when a client submits `PUT /settings`, then timezone, language, and weekStartDay are all persisted in a single transaction; a storage failure leaves all three at their prior values.
- Given `GET /settings`, the response includes all canonical objects with all fields, using defaults for any field without a persisted value.
- Given `printerTransport` with `type: "wifi"` (not yet implemented), when a client submits `PUT /settings`, then the server rejects the request with an unsupported transport error.
- Given `printerTransport` with `type: "bluetooth"` and a partial `config` missing required pairing fields, when a client submits `PUT /settings`, then the server rejects the request.

## Open Questions

- None for this decision. Printer object granularity resolved: `printer` + `printerTransport` discriminated union. WiFi/USB resolved: not in registry until transport is implemented.

## Traceability

- Conflicts: `CR-007`, `CR-009`, `CR-022`
- Pre-v2: `ADR-009` (atomicity resolved by design), `ADR-021` (validation resolved by per-object schema)
