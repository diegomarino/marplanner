# Feature: App Settings Registry (household-wide runtime settings)

Behavior reference. The [owning contract](../architecture/contracts/app-settings-registry.md) defines invariants and extension limits.

App Settings Registry owns the household-wide runtime settings that the kiosk and
server need to behave correctly. It exposes one predictable pair of endpoints —
`GET /settings` to read effective settings and `PUT /settings` to write a named
settings object — available at cold boot behind the API-key boundary alone. It
owns only the stored configuration values and their write contract: it does not
own authentication logic, printer strategies, weather fetches, or any
domain-specific behavior, and it is intentionally not a bus participant.

## Behavior

### User Story 1 — Read effective settings at cold boot

A kiosk boots fresh with no admin session and no PIN. With a valid API key alone
it sends `GET /settings` and receives the complete effective settings map: every
core object (e.g. `locale`) with all fields filled from defaults, plus the objects
of every active plugin. PIN state is never consulted.

### User Story 2 — Write a validated settings object atomically

A caller with a valid API key sends `PUT /settings` with an object name and a
settings payload. The server validates the object name against the registry and
the payload against that object's schema before persisting; on success it persists
the whole object atomically and returns the updated effective settings. An unknown
object name or a schema-invalid field is rejected with a 400/422 and nothing is
written.

### User Story 3 — See plugin objects appear and disappear by activation

When the Printing plugin is active, `GET /settings` includes `printer` and
`printerTransport` (seeded with defaults for unpersisted fields); when it is not
active, those keys are simply absent — there is no null/empty placeholder. Clients
detect plugin presence by checking for the object key, not by inspecting field
values.

### Edge Cases

- An unknown `object` name on `PUT /settings` is rejected (400/422); no row changes.
- A schema-invalid field (e.g. a non-IANA `timezone`) is rejected; the object keeps
  its prior values.
- A storage failure mid-write leaves every field of that object at its prior value
  (no partial object).
- An unsupported transport type (`wifi`/`usb`) on `printerTransport` is rejected
  until that transport is implemented.
- `daily_briefing_block_order` is not a settings object here — Daily Briefing owns
  its own block configuration.

## Requirements

### Behavior requirements

- **FR-001**: Given any settings endpoint, when a request is authorized, then the API key MUST be the sole backend authorization boundary and PIN state MUST NOT be evaluated by any settings endpoint. _(Realizes: APP-SETTINGS-REGISTRY-INV-01)_

- **FR-002**: Given a fresh-booted deployment with no admin session and no PIN, when a caller with a valid API key requests `GET /settings`, then the endpoint MUST be available and MUST NOT require an admin session or PIN. _(Realizes: APP-SETTINGS-REGISTRY-INV-02)_

- **FR-003**: Given a `PUT /settings` request, when it is processed, then it MUST require a valid API key and the backend MUST validate the submitted object name and schema before persisting anything. _(Realizes: APP-SETTINGS-REGISTRY-INV-03)_

- **FR-004**: Given a `PUT /settings` write to one object, when a storage failure occurs, then the write MUST be atomic per object such that all fields of that object remain at their prior values. _(Realizes: APP-SETTINGS-REGISTRY-INV-04)_

- **FR-005**: Given a `PUT /settings` payload, when its object name is unknown or any field value is schema-invalid, then the write MUST be rejected. _(Realizes: APP-SETTINGS-REGISTRY-INV-05)_

- **FR-006**: Given the effective settings response, when it is assembled for any included object, then it MUST include all of that object's fields, with defaults filling any missing persisted value. _(Realizes: APP-SETTINGS-REGISTRY-INV-06)_

- **FR-007**: Given `GET /settings`, when a plugin is not active, then its settings object MUST be absent from the response and the response MUST NOT contain any null/empty placeholder object for an inactive plugin. _(Realizes: APP-SETTINGS-REGISTRY-INV-07)_

- **FR-008**: Given this registry, when settings objects are enumerated, then `daily_briefing_block_order` MUST NOT exist in this registry because Daily Briefing owns its own block configuration. _(Realizes: APP-SETTINGS-REGISTRY-INV-08)_

- **FR-009**: Given a valid API key and no admin PIN, when a client requests `GET /settings`, then the response MUST include the `locale` object with all three fields (the cold-readable acceptance surface for the cold-boot availability invariant in FR-002/INV-02). _(Realizes: APP-SETTINGS-REGISTRY-AC-01)_

- **FR-010**: Given `PUT /settings` with `{ "object": "unknownThing", "settings": {} }`, when it is processed, then the server MUST return a 400/422 error (the acceptance surface for the unknown-object rejection in FR-005/INV-05). _(Realizes: APP-SETTINGS-REGISTRY-AC-02)_

- **FR-011**: Given `PUT /settings` for `locale` with `timezone` set to `not/a/timezone` (and otherwise valid fields), when it is validated, then the server MUST return a 400/422 error (the acceptance surface for schema-invalid field rejection in FR-005/INV-05). _(Realizes: APP-SETTINGS-REGISTRY-AC-03)_

- **FR-012**: Given a storage failure after the first field of a `locale` write, when the write fails, then all three `locale` fields MUST remain at their prior values (the acceptance surface for the per-object atomicity invariant in FR-004/INV-04). _(Realizes: APP-SETTINGS-REGISTRY-AC-04)_

- **FR-013**: Given the Printing plugin is not active, when a client requests `GET /settings`, then the response MUST NOT include the `printer` or `printerTransport` keys (the acceptance surface for the absent-object invariant in FR-007/INV-07). _(Realizes: APP-SETTINGS-REGISTRY-AC-05)_

- **FR-014**: Given the Printing plugin is active, when a client requests `GET /settings`, then the response MUST include `printer` and `printerTransport` with defaults for any unpersisted fields (the acceptance surface for the default-filling invariant in FR-006/INV-06 and the plugin-visibility invariant in FR-007/INV-07). _(Realizes: APP-SETTINGS-REGISTRY-AC-06)_

- **FR-015**: Given `PUT /settings` for `printerTransport` with `{ "type": "wifi", "config": {} }`, when it is validated, then the server MUST return an unsupported-transport error because `wifi` is not implemented in this system (only `bluetooth` is a valid `type`). _(Realizes: APP-SETTINGS-REGISTRY-AC-07)_

### Key Entities

- **Settings object**: a named, schematically validated group of related settings
  fields, identified by `object_name`. Persisted and written as a unit; the unit of
  atomicity for `PUT /settings`.
- **Core object**: a settings object always present regardless of which plugins are
  active (currently `locale`: `timezone`, `language`, `weekStartDay`).
- **Plugin object**: a settings object present in `GET /settings` only when its
  owning plugin is active (e.g. `weather`, `printer`, `printerTransport`), seeded
  with defaults on activation.
- **Effective settings map**: the complete `GET /settings` response — all core
  objects with all fields (defaults filling missing values) plus the objects of all
  active plugins; keys are the active object names.

## Success Criteria

- **SC-001**: 100% of `GET /settings` calls with a valid API key succeed at cold
  boot with no admin session and no PIN, and 0 settings-endpoint authorization
  outcomes depend on PIN state.
- **SC-002**: 100% of `PUT /settings` calls with an unknown object name or a
  schema-invalid field are rejected (400/422) and change 0 persisted fields.
- **SC-003**: For every included object, `GET /settings` returns all of its fields
  (defaults filling any unpersisted value), and inactive-plugin objects appear in 0
  responses (no placeholders).

## Assumptions

- Fresh data store; no legacy `app_settings` rows are migrated (ADR-026). On
  fresh setup the core `locale` object is seeded with defaults (`Europe/Madrid`,
  `es`, `1`); plugin objects are seeded when their plugin is activated, not at
  startup.
- Plugin object visibility is driven by the Plugin System activation registry
  (ADR-029), not by an App Settings event; App Settings emits and subscribes to no
  bus events (ADR-040). Consumers re-read `GET /settings` to observe changes (e.g.
  i18n reacts to a `language` change via the settings mechanism, not the bus).
- The API key authorization model and PIN client-side-only semantics are owned by
  Auth & Sessions; this spec only requires that settings endpoints honor the API-key
  boundary and never evaluate PIN.
- Per-plugin object schemas (e.g. `weather` range-validation per ADR-052) are
  registered by each owning plugin; this registry validates against the registered
  schema for the named object.
