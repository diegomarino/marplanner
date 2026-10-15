# Feature: Network Devices (curated device registry + block intent)

Behavior reference. The [owning contract](../architecture/contracts/network-devices.md) defines invariants and extension limits.

Network Devices is a parent/admin **plugin** that keeps a curated, friendly-named
list of household devices, optionally assigns each to a member, and blocks or
restores its internet access. The UniFi Cloud controller owns live connectivity
and block enforcement; this domain owns the device registry (labels +
assignments) and the admin's block/unblock intent. It never owns credentials,
controller identity, or live connectivity truth — live status is derived or
mirrored, never persisted as required truth.

## User workflows

### User Story 1 — Register and label a household device

A parent opens the registration picker, which shows the controller's current live
clients; they select one, give it a friendly alias, and optionally assign it to an
active member. The selected device joins the curated list with its last-seen stamp
taken from the live observation.

### User Story 2 — Block and restore a device's internet

A parent blocks a registered device; the intent crosses to the UniFi controller
(authoritative) and is then mirrored to the local `isBlocked` belief. Later they
unblock it the same way. The list keeps showing each device's online/blocked status
even when the controller is unreachable.

### User Story 3 — Curate the list without touching the controller

A parent edits a device's alias or member assignment, or deletes a device they no
longer want to track. These are local-only writes that never call UniFi; deleting a
blocked device succeeds locally and the admin accepts that the block lingers upstream.

### Edge Cases

- A submitted MAC that has rotated out of the current fresh cache is refused with a
  friendly reselect error rather than registered blind.
- A duplicate-registration race for the same canonical MAC is deduped server-side
  regardless of UI guards.
- A controller outage or stale/cold cache yields conservative live status and an
  explicit unavailable/unconfigured state, never an invented fresh-online.
- A local mirror write that fails after a successful controller block leaves a stale
  "belief vs controller" state that self-heals on the next poll.
- A device-scoped `*` kiosk key calling the network endpoints is rejected at the
  capability layer, not merely by route placement.
- An assignment to an inactive member is rejected, while a pre-existing inactive link
  is tolerated and rendered as "inactive member".

## Requirements

### Functional Requirements

- **FR-001**: Given a registration request, when a canonical (case-normalized) MAC is submitted, then the server MUST register that MAC at most once and MUST reject duplicate-registration races regardless of UI guards. Contract: NETWORK-DEVICES-INV-01.

- **FR-002**: Given a registered device, when it is edited, then the edit MUST NOT change its MAC, and a changed/randomized MAC MUST be handled as a new registration (delete the stale entry, re-add from the picker) with no in-place MAC mutation and no replace-MAC workflow. Contract: NETWORK-DEVICES-INV-02.

- **FR-003**: Given the `isBlocked` flag, when it is interpreted, then it MUST describe internet access for the MAC and MUST never describe membership. Contract: NETWORK-DEVICES-INV-03.

- **FR-004**: Given live status (`isOnline`/`notDetected`/`isBlocked`), when the registry is read, then that status MUST be treated as derived or mirrored and MUST never be required persisted truth, and a controller outage MUST NOT corrupt the registry. Contract: NETWORK-DEVICES-INV-04.

- **FR-005**: Given a device-list read, when it executes, then it MUST perform no writes, with no reconcile-on-read and no `lastSeenAt`-on-read. Contract: NETWORK-DEVICES-INV-05.

- **FR-006**: Given controller data crossing the poller normalization boundary, when it is ingested, then an IP address MUST NOT be ingested, stored, or returned, and any IP MUST be dropped at that boundary. Contract: NETWORK-DEVICES-INV-06.

- **FR-007**: Given telemetry or human-facing diagnostic artifacts, when a MAC is referenced, then a raw MAC MUST NOT appear un-redacted, the normal UI MUST show the alias rather than the MAC, and real MACs MUST live only in the operational DB and its backup `.db`. Contract: NETWORK-DEVICES-INV-07.

- **FR-008**: Given UniFi credentials, when the plugin needs them, then they MUST NOT live in `network_devices`, `app_settings`, `GET /settings`, backups, or telemetry, and they MUST be read only as operator env config via the host operator-config interface. Contract: NETWORK-DEVICES-INV-08.

- **FR-009**: Given a network reads/writes or block/unblock request, when it is authorized, then it MUST require management/admin scope (ADR-030/031), and a device `*` kiosk key MUST be rejected at the API capability layer, not only by route placement. Contract: NETWORK-DEVICES-INV-09.

- **FR-010**: Given the `lastSeenAt` field, when it is stamped, then it MUST be stamped only from a real observation (guaranteed by picker-only registration) and MUST never be a creation-time default. Contract: NETWORK-DEVICES-INV-10.

- **FR-011**: Given a device-list read, when it returns rows, then it MUST perform no writes, and blocked-state reconciliation MUST happen only in the background poll. Contract: NETWORK-DEVICES-AC-01.

- **FR-012**: Given a successful controller block, when the subsequent local mirror write fails, then the divergence MUST self-heal on the next poll, and until then the device MUST show "belief vs controller". Contract: NETWORK-DEVICES-AC-02.

- **FR-013**: Given a registration request, when the submitted MAC is not in the current fresh cache, then registration MUST be rejected, and a cache-rotation rejection MUST surface a friendly reselect error. Contract: NETWORK-DEVICES-AC-03.

- **FR-014**: Given any device (blocked or not), when it is deleted, then the deletion MUST perform no UniFi call and MUST always succeed locally. Contract: NETWORK-DEVICES-AC-04.

- **FR-015**: Given the system, when devices are stored or returned and telemetry is emitted, then an IP MUST NOT be stored or returned, a MAC MUST never appear un-redacted in telemetry, and the UI MUST show the alias. Contract: NETWORK-DEVICES-AC-05.

- **FR-016**: Given a network endpoint call, when it presents a device `*` kiosk key, then it MUST be rejected, and management/admin scope MUST be required for reads and writes. Contract: NETWORK-DEVICES-AC-06.

- **FR-017**: Given a member assignment, when the target is an inactive member, then the assignment MUST be rejected, while an existing inactive link MUST render as "inactive member" and the device MUST stay editable. Contract: NETWORK-DEVICES-AC-07.

- **FR-018**: Given a plugin needing UniFi credentials, when it reads them, then it MUST read them only via the host operator-config interface, and the secret MUST never appear in `GET /settings`, a backup, or telemetry. Contract: NETWORK-DEVICES-AC-08.

### Admin console

- **FR-019**: Given the admin Network devices page, when it renders, then it MUST offer two tabs, "Registered devices" and "Add device", and the page heading MUST equal the sidebar label. The active tab is local page state, not a URL sub-route.

- **FR-020**: Given a registered device, when its row renders, then it MUST show a status dot (success colour for online, destructive colour for online and blocked, muted for unknown, a warning glyph for not detected) and status chips, and the text label MUST remain the accessible carrier (colour is never the sole signal). Last-seen MUST never be shown next to "online".

- **FR-021**: Given the registered list is open and the browser tab is visible, when 30 seconds pass, then the list MUST refresh silently (no loading state), MUST NOT refresh while the tab is hidden, and a refresh that was in flight while the user blocked, unblocked, edited, deleted or registered a device MUST NOT overwrite that newer local result.

- **FR-022**: Given a device, when it is edited or registered, then the form MUST open in a dialog that never shows a raw MAC; the registration dialog MUST prefill the alias from the client's name (empty when unnamed, at most 80 characters).

- **FR-023**: Given a delete action, when it is requested, then a confirmation dialog MUST be shown, using the stranded-upstream-block wording whenever the device is blocked or its belief diverged, and nothing is deleted until it is confirmed.

- **FR-024**: Given the Add tab, when it lists live clients, then it MUST be sortable by name and by MAC address, MUST dim already-registered MACs (compared case-insensitively) with an "Already added" badge instead of an Add button, and MUST return to the registered list after a successful registration. The discovery table is the one place a MAC is shown.

- **FR-025**: Given the page is opened with a credential denied on scope (a device kiosk key, FR-016), when a read answers 403 `scope_denied`, then the page MUST say that network access rules need the household management key instead of a generic load failure, and every load failure MUST offer Retry.

### Key Entities

- **Registered device**: one row in the curated list — a canonical MAC (natural
  key, unique) + a friendly alias + optional active-member assignment; attributes
  `id`, `mac`, `alias`, `memberId?`, `unifiClientId?`, `isBlocked`, `lastSeenAt?`,
  `createdAt`, `updatedAt`. No IP column. `isOnline`/`notDetected` are derived at
  read time, never persisted.
- **Live client**: a device the controller currently reports in its in-process,
  non-persisted client cache; source of the registration picker and of derived
  online/blocked state. Never a stored entity.
- **Belief (`isBlocked`)**: Marplanner's mirrored cache of the controller's
  blocked-state for a MAC — not primary truth, reconciled from the controller by
  the background poll.

## Success Criteria

- **SC-001**: 100% of device-list reads complete with zero writes (no reconcile-on-read,
  no `lastSeenAt` stamp); all blocked-state reconciliation is attributable to the
  background poll.
- **SC-002**: 0 IP addresses and 0 un-redacted MACs appear in any returned payload,
  telemetry record, or human-facing diagnostic artifact across all operations.
- **SC-003**: 100% of registrations whose submitted MAC is absent from the current fresh
  cache are rejected with a reselect error; 0 manual-MAC registrations succeed.
- **SC-004**: 100% of network endpoint calls bearing a device `*` kiosk key are rejected
  at the capability layer; only management/admin scope is admitted.

## Assumptions

- The UniFi Cloud controller is authoritative for live connectivity and block
  enforcement; this domain mirrors blocked-state and never asserts a fresh-online it
  cannot confirm.
- The poller cache is single-instance, in-process, and non-persisted (deployment
  premise); it is normalized on startup and each interval, dropping IPs.
- Fresh data store (ADR-026): the 4 production device rows are not imported; the
  list is rebuilt through v2 picker registration only.
- Credentials are operator env config read via the host operator-config interface
  (ADR-039), never imported into any table.
- The concrete block mechanism (`block-sta` vs `acl_rule_id`) is deferred to
  implementation, constrained only to keep blocked-state poll-readable.

## Exercising the page without a controller

- Component tests (`tests/client/network-devices-management.test.tsx`) cover every live-cache state with a fetch fake.
- The e2e spec (`tests/e2e/network-devices.spec.ts`) starts a local self-signed HTTPS controller (`tests/e2e/unifi-fixture-server.ts`) and its own server with the scheduler enabled.
- For manual use, `npm run dev:unifi-fixture` starts the same fixture with six demo clients (one unnamed). Order matters:
  1. Run `npm run dev:unifi-fixture -- --api http://127.0.0.1:3100` first; it prints the environment (`UNIFI_API_KEY`, `UNIFI_SITE_ID`, `UNIFI_HOST`, `NODE_EXTRA_CA_CERTS`, `MP_MANAGEMENT_KEY`).
  2. Start the dev server with that environment (and the seeded `DATA_DIR`). The tool waits for a fresh live cache, registers the first four demo clients through the real API and blocks one.
  3. Open the SPA, then `npm run dev:session -- --management` swaps the browser's `mp_device_key` cookie to `MP_MANAGEMENT_KEY`. Do not reload afterwards: `/api/plugins*` rejects the management cookie, so navigate inside the SPA.
- Limitation: a "not detected" device cannot be produced this way (registration needs the device in the live cache); the component tests cover that state.
- `UNIFI_TLS_INSECURE` is not used (Node 24 undici mismatch, see the fixture server's docblock); the certificate is trusted through `NODE_EXTRA_CA_CERTS` and is regenerated on every run, so restart the dev server after restarting the tool.
