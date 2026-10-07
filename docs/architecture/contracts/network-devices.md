# Network Devices Domain Contract

Status: maintained contract
Depends on decisions: `ADR-002`, `ADR-005`, `ADR-007`, `ADR-013`, `ADR-014`, `ADR-016`, `ADR-017`, `ADR-026`, `ADR-030`, `ADR-031`, `ADR-039`, `ADR-040`, `ADR-043`, `ADR-049`, `ADR-053`

## Purpose

Network Devices is a **plugin** that lets a parent/admin keep a **curated, friendly-named
list of household devices they want to control**, optionally assign each to a member, and
block or restore its internet access. The network controller (UniFi Cloud API) owns live
connectivity and block enforcement; this domain owns the list and the family-facing intent.

It does not own credentials, controller identity, or live connectivity truth — it owns the
device registry (labels + assignments) and the admin's block/unblock intent.

## Vocabulary

**Registered device** — one row in the curated list: a canonical MAC (natural key) + a
friendly alias + optional member assignment.

**Live client** — a device the controller currently reports in its client cache. The source
of the registration picker and of derived online/blocked state.

**Belief (`isBlocked`)** — Marplanner's mirrored cache of the controller's blocked-state for
a MAC. Not primary truth; reconciled from the controller.

**Derived status** — `isOnline` (MAC in a fresh cache) and `notDetected` (never seen, or last
seen > 7 days). Computed at read time, never persisted.

## Invariants

- **NETWORK-DEVICES-INV-01** A MAC is registered at most once; the server dedupes canonical (case-normalized) MAC and
  rejects duplicate-registration races regardless of UI guards.
- **NETWORK-DEVICES-INV-02** Editing a device never changes its MAC. A changed/randomized MAC is a new registration
  (delete the stale entry, re-add from the picker) — no in-place MAC mutation, no replace-MAC
  workflow.
- **NETWORK-DEVICES-INV-03** `isBlocked` describes internet access for the MAC, never membership.
- **NETWORK-DEVICES-INV-04** Live status (`isOnline`/`notDetected`/`isBlocked`) is derived/mirrored, never required
  persisted truth; a controller outage must not corrupt the registry.
- **NETWORK-DEVICES-INV-05** The device-list read performs **no writes** (no reconcile-on-read, no `lastSeenAt`-on-read).
- **NETWORK-DEVICES-INV-06** **No IP address is ever ingested, stored, or returned.** Dropped at the poller
  normalization boundary.
- **NETWORK-DEVICES-INV-07** A raw MAC never appears un-redacted in telemetry or human-facing diagnostic artifacts; the
  normal UI shows the alias, not the MAC. Real MACs live only in the operational DB and its
  backup `.db`.
- **NETWORK-DEVICES-INV-08** UniFi credentials never live in `network_devices`, `app_settings`, `GET /settings`,
  backups, or telemetry; they are operator env config read only via the host operator-config
  interface.
- **NETWORK-DEVICES-INV-09** Block/unblock and reads/writes require **management/admin scope** (ADR-030/031); a device
  `*` kiosk key is rejected at the API capability layer, not only by route placement.
- **NETWORK-DEVICES-INV-10** `lastSeenAt` is stamped only from a real observation (guaranteed by picker-only
  registration); never a creation-time default.

## Behaviors

**List registered devices** — pure read. Returns stored rows enriched with read-time
`isOnline`/`notDetected` and the mirrored `isBlocked`. Works even when UniFi is unconfigured
or the cache is stale (conservative live status; never invents fresh-online). If belief can't
be confirmed, the device is shown as "belief vs controller" rather than asserting a possibly
false state.

**List live clients (registration picker)** — reads the cached snapshot. Missing config →
integration-unconfigured error; cold/stale cache (> 5 min) → unavailable error; empty list →
explicit empty state. Never creates or deletes registrations.

**Register a device** — picker-only. Requires UniFi configured + a fresh cache + a selected
live client. The server validates the submitted MAC is present in the current fresh cache
(does not trust the client), canonicalizes it, dedupes, and stamps `lastSeenAt` from the
observation. A MAC absent from the current cache is refused with a friendly retry error
(cache-rotation edge). No manual MAC entry.

**Edit alias / member assignment** — local write, no UniFi. Omitted fields keep prior values;
`null` member unassigns. A new non-null `memberId` must resolve to an **active** member
(ADR-002); a pre-existing inactive link is tolerated and rendered as "inactive member".
Editing never re-blocks, unblocks, or changes the MAC.

**Block / unblock internet** — the only operation crossing to UniFi. Intent → controller call
(authoritative) → mirror to local `isBlocked`. A failed local write after a controller success
is stale cache, corrected by the next poll. The already-blocked/not-blocked guard reads the
(possibly stale) belief and is accepted as such — no smarter cross-boundary guard.

**Delete a device** — always allowed, local-only, **never calls UniFi**, no guard. Removes the
list entry. If the device was blocked, the block lingers in UniFi (accepted stranding; the
admin's responsibility).

**Reconcile blocked state** — background poll only (ADR-014), idempotent: pulls controller
blocked-state and corrects divergent rows. Never creates/deletes registrations. Requires a
poll-readable authoritative blocked-state source from the chosen block mechanism.

**Refresh live status / last-seen** — poller normalizes controller MACs + connection type
(IPs dropped) into the live-client cache on startup + each interval. `lastSeenAt` for online
registered devices is refreshed by the poll, not by list reads. Poll failure retains the last
good cache.

## Interfaces

Conceptual surface (host-API inbound; not route names):

- `listDevices()` → registered devices + derived status (pure read).
- `listLiveClients()` → current cache snapshot for the picker (or unconfigured/unavailable).
- `registerDevice({ mac, alias, memberId? })` → validates cache membership + dedupe.
- `editDevice(id, { alias?, memberId? })` → local label/assignment write.
- `blockDevice(id)` / `unblockDevice(id)` → controller enforcement + mirror.
- `deleteDevice(id)` → local removal, never UniFi.
- Operator-config (host API, read-only): `host.getOperatorConfig('unifi.*')` for credentials.

## Events

(ADR-040.) **Emits:** `network.device_blocked` / `network.device_unblocked` (payload:
deviceId, MAC-internal-not-logged-raw, timestamp) as observability breadcrumbs consumed by
Client Logging (ADR-016) — not load-bearing; absent subscriber = graceful. **Subscribes:**
none. Member soft-delete is handled by read-tolerance (render "inactive member"), not by a
member event subscription.

## Data / Setup Contract

Owned table `network_devices` in the plugin namespace (ADR-039): `id`, `mac` (canonical,
unique), `alias`, `memberId?`, `unifiClientId?`, `isBlocked`, `lastSeenAt?`, `createdAt`,
`updatedAt`. **No IP column.** `isOnline`/`notDetected` derived at read time. Fresh deployment
(ADR-026): the 4 production device rows are **NOT imported** — they are evidence only that
MAC/alias/blocked/last-seen are the right fields. The list is **rebuilt through v2 picker
registration** (a row import is impossible by construction anyway, since registration requires
selecting a live client). Credentials are operator env, never imported into any table. The poller
cache is single-instance, in-process, non-persisted (deployment premise). Diagnostic/backup
artifacts: real MACs in the backup `.db` only; sanitized everywhere human-facing.

## Acceptance Criteria

- **NETWORK-DEVICES-AC-01** The device-list read performs no writes; blocked-state reconciliation happens only in the
  background poll.
- **NETWORK-DEVICES-AC-02** A failed local write after a successful controller block self-heals on the next poll; until
  then the device shows "belief vs controller".
- **NETWORK-DEVICES-AC-03** Registration is rejected unless the submitted MAC is in the current fresh cache; a
  cache-rotation rejection surfaces a friendly reselect error.
- **NETWORK-DEVICES-AC-04** Deleting any device (blocked or not) performs no UniFi call and always succeeds locally.
- **NETWORK-DEVICES-AC-05** No IP is ever stored or returned; a MAC never appears un-redacted in telemetry; the UI shows
  the alias.
- **NETWORK-DEVICES-AC-06** A device `*` kiosk key is rejected by the network endpoints; management/admin scope is
  required for reads and writes.
- **NETWORK-DEVICES-AC-07** Assigning to an inactive member is rejected; an existing inactive link renders as "inactive
  member" and the device stays editable.
- **NETWORK-DEVICES-AC-08** A plugin reads UniFi credentials only via the host operator-config interface; the secret
  never appears in `GET /settings`, a backup, or telemetry.

## Open Decisions

- Block mechanism (`block-sta` vs `acl_rule_id`) is constrained (must keep blocked-state
  poll-readable) but the concrete choice is deferred to implementation.
- Optional grace window for the picker cache-rotation edge (not required for this system).
