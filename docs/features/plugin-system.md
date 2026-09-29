# Feature: Plugin System (the host↔plugin trust boundary)

Behavior reference. The [owning contract](../architecture/contracts/plugin-system.md) defines invariants and extension limits.

The Plugin System defines how optional features extend the core: the host API a plugin may use, the
id-namespaced data + lifecycle it owns, and the trust/isolation boundary around it. v2 is
**first-party only** with a deliberately preserved seam for future third-party plugins
("declare-now, enforce-later"). The activation registry is the single source of truth for active
state; a plugin reaches the host only through the injected host API (Rule B), owns only its
namespaced tables, and is contained on fault without taking down the host or its siblings.

## User workflows

### User Story 1 — Activate a plugin and configure it

An owner (holding a `*` key) activates an inactive plugin; the lifecycle writes the registry row,
registers settings defaults, runs migrations, mounts runtime services, and adds nav/widgets — and only
then do the plugin's settings objects appear in `GET /settings`.

### User Story 2 — A faulty plugin is contained

A plugin throws during service mount or a job; it is marked `errored` and quiesced while the host and
every sibling plugin keep running, and the fault surfaces in the Kiosk Shell health indicator.

### User Story 3 — Deactivate without losing in-flight work

An owner deactivates a plugin with a claimed hardware job; no new claims are taken, the current job
drains within its lease, services unmount, and the plugin's settings disappear from `GET /settings`.

### Edge Cases

- A plugin importing a core internal fails the build-time import-boundary check (Rule B).
- `GET /plugins` lists an inactive plugin with its schema but never any secret value.
- A plugin reads an operator secret only via `host.getOperatorConfig`; a `process.env` read inside a
  plugin namespace is a lint/build error.
- Uninstalling a plugin drops only its namespaced tables and orphans no other plugin's rows.
- A missing peer plugin is treated as absent — the dependent degrades gracefully, never hard-fails.

## Requirements

### Functional Requirements

- **FR-001**: Given a plugin, when it reaches the host, then it MUST do so only through the injected host API / extension points, and it MUST NOT import host internals, the raw DB handle, or global state (Rule B, enforced by a build-time import-boundary check). Contract: PLUGIN-SYSTEM-INV-01.

- **FR-002**: Given a plugin's data, when its tables are accessed, then the plugin MUST own an id-namespaced set of tables that core and other plugins MUST NOT read or write, and there MUST be no cross-namespace foreign keys. Contract: PLUGIN-SYSTEM-INV-02.

- **FR-003**: Given plugin active state, when it is determined, then the activation registry MUST be the source of truth, and settings presence in `GET /settings` MUST be treated as a derived hint only. Contract: PLUGIN-SYSTEM-INV-03.

- **FR-004**: Given `GET /plugins`, when it responds, then it MUST NOT return stored secret values, and secret values MUST travel only via `GET /settings` for active plugins. Contract: PLUGIN-SYSTEM-INV-04.

- **FR-005**: Given plugin management (`GET /plugins`, activate, deactivate), when it is authorized, then it MUST require a full-access `*` key. Contract: PLUGIN-SYSTEM-INV-05.

- **FR-006**: Given an inactive plugin, when the system serves its surfaces, then it MUST contribute nothing — no settings objects, no runtime services, no nav, and no widgets. Contract: PLUGIN-SYSTEM-INV-06.

- **FR-007**: Given two plugins, when they relate, then they MUST relate only through host-mediated, absence-tolerant interfaces and MUST NOT be hard-wired — no dependency resolver, no activation-order locks, and no cross-namespace references. Contract: PLUGIN-SYSTEM-INV-07.

- **FR-008**: Given a throwing plugin, when it faults, then it MUST be contained (marked `errored`) without bringing down the host or sibling plugins; resource exhaustion (OOM/CPU) is explicitly not contained in v2. Contract: PLUGIN-SYSTEM-INV-08.

- **FR-009**: Given operator/deploy secrets, when a plugin reads them, then it MUST read them only via the read-only host operator-config interface (`host.getOperatorConfig('<ns>.<key>')`), it MUST NOT read `process.env` directly or write the host environment (a lint rule bans `process.env` reads inside any plugin namespace), and operator secrets MUST never enter a plugin's namespaced tables, `GET /settings`, backups, or telemetry. Contract: PLUGIN-SYSTEM-INV-09.

- **FR-010**: Given a plugin importing a core internal, when the import-boundary check runs, then the build MUST fail (the acceptance surface for Rule B in FR-001/INV-01). Contract: PLUGIN-SYSTEM-AC-01.

- **FR-011**: Given an inactive plugin, when the surfaces respond, then it MUST be absent from `GET /settings` and listed as inactive in `GET /plugins` with its schema and no secret values. Contract: PLUGIN-SYSTEM-AC-02.

- **FR-012**: Given a plugin with an in-flight claimed job, when it is deactivated, then new claims MUST NOT be taken and the current job MUST complete within its lease (drain). Contract: PLUGIN-SYSTEM-AC-03.

- **FR-013**: Given an `errored` plugin, when it is re-activated, then all pending migrations MUST re-run before it is marked `active`. Contract: PLUGIN-SYSTEM-AC-04.

- **FR-014**: Given a throwing plugin service or widget, when it faults, then the host and sibling plugins MUST keep running (the acceptance surface for containment in FR-008/INV-08). Contract: PLUGIN-SYSTEM-AC-05.

- **FR-015**: Given a plugin uninstall, when its namespaced tables are dropped, then it MUST orphan no other plugin's rows. Contract: PLUGIN-SYSTEM-AC-06.

- **FR-016**: Given a plugin-management call presented with a non-`*` key, when it is authorized, then it MUST be denied (the acceptance surface for FR-005/INV-05). Contract: PLUGIN-SYSTEM-AC-07.

### Key Entities

- **Manifest**: a plugin's build/boot declaration of contributions + requirements — settings schema,
  nav/widgets, runtime services, and (ADR-050) the namespaced events it emits/subscribes; emitting or
  subscribing an undeclared name, or under another namespace, is a build error.
- **Activation registry (`active_plugins`)**: the core-owned source of truth for which plugins are
  `active` / `inactive` / `errored`; queried directly, never learned from an event.
- **Host API / extension points**: the only surface a plugin uses to reach the host (Rule B), including
  the read-only operator-config accessor `host.getOperatorConfig` — never a writer.
- **Namespaced tables**: a plugin's id-prefixed tables + its own migrations; clean uninstall drops them
  and nothing else.

## Success Criteria

- **SC-001**: 100% of plugins importing a host internal / raw DB handle / `process.env` fail the
  build-time boundary or lint gate.
- **SC-002**: A faulting plugin produces 0 host or sibling crashes (contained as `errored`), and
  deactivating a plugin drains its claimed job with 0 new claims taken.
- **SC-003**: `GET /plugins` returns 0 secret values; an inactive plugin contributes 0 settings
  objects, services, nav, or widgets; uninstall orphans 0 other plugin rows.

## Assumptions

- Auth & Sessions owns the `*`-key gate that plugin management requires (ADR-030); App Settings owns the
  `GET /settings` data plane (ADR-028); the scheduler owns the ADR-035 job-claim lease that deactivate
  drains. This spec owns the plugin↔host boundary, the registry, and the lifecycle sequence.
- v2 is first-party only; no registry/signing/loader/sandbox/quota infrastructure (declare-now,
  enforce-later); resource-exhaustion isolation is explicitly deferred.
- Fresh v2 store; all plugins seed `inactive`; no legacy plugin state imported (ADR-026).
