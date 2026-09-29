# ADR-032 Bootstrap `*` Key Establishment (Deployment-Agnostic)

Status: accepted
Owner: architecture / ops
Decision date: 2026-06-28

## Decision

The first `*` (full-access) API key on a fresh v2 deployment — the bootstrap key — is established from a **deployment-provided configuration value**, expressed deployment-agnostically. The portable mechanism is an environment variable; v2 must not couple this to any specific hosting platform (Fly, Docker, Kubernetes, bare metal, systemd, `.env`, etc. are all valid).

### Rules

1. **Bootstrap source.** The deployment provides the bootstrap key value through an environment variable (or equivalent config secret). No hosting-platform-specific mechanism is assumed or required.
2. **Startup reconciliation.** On startup, if the bootstrap value is configured and no active `*` key record matching it exists, the system seeds a `*` key record for it (hash stored like any key). This lets the bootstrap participate in the uniform per-request validation and the anti-lockout rule (`ADR-030`).
3. **Provisioning.** The operator uses the bootstrap key in the connection-setup flow to provision per-device `*` keys (`ADR-030`). The same bootstrap key may provision multiple devices (multiple kiosks).
4. **No auto-rotation on first access.** The bootstrap key is **not** automatically revoked when the first device is provisioned. Auto-revoking would (a) prevent provisioning additional kiosks from the same bootstrap and (b) conflict with startup reconciliation, which would re-seed it while the config value is still present.
5. **Operator retirement with a nudge.** After the first device is provisioned, the admin UI surfaces a recommendation to retire the bootstrap key once all devices are set up. Retiring is an explicit two-step operator action: remove the bootstrap config value from the deployment (so reconciliation no longer re-seeds it) and revoke the bootstrap key record. The **anti-lockout** rule (`ADR-030`) guarantees this is only possible once at least one device `*` key exists, so the household can never lock itself out.

## Rationale

A deployment-provided config secret avoids the chicken-and-egg problem of first-run key generation (there is no secure channel to display a generated key before any credential exists). An environment variable is the lowest-common-denominator mechanism portable across all hosting models, so the contract names no platform.

Reconciliation keeps the bootstrap usable across restarts and after backup restore (as long as the config value is set), while explicit operator retirement — nudged by the UI — ensures the shared bootstrap secret does not linger as a permanent credential. Not auto-rotating preserves multi-kiosk provisioning and avoids fighting reconciliation.

## Affected Specs

- [the auth sessions feature](../../features/auth-sessions.md) — API connection credential, first-run setup
- the kiosk shell navigation feature (deferred) — connection-setup provisioning + bootstrap-retire nudge
- the backups feature (deferred) — restore interaction with reconciliation (`ADR-017`)

## Data / Setup Implications

- Fresh setup: the operator sets one bootstrap config value (env var) plus the separate frontend access-gate token (`ADR-031`). These are deployment secrets, managed by whatever mechanism the host provides.
- The bootstrap key becomes a `*` key record in the database on startup reconciliation, so it is backed up like any key.
- After backup restore, if the bootstrap config value is still set, reconciliation re-establishes the bootstrap record; if the operator had already retired it (config value removed), it is not re-seeded.

## Acceptance Criteria

- Given a fresh deployment with the bootstrap config value set, when the system starts, then a `*` key record matching it exists.
- Given the bootstrap key, when the operator provisions two kiosks in sequence, then both are provisioned (the bootstrap is not consumed by the first).
- Given the first device has been provisioned, when the admin opens key management, then the UI recommends retiring the bootstrap key.
- Given at least one device `*` key exists, when the operator revokes the bootstrap and removes its config value, then the next startup does not re-seed the bootstrap and the deployment remains accessible via the device key.
- Given the bootstrap is the only active `*` key, when the operator tries to revoke it, then the system refuses (anti-lockout).
- The contract names no specific hosting platform; the bootstrap mechanism is an environment variable / config secret only.

## Open Questions

- None.

## Traceability

- Conflicts: `CR-007`, `CR-013`
- Pre-v2: `ADR-007`, `ADR-013`
- Related: `ADR-030` (key model, anti-lockout), `ADR-031` (separate access-gate token)
