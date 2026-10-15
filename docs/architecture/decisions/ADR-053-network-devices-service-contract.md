# ADR-053 Network Devices Service Contract (ownership separation, external-mirror state, data minimization)

Status: accepted
Owner: product + architecture
Decision date: 2026-06-29

> Note (2026-10-15, owner decision): the device-key exclusion in section 6 is **superseded**.
> Network Devices reads and writes now accept a provisioned device `*` cookie like every other
> household-tier admin endpoint, aligned with the single household trust tier of `ADR-058`. The
> routes keep the `network:admin` capability check; the Admin PIN stays a UI-only gate (FR-002).

## Decision

Network Devices is a **plugin** that maintains a **curated list of household devices the
admin chooses to track** — a friendly name + optional member assignment over devices the
network controller already sees. UniFi (Cloud API) owns live connectivity and block
enforcement; Marplanner owns the list and the family-facing intent. A controller outage
must never corrupt the list.

**Threat-model reframe:** this is the **UniFi Cloud API** (`api.ui.com`), not LAN scanning —
**no host-scanning / no SSRF surface**. The real surface is (1) an operator secret, (2)
PII-grade topology data, (3) a destructive action (cut internet).

### 1. Credentials = operator-owned, consumed via a read-only plugin host-API (refines ADR-039)

UniFi credentials (API key + console ID + site ID) stay **operator/deploy-config (env)**,
**not** an App Settings object and **not** a v2 admin setup screen. A DB-stored secret would
leak into the API-key-readable `GET /settings` surface (`ADR-007`), backups (`ADR-017`), and
diagnostics. Mirrors `ADR-016` (external sinks = operator config, not household setting); spec
§3 already forbids storing credentials as device rows.

**Plugin operator-config seam (extends `ADR-039` host API):** a plugin MUST NOT read `.env`
directly or write the host environment. The host exposes a **namespaced, read-only
operator-config interface** (e.g. `host.getOperatorConfig('unifi.apiKey')` resolving a
reserved env key like `MARPLANNER_UNIFI_API_KEY`). The plugin consumes; it never persists the
secret in its namespace, backups, or telemetry. Keeps Rule B intact (no direct env/FS access).
"Declare-now, enforce-later": v2 = first-party known keys. **Enforcement mechanism (named, not
convention-only):** a **lint rule bans `process.env` reads inside any plugin namespace**
(same convention→build-gate pattern as the Rule-B import-boundary lint in `ADR-039` and the
i18n `dynamicKeyRegistry`) so the "no direct env" promise is auditable rather than a
gentleman's agreement (peer-review Important).

### 2. `isBlocked` = external-mirror cache, reconciled idempotently (ADR-043)

`isBlocked` is Marplanner's **belief** mirroring controller state, not primary truth. No
atomic txn across the network boundary.

- **Op order:** intent → external UniFi call (authoritative result) → local cache write. A
  failed local write after a UniFi OK is **stale cache, not corruption**.
- **Reconciliation = idempotent background job** on the existing poller (`ADR-014`,
  run-on-startup + interval), **never a read side-effect.** The poller pulls controller
  blocked-state and corrects divergent rows. The device-list GET becomes a **pure read**
  (kills v1's state-mutating read + fire-and-forget `lastSeenAt`-on-read).
- **Divergence is visible, never a silent lie** (Reminders-dry-run pattern, `ADR-049`):
  when belief can't be confirmed (UniFi unreachable / last local write failed), surface
  "belief vs controller" rather than asserting a possibly-false state.
- **Reconciliation requires a poll-readable authoritative blocked-state source** (peer-review
  Important — convergence constraint, NOT a free implementation choice): the chosen block
  mechanism MUST keep the device's blocked-state observable by the poller. Legacy `block-sta`
  (MAC stays visible in client pages with a `blocked` flag) satisfies this; an `acl_rule_id`
  approach that makes the MAC _disappear_ from live-client pages would leave belief
  un-confirmable forever (no row to reconcile) and is only acceptable if paired with a
  dedicated blocked-devices endpoint the poller reads. This is a prerequisite for the
  self-healing guarantee, not a deferred detail.
- **Idempotency guard caveat (Minor):** the "already-blocked"/"not-blocked" guard reads the
  belief-mirror `isBlocked`, which can be stale in the divergence window — it may refuse a
  correct opposite action or allow a redundant UniFi call. This is **inherent to the
  external-mirror model and accepted**; implementers must NOT add a "smarter" cross-boundary
  guard that breaks idempotency. The next poll corrects; the admin can retry.

### 3. Registration = picker-only; `lastSeenAt` cannot lie by construction

**No manual MAC entry.** Registration requires UniFi configured + a fresh live-client cache

- selecting a client the controller currently reports. **The server validates the submitted
  MAC exists in the current fresh cache** (no longer trusts the client — closes the §11 "server
  boundary looser than UI" quirk). Because the only path is selecting a currently-observed
  client, the false-`lastSeenAt` problem is **eliminated structurally**; `lastSeenAt` is
  stamped legitimately from that observation. Server dedupes canonical MAC always + rejects
  duplicate-MAC races; MAC-less clients are unregisterable.

**Cache-rotation race (peer-review Important, accepted UX edge):** the server validates
against the _current_ fresh cache, not the cache epoch the picker rendered from. With a ~30s
poll, a device shown at T=0 and submitted at T=30+ (slow alias entry, device slept/rejoined)
can be rejected as "not in cache" despite a valid observation. Calibrated resolution for a
family kiosk: **surface a friendly retry error** ("this device is no longer online — go back
and reselect"), not a generic failure. A short grace window (accept a MAC seen in any cache
snapshot within the last few minutes) is an optional softening; not required for this system.

### 4. Ownership separation — three orthogonal operations

The registration is a label/assignment list, not a heavyweight entity. Each operation
touches only its owner's system:

- **add / delete / rename / assign** → local list only, **never calls UniFi**, no guard.
- **block / unblock** → UniFi enforcement (the ONLY operation crossing the boundary).
- **isOnline / lastSeenAt / isBlocked** → derived mirror of the controller.

**Delete is always allowed, local-only.** v1's hidden unblock-on-delete side-effect is
removed. Stranding (delete a blocked device → block lingers in UniFi) is **accepted** as the
admin's responsibility (pure ownership separation over a safety guard). This also **dissolves
the open "replace-MAC workflow" (YAGNI):** a changed/randomized MAC just stops matching
(`notDetected`); delete the stale entry, re-add from the picker.

### 5. Data minimization > redaction (security)

Ask "do I need it?" before "how do I protect it?":

- **IP addresses: dropped at the poller normalization boundary** — never ingested, stored,
  or shown. Unused (matching + block/unblock are MAC-keyed). Eliminates the most sensitive
  field; moots its redaction entirely.
- **MAC: irreducible internal plumbing** (dedupe/join key + block-sta target). In DB/backup
  as the key, **not painted in normal UI** (alias is the display), **redacted in
  telemetry/diagnostics** (`ADR-016` deny-list adds MAC pattern alongside `mpk-`/`mpg-`).
- **Alias: normal display data**, not PII. **Connection type:** keep only if it earns UI
  value; else drop.
- Real identifiers live in the backup `.db` (faithful restore); only **human-facing
  diagnostic artifacts** are sanitized (same line as `ADR-017`).

### 6. Permissions & audit (calibrated, no new tiers)

- **~~No new capability tier — but device `*` kiosk keys are excluded~~ (superseded
  2026-10-15, see the note at the top; kept for history).** All Network Devices reads + writes required **management/admin scope** under the
  _existing_ ADR-030/031 distinction (the integration/admin key class), which
  device-provisioned `*` kiosk keys do **not** carry. This is not a new capability — it
  reuses the existing device-vs-management split. **Route placement alone is insufficient**
  (spec §5): the API capability layer, not just the web admin layout, must enforce this,
  because a `*` device key would otherwise pass ordinary capability middleware and reach the
  destructive block/unblock action (peer-review Critical). Reads are treated as sensitive
  (topology), same gate as writes. _Seam:_ a finer-grained `network:admin` capability can be
  introduced later, but is not required for this system correctness.
- **Audit = ordinary logging** (`ADR-016`): block/unblock emit normal log/telemetry (action +
  timestamp + source key). **No "who" attribution** — there is no server-side user identity
  (`ADR-013` PIN is a client gate; an API key = device/scope, not a person); a `blockedBy`
  field could only lie.

### 7. Member assignment — strict on writes, tolerant on reads (ADR-002)

New assignment requires an **active member of any role** (not child-only; assignment optional,
`null` = unassigned, still blockable). A pre-existing link to a now-inactive member is
**tolerated and shown as "inactive member"** on read (fixes v1's silent empty label); editing
the alias does not force reassignment, but **any new `memberId` write validates active**.

## Rationale

The domain's complexity collapses once registration is seen as "a friendly-named list of
devices I want to control." That makes ownership separation obvious (local list vs controller
enforcement vs derived mirror), which in turn fixes v1's worst defects: the hidden
unblock-on-delete coupling, the state-mutating list read, false `lastSeenAt` evidence, and the
silent partial-state after a failed local write. Security work is concentrated where the
surface actually is — minimizing collected identifiers (drop IPs, keep MAC as plumbing) and
keeping the operator secret out of every storage surface — rather than on URL/host hardening
that doesn't apply to a fixed cloud endpoint. Everything is calibrated to the single-instance
family-kiosk threat model: no capability tiers, no audit subsystem, no replace-MAC machinery.

## Affected Specs

- `../../10-network-devices.md`
- `../../03-app-settings-registry.md` (confirms: no UniFi credentials object — operator env)
- `../domain-contracts/plugin-system.md` (host-API gains read-only operator-config interface)
- `../domain-contracts/client-logging-telemetry.md` (deny-list adds MAC + IP patterns)

## Data / Setup Implications

Owned table `network_devices` (plugin namespace per `ADR-039`): `id`, `mac` (canonical key,
unique), `alias`, `memberId?`, `unifiClientId?`, `isBlocked`, `lastSeenAt?`, `createdAt`,
`updatedAt`. **No IP column.** `isOnline`/`notDetected` are read-time derived, never persisted.
Fresh deployment (`ADR-026`): the 4 production device rows are **NOT imported** (no legacy migration) —
they are evidence only that MAC/alias/blocked/last-seen are the right fields. The list is
rebuilt via v2 picker registration (a row import is impossible by construction, since
registration requires selecting a live client). Credentials are never in this table or
`app_settings`. The in-process poller cache is single-instance (deployment
premise), local, non-persisted.

## Acceptance Criteria

- A plugin reads UniFi credentials only via the host operator-config interface; the secret
  never appears in `GET /settings`, a backup, or telemetry.
- The device-list GET performs no writes; blocked-state reconciliation happens only in the
  background poll.
- A failed local write after a successful UniFi block self-heals on the next poll, and the
  device shows "belief vs controller" until reconciled.
- Registration is rejected unless the submitted MAC is present in the current fresh cache;
  a manually-posted MAC absent from the cache is refused.
- Deleting any device (blocked or not) performs no UniFi call and always succeeds locally.
- No IP address is ever stored or returned; a MAC never appears in telemetry/diagnostics
  un-redacted; the UI shows the alias, not the MAC.
- Network endpoints reject a kiosk `*` device key; admin authorization is required for reads
  and writes alike.
- Assigning a device to an inactive member is rejected; an existing inactive link renders as
  "inactive member" and the device stays editable.

## Open Questions

- None blocking. The UniFi block mechanism (legacy `block-sta`/`unblock-sta` vs the
  March-2026 `acl_rule_id` design) is an implementation choice **constrained** (not free): it
  must keep blocked-state poll-readable so reconciliation can confirm `isBlocked=true` (see
  §2). The contract requires "block/unblock a MAC via the controller, confirm before
  mirroring, and keep the result observable to the poller."

## Traceability

- Related prior: resolves spec `10` open questions (§12).
- Domain grill: `../domain-grills/network-devices.md`
- Refines: `ADR-039` (host operator-config interface), `ADR-016` (deny-list MAC/IP).
- Related: `ADR-002`, `ADR-005`, `ADR-007`, `ADR-013`, `ADR-014`, `ADR-017`, `ADR-026`,
  `ADR-028`, `ADR-030`, `ADR-031`, `ADR-040`, `ADR-043`, `ADR-049`.
