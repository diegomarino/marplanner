# Plugin System Domain Contract

Status: maintained contract
Depends on decisions: `ADR-029`, `ADR-038`, `ADR-039`, `ADR-028`, `ADR-030`, `ADR-035`, `ADR-040`, `ADR-050`, `ADR-053`

## Purpose

Defines how optional features ("plugins") extend the core system: their contract
with the host, how their data and lifecycle are managed, and the trust/isolation
boundary. v2 is **first-party only** with a deliberately preserved seam for
future third-party plugins ("declare-now, enforce-later").

## Vocabulary

- **Core** — features always present (`ADR-029`).
- **Plugin** — optional feature the household activates.
- **Manifest** — a plugin's declaration of contributions + requirements.
- **Host API / extension points** — the only surface a plugin uses to reach the
  host (Rule B).
- **Activation registry** — core-owned source of truth for which plugins are
  active.
- **Catalog plane** — listable plugin metadata (`GET /plugins`).
- **Data plane** — configured settings values incl. secrets (`GET /settings`).
- **Trust tier** — official vs unofficial; cosmetic in this system.
- States: `active`, `inactive`, `errored`.

## Invariants

1. **PLUGIN-SYSTEM-INV-01** A plugin reaches the host **only** through the injected host API / extension
   points — never imports host internals, the raw DB handle, or global state
   (Rule B), enforced by a build-time import-boundary check.
2. **PLUGIN-SYSTEM-INV-02** A plugin owns an **id-namespaced** set of tables; core and other plugins
   never read/write them. No cross-namespace foreign keys.
3. **PLUGIN-SYSTEM-INV-03** The **activation registry is the source of truth** for active state; settings
   presence in `GET /settings` is a derived hint only.
4. **PLUGIN-SYSTEM-INV-04** `GET /plugins` never returns stored secret values; secrets travel only via
   `GET /settings` for active plugins.
5. **PLUGIN-SYSTEM-INV-05** Plugin management (`GET /plugins`, activate, deactivate) requires a
   full-access `*` key (`ADR-030`).
6. **PLUGIN-SYSTEM-INV-06** An inactive plugin contributes nothing: no settings objects, runtime
   services, nav, or widgets (`ADR-038`/`ADR-035`).
7. **PLUGIN-SYSTEM-INV-07** Plugins relate to each other only through host-mediated, absence-tolerant
   interfaces — never hard wiring (no dependency resolver, no activation-order
   locks, no cross-namespace references).
8. **PLUGIN-SYSTEM-INV-08** A throwing plugin is contained (`errored`) without bringing down the host or
   sibling plugins. Resource exhaustion (OOM/CPU) is **not** contained in this system.
9. **PLUGIN-SYSTEM-INV-09** A plugin reads **operator/deploy secrets only via the read-only host
   operator-config interface** (`host.getOperatorConfig('<ns>.<key>')` → reserved
   env keys); it never reads `process.env` directly or writes the host
   environment. A lint rule **bans `process.env` reads inside any plugin
   namespace** (same convention→build-gate as Rule B). Operator secrets never
   enter a plugin's namespaced tables, `GET /settings`, backups, or telemetry
   (`ADR-053`).

## Behaviors

- **Activate:** write registry row → register settings defaults → run migrations
  → mount runtime services → add nav/widgets.
- **Deactivate:** stop new ADR-035 job claims (in-flight claims drain within
  lease) → unmount services → remove nav/widgets → settings objects disappear
  from `GET /settings`. Registry row reflects inactive.
- **Re-activate from `errored`:** re-run all pending migrations before marking
  `active`.
- **Logic fault** in service mount / migration / job / widget → plugin marked
  `errored`, quiesced; host + siblings continue; surfaced in the Kiosk Shell
  health indicator.
- **Missing peer plugin** → dependent plugin degrades gracefully (treats peer as
  absent).
- **Defaults:** all plugins start inactive; activation is an explicit owner
  action.

## Interfaces

- `GET /plugins` (`*` key) — catalog: id, name, trust tier, manifest, settings
  schema, state. No secret values.
- `POST`/mutation activate & deactivate (`*` key).
- `GET /settings` / `PUT /settings` (`ADR-028`) — data plane for active plugins.
- Manifest (build/boot registration) — contributions + requirements.
- Injected host API / extension points — the plugin↔host boundary. Includes a
  **read-only operator-config accessor** (`host.getOperatorConfig`) for
  operator/deploy secrets (`ADR-053`); never a writer.

## Events

(ADR-040 / ADR-050.) **The Plugin System domain** itself **emits: none, subscribes: none**
(for this system) — but it **owns the manifest where each plugin declares the events it emits and
subscribes to** (`ADR-050`): namespaced by plugin ID, build-validated, dropped on
uninstall; emitting/subscribing an undeclared name (or under another namespace) is a build
error. So plugins _may_ participate in the bus via declared events; the lifecycle of the
Plugin System domain does not.

Activation/deactivation is a
**directly orchestrated sequence** performed by the lifecycle behavior (registry write →
settings defaults → migrations → mount services → nav/widgets, and the reverse on
deactivate incl. draining `ADR-035` job claims) — **not** a fire-and-forget bus broadcast.
The **activation registry is the source of truth**, queried directly (invariant 3), so
no domain learns "plugin activated/deactivated" from an event. Inter-plugin coupling is
**absence-tolerant via host-mediated interfaces** (invariant 7), not event subscriptions.
A future third-party tier _may_ introduce plugin-lifecycle events, but v2 deliberately
uses orchestration + registry + absence-tolerance instead (declare-now, enforce-later).

## Data / Setup Contract

Fresh deployment: a core-owned `active_plugins` registry; each plugin ships id-prefixed
tables + its own migrations. All plugins seed **inactive**; the owner activates
and configures each. No legacy import (`ADR-026`). No registry/signing/loader
infrastructure in this system. Clean uninstall = drop the plugin's namespaced tables.

## Acceptance Criteria

- **PLUGIN-SYSTEM-AC-01** A plugin importing a core internal fails the import-boundary check.
- **PLUGIN-SYSTEM-AC-02** An inactive plugin is absent from `GET /settings` and listed inactive (with
  schema, no secrets) in `GET /plugins`.
- **PLUGIN-SYSTEM-AC-03** Deactivating a plugin with an in-flight claimed job drains it (no new claims;
  current job completes within lease).
- **PLUGIN-SYSTEM-AC-04** Re-activating an `errored` plugin re-runs pending migrations before `active`.
- **PLUGIN-SYSTEM-AC-05** A throwing plugin service/widget leaves the host and siblings running.
- **PLUGIN-SYSTEM-AC-06** Uninstalling a plugin orphans no other plugin's rows.
- **PLUGIN-SYSTEM-AC-07** Plugin-management calls with a non-`*` key are denied.

## Open Decisions

- Import-boundary tooling choice — implementation detail (requirement fixed in
  `ADR-039`).
- Settings secret storage/redaction — Settings / `ADR-016`.
- Third-party enforcement tier (sandbox, broker, signing, quotas, dynamic
  loader) — deferred; `ADR-039` guarantees only the seam.
