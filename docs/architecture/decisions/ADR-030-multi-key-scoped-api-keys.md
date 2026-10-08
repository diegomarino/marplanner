# ADR-030 Multi-Key Scoped API Keys with Lifecycle and Device Provisioning

Status: accepted
Owner: architecture / security
Decision date: 2026-06-28

## Reconciliation (2026-10-08)

Key-management issuance/revocation/rotation and the anti-lockout mutation gate remain deferred in the installed release. Their future invariant must protect operator-usable credentials, not merely count device keys. A device cookie cannot supply the raw header credential required below. `ADR-032` retirement must preserve both future management access and replacement-device provisioning.

## Decision

The system replaces the single deployment API key with **multiple named API keys**, each with capability scopes and a managed lifecycle. This narrows `ADR-007`: a valid API key no longer implies full access — it authorizes exactly its granted capabilities.

### Capability model

- A scope is `domain:verb` where `domain` is one of the `ADR-029` core/plugin domains and `verb` is one of `read | write | admin`.
  - `read` — read operations in the domain.
  - `write` — ordinary create/update/delete in the domain.
  - `admin` — special/destructive operations distinct from ordinary write (e.g. `calendar:admin` = delete external calendar sources). Each domain that offers `admin` must document what `admin` authorizes; enumeration happens in that domain's grill.
- `*` is the wildcard: full access to every domain and verb.
- Granularity is **per-domain, not per-endpoint**. Each endpoint declares the single capability it requires; middleware checks the presented key has that capability or `*`.

### Two ways a key comes into existence

**1. Device keys — provisioned via the UI connection flow**

- Triggered in connection-setup, when the browser has no valid cookie. A human enters a raw `*` key (the bootstrap key, or any existing `*` key).
- The server **mints a new `*` key**, `expiresAt = null`, labeled per device (e.g. "Kiosk – living room, provisioned 2026-06-28"), and binds the httpOnly signed cookie to that new device key.
- The minted device key's raw value **never leaves the server** — it is baked directly into the httpOnly cookie, never returned in a response body. This is strictly safer than the issued-key flow: there is no raw value for an XSS to exfiltrate.
- Each device authenticates thereafter with its own key identity. A device can be revoked individually without affecting other devices or the bootstrap key.

**2. Integration keys — issued via the management endpoint**

- Created by the key-management endpoint, authenticated **only by a raw `*` key in a header** — never by cookie (see Security Invariants).
- The raw key value is shown **exactly once** at creation and never again (only its hash is stored).
- Scoped (`domain:verb` list), with optional `expiresAt` chosen at creation.
- Intended for server-to-server automations using the raw key in a request header (e.g. an external "openclaw" calendar sync given `["calendar:write"]`).

### Key record fields

| Field                      | Contract                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `id`                       | Stable record identifier.                                                                                                         |
| `label`                    | Human-readable name.                                                                                                              |
| `hash`                     | Hash of the key. Raw value is never persisted; for issued keys it is shown once at creation, for device keys it is never exposed. |
| `scopes`                   | `["*"]` or a list of `domain:verb`.                                                                                               |
| `expiresAt`                | Optional. `null` = never expires. Device keys are always `null`.                                                                  |
| `revokedAt`                | `null` = active. Revocation is immediate and irreversible.                                                                        |
| `createdAt` / `lastUsedAt` | Audit. `lastUsedAt` helps detect orphaned keys (update semantics may be debounced).                                               |

### Validation and lifecycle

- **Uniform per-request validation:** every authenticated request validates the signature (cookie) or raw key (header) AND checks the referenced key record is still active (not revoked, not expired). Revocation/expiry takes effect on the next request. This is not a session table (`ADR-013` holds) — it is a status check against the keys table, which must be read anyway to resolve scopes.
- **Key rotation** = create new + revoke old.
- **Key management** (create / list / revoke) is hardwired to require a `*` key presented as a raw header value. A scoped key can never create or manage keys, even if someone tried to grant it a `keys:*` scope. A compromised integration key cannot escalate by minting new keys.

## Security Invariants (from peer review)

1. **Key-management and key-creation endpoints never accept cookie authentication.** They require the raw `*` key in a header. Rationale: otherwise an XSS in the kiosk origin could `POST` a key-creation request using the httpOnly cookie and exfiltrate the returned raw key, converting an ephemeral browser compromise into a durable bearer credential. (Device provisioning is exempt from this concern because it never returns a raw key — the minted key goes only into the httpOnly cookie.)
2. **Fail-closed enforcement.** If an endpoint does not declare a required capability, the middleware rejects all requests with 403 regardless of key type. Capability declaration is mandatory, not a convention.
3. **Anti-lockout (future key lifecycle).** Refuse a mutation that removes the last active operator-usable raw `*` credential. A cookie-only device key does not satisfy this invariant. Bootstrap retirement also requires an operator-held replacement credential admitted by the provisioning flow (`ADR-032`); existing device access alone is insufficient.
4. **Fail-closed always; no environment-conditional bypass.** Enforcement is identical in every environment; a missing credential locks the system (never opens it). See `ADR-033`.

## Rationale

A single shared deployment key has no blast-radius control and no audit trail: anything with the key can do anything, and a leak forces rotating the one key everyone uses. Multiple scoped keys give least-privilege for out-of-trust-boundary integrations (a leaked `calendar:write` key cannot touch members, settings, or backups), individual revocability, and per-key audit via `lastUsedAt`.

Device provisioning gives each kiosk its own durable identity, isolates revocation per device, and — because the device key is never exposed to JS — is more secure than handing the kiosk a shared raw key.

Peer review (codex blind-debate, 2026-06-28) confirmed the per-domain `read/write/admin` altitude is well-matched to the household threat model (not over-engineered), endorsed `*`-only key management, and endorsed the cookie-only-for-`*` / header-only-for-issued split. The XSS key-exfiltration vector, the fail-open default, and the cookie-revocation tension were its findings, all resolved above.

## Affected Specs

- [the auth sessions feature](../../features/auth-sessions.md) — API connection credential, exchange, revoke, boundary
- [the app settings registry feature](../../features/app-settings-registry.md) — settings writes now authorized per scope
- the calendar feature (deferred) — external calendar sync integration key (`calendar:write` / `calendar:admin`)
- the kiosk shell navigation feature (deferred) — connection-setup provisioning flow
- all domain specs — each endpoint declares its required `domain:verb` capability

## Data / Setup Implications

- Fresh setup creates one bootstrap `*` key (the deployment secret). The first kiosk connect provisions a device key from it.
- No legacy keys/sessions are migrated (`ADR-026`).
- Backup/restore must preserve key records (hashes, scopes, lifecycle). After restore, revoked keys stay revoked and the anti-lockout invariant still holds. (Detailed restore behavior continues under `ADR-017`.)

## Acceptance Criteria

- Given a key scoped `["calendar:write"]`, when it calls a `members:read` endpoint, then the request is rejected 403.
- Given a key scoped `["calendar:write"]`, when it calls the key-management create endpoint, then the request is rejected (management requires `*`).
- Given any key presented via cookie, when it calls the key-management create endpoint, then the request is rejected (management requires a raw `*` header key).
- Given an endpoint with no declared capability, when any key calls it, then the request is rejected 403 (fail-closed).
- Given a `*` device key is revoked, when its cookie is used on the next request, then the request is rejected.
- Given only one operator-usable raw `*` credential remains, when a caller tries to revoke or expire it, then the future lifecycle gate refuses, even if active device `*` keys remain.
- Given a first kiosk connect with a raw `*` key, when provisioning runs, then a new `*` device key with `expiresAt = null` is minted and bound to the httpOnly cookie, and no raw key value appears in the response body.

## Open Questions

- Per-domain definition of the `admin` verb — deferred to each domain's grill.
- Backup/restore behavior for key records in detail — `ADR-017`.

## Traceability

- Conflicts: `CR-007`, `CR-013`
- Related prior: `ADR-007` (narrowed), `ADR-013`
- Peer review: codex-peer-review blind-debate (2026-06-28) — model altitude validated; XSS key-exfiltration, fail-open default, and cookie-revocation tension resolved.
