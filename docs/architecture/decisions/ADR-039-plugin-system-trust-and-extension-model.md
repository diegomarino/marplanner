# ADR-039 Plugin System Trust / Permission / Installation / Sandbox Model

Status: accepted
Owner: architecture / security
Decision date: 2026-06-28

## Decision

The v2 plugin system is **first-party only now, designed so third-party plugins
stay cheap to add later**. Governing principle: **declare-now, enforce-later** —
build the _declaration_ surface (manifest + a defined host API plugins talk
through) in this system; defer the _enforcement_ surface (sandbox, capability broker,
signature/install-source verification, resource isolation) until a third-party
ecosystem is an explicit goal. Make no decision that forecloses or heavily
complicates adding third-party plugins.

ADR-038's official/unofficial trust tier is **cosmetic for now**; its security
meaning attaches when the enforcement tier is built.

### 1. Trust tier

Single tier: all plugins are first-party, trusted, run with full host
privileges, **no sandbox**. Not built in this system: sandbox/process isolation,
capability broker, signature or install-source verification, resource quotas.

### 2. Plugin contract (the door-keeping seam)

**(a) Manifest.** Each plugin declares, in one place:

- _Contributions:_ settings objects + schemas (ADR-028 discriminated-union
  registration), runtime services typed by capability (ADR-035), nav entries,
  dashboard widgets (ADR-038), background jobs (ADR-029), and the **namespaced
  data tables it owns**.
- _Requirements:_ consumed API scopes in **ADR-030 vocabulary** (`domain:verb`
  r/w/admin), host/runtime version compatibility, identity (`id`, `version`,
  trust tier).

The manifest field list is **intentionally open/extensible** — inter-plugin
deps, i18n string bundles, and a plugin's own API endpoints are allowed entries
that apply to some plugins, not a closed schema.

**(b) Rule B — host-API-only access.** Plugins interact with the host **only
through an injected host API / defined extension points**. They never import
host internals, never share the host's raw DB handle, never mutate global host
state. This is the seam a future enforcement layer clamps onto without
rewriting plugins.

**(b′) Rule B enforcement mechanism — named now (peer-review refinement).**
Rule B is enforced in the first-party phase by a **build-time import-boundary
check**, designated now so "enforce-later" has a concrete attach point: e.g.
`eslint-plugin-import` `no-restricted-imports` forbidding plugin→core-internal
imports, or TypeScript `compilerOptions.paths` exposing only a barrel
`@core/host-api` package. This is the difference between Rule B being an
aspiration and being an actual seam; it costs a lint/tsconfig rule, not a
sandbox. (For future third-party plugins, Rule B is additionally enforced by the
deferred sandbox.)

### 3. Data ownership

Each plugin **owns a namespaced set of tables (id-prefixed) and ships its own
migrations**. Core never touches plugin tables; plugins never touch each other's.
Clean uninstall = drop the plugin's tables. A plugin may _reference_ core entity
IDs but reads/writes core data **through the host API, not raw cross-schema
joins** (preserves Rule B). Chosen over a shared blob table or undisciplined
shared schema: namespacing is free now, a data migration to retrofit later.

### 4. Activation lifecycle

- **Operations:** `activate` / `deactivate` only in this system. `install` / `uninstall`
  is kept as a **dormant concept** (the future dynamic-loader / third-party
  attach point) — no UI, no operation now. In-tree plugins register at
  build/boot time, shaped so a future dynamic loader is additive.
- **Source of truth:** an explicit **core-owned activation registry** (e.g.
  `active_plugins(plugin_id, activated_at, status)`). The ADR-029 rule "absent
  settings object in `GET /settings` = plugin inactive" is **demoted to a
  derived client hint**, not canonical — so a settings-less plugin can still be
  represented as active. (v2 is greenfield per ADR-026; clients may use presence
  as a hint only.)
- **Activate** writes the registry row, registers settings-object defaults
  (ADR-038), mounts runtime services (ADR-035), adds nav/widgets.
  **Deactivate** reverses all of it.
- **Deactivation drain semantics (peer-review refinement):** deactivation
  **stops new ADR-035 job claims** for the plugin; **in-flight claims run to
  completion within their lease window** (graceful drain, consistent with
  ADR-035's lease/TTL model). Deactivation does not interrupt mid-flight jobs.
- **Defaults:** all plugins **default inactive**; activation is always an
  explicit owner action (most plugins are useless/broken until configured). A
  first-run setup wizard is **deferred to post-MVP** (Kiosk/UX, not a PV2 data
  contract).

### 5. Catalog endpoint

A dedicated **`GET /plugins`** returns, per plugin: `id`, name, trust tier,
manifest contributions+requirements, settings **schema**, and `active`/`errored`
state — **never stored secret values**. Secret-bearing settings _values_ flow
only via `GET /settings` (active plugins only), under the settings/ADR-016
redaction policy. `GET /plugins` and the activate/deactivate mutations are
**full-access `*` key only** (ADR-030 admin tier, same as key management);
scoped integration keys get no plugin management. Principle: **catalog plane
(listable metadata) vs data plane (guarded configured values + secrets)**.

### 6. Inter-plugin relationships

**Declare-and-degrade, no hard enforcement.** Dependencies are declarative +
informational only (manifest hint + management-UI note); runtime treats peers as
optional/absent and degrades gracefully. No dependency resolver, no
activation-order locks, no "can't deactivate X while Y is on" blocks.
Cross-plugin data references go through the other plugin's **host-mediated,
absence-tolerant interface** — never cross-namespace FKs — so
deactivation/uninstall can never orphan another plugin's rows (no orphan-cleanup
machinery needed). Unifying principle: **plugins relate only through
host-mediated, absence-tolerant interfaces, never hard wiring.**

### 7. Fault isolation (two-tier, honest scope)

**In scope for this system — logic-fault containment (cheap):** per-plugin error
boundaries at service mount, migration, job execution, and UI widget. A throwing
plugin is marked **`errored`** and quiesced while the host and sibling plugins
survive. `errored` is a first-class state in the activation registry /
`GET /plugins`, feeding the Kiosk Shell global health indicator. A failed
migration rolls back only that plugin's namespace (§3). **Re-activation from
`errored` re-runs all pending migrations before marking the plugin `active`**
(peer-review refinement — prevents partial-schema boot).

**Out of scope for this system — resource-fault containment (documented limitation, NOT
silently omitted):** a plugin can still spike RAM/CPU and crash the whole
process; error boundaries cannot catch an OOM. (Real v1 incident: daily-briefing
generation RAM spike → host OOM-reset, mitigated operationally by raising the
machine 256→512MB.) v2 has **no per-plugin quotas, process isolation, or
watchdog**. Mitigation is **operational** — provision adequately; rely on the
technically-competent operator/author to diagnose via the health indicator +
logs. Resource isolation is the natural home of the deferred enforcement tier
and graduates to "the sandbox's job" when third-party becomes real. Authoring
guideline (not enforced): be memory-conscious in heavy server-side generation
(ADR-035 global services).

## Rationale

For a self-hosted family kiosk run by one technically-competent owner, the
plugin author and the operator are the same person — a sandbox defends a
privilege boundary that does not yet exist. The expensive half of a plugin
system is enforcement; the cheap half is declaration. Building only the
declaration surface now, plus naming the Rule B enforcement tool, preserves a
clean third-party seam at near-zero cost. Namespaced data ownership and the
catalog/data-plane split are wins even if third-party never happens (clean
uninstall, no secret-aggregation endpoint). Fault isolation is scoped honestly:
logic faults are contained cheaply; resource faults are an accepted operational
limitation rather than a silently-implied guarantee.

## Affected Specs

- `docs/rewrite-spec/15-kiosk-shell-navigation.md` — `admin/plugins`, health
  indicator surfaces `errored` plugins
- `docs/rewrite-spec/03-app-settings-registry.md` — plugin settings objects,
  catalog vs data plane
- `docs/rewrite-spec/16-background-jobs-scheduler.md` — deactivation drain
  semantics over ADR-035 claims

## Data / Setup Implications

Fresh setup: a core-owned `active_plugins` registry table; each plugin ships
id-prefixed tables + migrations. No legacy import (ADR-026). All plugins seed
inactive; the owner activates and configures each. No registry, signing keys, or
loader infrastructure provisioned.

## Acceptance Criteria

- Given a plugin source file, when it imports a core internal module directly,
  then the build/lint import-boundary check fails (Rule B enforced).
- Given an inactive plugin, then `GET /settings` omits its objects and
  `GET /plugins` lists it as inactive with its schema but no secret values.
- Given a plugin is deactivated with an in-flight claimed job, then no new claims
  are issued and the in-flight job completes within its lease (graceful drain).
- Given a plugin whose migration threw (`errored`), when it is re-activated, then
  all pending migrations re-run before it is marked `active`.
- Given a throwing plugin service/widget, then that plugin is `errored` and
  quiesced while the host and other plugins keep running.
- Given a plugin is uninstalled, then dropping its namespaced tables orphans no
  other plugin's rows (no cross-namespace FKs).
- Given a request to `GET /plugins` or an activate/deactivate mutation with a
  scoped (non-`*`) key, then it is denied.

## Open Questions

- Exact import-boundary tooling choice (lint rule vs TS paths) — implementation
  detail; the requirement that one exists is fixed here.
- Secret storage/redaction for settings values — owned by Settings / ADR-016.
- Third-party enforcement tier (sandbox, broker, signing, quotas, dynamic
  loader) — deliberately deferred; this decision only guarantees the seam.

## Traceability

- Related prior: `ADR-029` (core/plugin split), surfaced by `ADR-038` (management
  surface)
- Related: `ADR-028` (settings objects), `ADR-030` (scoped keys / `*` admin
  tier), `ADR-035` (runtime services, job claims), `ADR-016` (secret/telemetry
  redaction), `ADR-014` (background jobs)
- Domain grill: `../domain-grills/plugin-system.md`
- Peer review: codex-peer-review blind-debate (2026-06-28) — no critical/important
  security findings; three cheap spec refinements incorporated (Rule B
  enforcement mechanism named, re-activation re-runs migrations, deactivation
  drain semantics). Codex blind pass misfired (no codebase to anchor on);
  defender-debate lens applied.
