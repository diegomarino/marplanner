# App Settings Registry Domain Contract

Status: maintained contract
Depends on decisions: `ADR-005`, `ADR-007`, `ADR-008`, `ADR-028`, `ADR-029`, `ADR-040`

## Purpose

App Settings Registry owns the household-wide runtime settings that the kiosk and server need to behave correctly. It provides one predictable endpoint for reading and writing named settings objects, available at cold boot with the API key boundary alone.

It does not own authentication logic, printer strategies, weather fetches, or any domain-specific behavior — it owns only the stored configuration values and their write contract.

## Vocabulary

**Settings object** — a named, schematically validated group of related settings fields. Identified by `object_name`.

**Core object** — a settings object always present, regardless of which plugins are active.

**Plugin object** — a settings object present in the response only when the owning plugin is active.

**Effective settings** — the complete response from `GET /settings`: all core objects with all fields (defaults filling any missing persisted value), plus all plugin objects for active plugins.

**Absent object** — a settings object not present in `GET /settings` because its plugin is not active.

## Invariants

- **APP-SETTINGS-REGISTRY-INV-01** The API key is the sole backend authorization boundary. PIN state is never evaluated by any settings endpoint.
- **APP-SETTINGS-REGISTRY-INV-02** `GET /settings` is always available at cold boot. No admin session or PIN is required.
- **APP-SETTINGS-REGISTRY-INV-03** `PUT /settings` requires a valid API key. The backend validates the submitted object name and schema before persisting anything.
- **APP-SETTINGS-REGISTRY-INV-04** A `PUT /settings` write is atomic per object. A storage failure leaves all fields of that object at their prior values.
- **APP-SETTINGS-REGISTRY-INV-05** Unknown object names are rejected. Schema-invalid field values are rejected.
- **APP-SETTINGS-REGISTRY-INV-06** The effective settings response always includes all fields for every included object, with defaults filling any missing persisted value.
- **APP-SETTINGS-REGISTRY-INV-07** An absent object in `GET /settings` means the owning plugin is not active. There are no null/empty placeholder objects for inactive plugins.
- **APP-SETTINGS-REGISTRY-INV-08** `daily_briefing_block_order` does not exist in this registry. Daily Briefing owns its own block configuration.

## Behaviors

**Read effective settings**
Any caller with a valid API key sends `GET /settings` and receives the complete effective settings map: all core objects plus all active plugin objects, with defaults filling missing rows.

**Write a settings object**
A caller sends `PUT /settings` with `{ "object": OBJECT_NAME, "settings": { ... } }`. The server validates the object name against the registry, validates the `settings` payload against that object's schema, and persists the entire object atomically. On success, the server returns the updated effective settings.

**Plugin object visibility**
When a plugin is activated, its settings objects appear in subsequent `GET /settings` responses seeded with defaults. When a plugin is deactivated, its objects are absent from the response. Clients detect plugin presence by checking for the object key, not by inspecting field values.

**Seed defaults on fresh setup**
On v2 fresh setup, the core `locale` object is seeded with defaults. Plugin objects are seeded when their plugin is activated, not at system startup.

## Interfaces

### `GET /settings`

Returns the effective settings map. Response shape is a plain object whose keys are active object names.

Example with core only (no plugins active):

```json
{
  "locale": { "timezone": "Europe/Madrid", "language": "es", "weekStartDay": 1 },
  "celebration": { "sound": true }
}
```

Example with Printing plugin active:

```json
{
  "locale": { "timezone": "Europe/Madrid", "language": "es", "weekStartDay": 1 },
  "celebration": { "sound": true },
  "printer": { "paperWidthDots": 576 },
  "printerTransport": {
    "deviceId": "",
    "name": "",
    "serviceUuid": "",
    "characteristicUuid": ""
  }
}
```

### `PUT /settings`

Accepts `{ "object": OBJECT_NAME, "settings": { ... } }`. Returns the updated effective settings map on success. Returns 400/422 on unknown object name or schema-invalid fields.

## Settings Object Registry

### Core objects

| Object        | Fields                                                                                | Validation                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `locale`      | `timezone` (IANA string), `language` (supported locale enum), `weekStartDay` (0 or 1) | `timezone` must be a valid IANA timezone name. `language` must be a member of the server-supported locale list (currently `en`, `es`). `weekStartDay` must be exactly 0 or 1. |
| `celebration` | `sound` (boolean, default `true`)                                                     | Exactly one boolean field; unknown keys are rejected. Turns the completion fanfare on or off for the whole household. Reduced motion never mutes it.                          |

### Plugin objects (examples; each plugin registers its own)

| Object             | Owner plugin | Fields                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `weather`          | Weather      | `lat` (number or null, **range `[-90,90]`**), `lon` (number or null, **range `[-180,180]`**), `label?` (optional place name or null). Set and cleared as a unit; range-validated (`ADR-052`). No env fallback.                                                                                                                                                                                                                         |
| `printer`          | Printing     | `paperWidthDots` (positive integer). (`enabled`/`autoprint` removed: "printing available" = plugin active per ADR-038; "automatic" = an active automatic trigger bound, not a flag.)                                                                                                                                                                                                                                                   |
| `printerTransport` | Printing     | Flat Bluetooth pairing fields: `deviceId`, `name`, `serviceUuid`, `characteristicUuid` (all strings). Empty strings = unpaired default; otherwise deviceId/name non-empty and both UUIDs must be well-formed 128-bit UUIDs (8-4-4-4-12 hex, any version nibble; stored lower-case). Unknown keys (including a nested `type`/`config` envelope) are rejected. Transport is Bluetooth-only in this system; wifi/usb are not schema arms. |

`printerTransport` does not encode a multi-transport discriminated union in the shipped API — Bluetooth is the only local transport, so the object is the Bluetooth config fields themselves.

## Events

(ADR-040.) **Emits: none. Subscribes: none.** App Settings is intentionally **not a bus
participant.** Settings changes propagate via the **settings read mechanism** — consumers
re-read `GET /settings` (cold-readable on the API-key surface) rather than receiving a
push. i18n, for example, **reacts to a `language` change via the settings mechanism, not
the bus** (see the i18n contract). Plugin object visibility changes are driven by the
Plugin System **activation registry**, not by an App Settings event. Documenting this
non-participation is deliberate (`ADR-040`: every contract states its Events surface).

## Data / Setup Contract

the product starts with a fresh data store. No legacy `app_settings` rows are migrated. The core `locale` object is seeded with defaults (`Europe/Madrid`, `en`, `1`) on fresh setup. Plugin objects are seeded when their plugin is activated.

The effective settings response always fills missing persisted values from object defaults, so the response is always complete for active objects even before any explicit write.

## Acceptance Criteria

- **APP-SETTINGS-REGISTRY-AC-01** Given a valid API key and no admin PIN, when a client requests `GET /settings`, the response includes the `locale` object with all three fields.
- **APP-SETTINGS-REGISTRY-AC-02** Given `PUT /settings` with `{ "object": "unknownThing", "settings": {} }`, the server returns a 400/422 error.
- **APP-SETTINGS-REGISTRY-AC-03** Given `PUT /settings` with `{ "object": "locale", "settings": { "timezone": "not/a/timezone", "language": "es", "weekStartDay": 1 } }`, the server returns a 400/422 error.
- **APP-SETTINGS-REGISTRY-AC-04** Given a storage failure after writing the first field of a `locale` write, all three `locale` fields remain at their prior values.
- **APP-SETTINGS-REGISTRY-AC-05** Given the Printing plugin is not active, `GET /settings` does not include `printer` or `printerTransport` keys.
- **APP-SETTINGS-REGISTRY-AC-06** Given the Printing plugin is active, `GET /settings` includes `printer` and `printerTransport` with defaults for any unpersisted fields.
- **APP-SETTINGS-REGISTRY-AC-07** Given `PUT /settings` with `{ "object": "printerTransport", "settings": { "type": "wifi", "config": {} } }` (nested/unknown-key shape), the server returns a schema-invalid error; the shipped object is flat Bluetooth pairing fields only.

## Open Decisions

- Plugin activation/deactivation lifecycle: what does activating a plugin look like for the household admin? (`ADR-029`)
- Supported locale list expansion: adding a new language requires updating the server-side enum and deploying locale resources. No API contract change needed.
