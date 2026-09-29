# Feature: Auth & Sessions (the household authorization boundary)

Behavior reference. The [owning contract](../architecture/contracts/auth-sessions.md) defines invariants and extension limits.

Auth & Sessions owns the credentials and boundaries that protect the household
deployment: the API-key authorization model, the client-side PIN admin-UI gate, and
the frontend access gate. It defines what is reachable with which credential, and how
credentials are established, validated, and retired. It is a **pull / request-time**
model — every request re-validates the key record — with **no** server-side session
lifecycle and **no** event-bus participation. It does not own member identity
(Members), route structure or the admin-unlock UI (Kiosk Shell), or which capability
each endpoint requires (each domain declares its own).

## Implementation status

Provisioning, request authorization, frontend access gating and PIN verification are implemented. Key create/list/revoke, last-key anti-lockout and `set-pin` are not implemented. Requirements for those future interfaces remain labeled below; they are not operating instructions.

## Behavior

### User Story 1 — Provision the first device from the bootstrap key

The operator supplies a bootstrap `*` value in the deployment environment. At connection-setup
(no valid cookie) a human submits that raw `*` key; the server mints a `*` device key
with no expiry, binds it to an httpOnly cookie, and never returns the raw key. The key remains persisted even if its environment value is removed; no retirement endpoint is installed.

### Integration credentials

Startup reconciles the configured `MP_MANAGEMENT_KEY` into an integration credential. There is no API to issue, list or revoke keys. See [operations](../operations.md) before changing credentials; replacing a configured value leaves the old persisted key valid.

### User Story 3 — Unlock admin with the client-side PIN

A parent enters the PIN; the frontend verifies it via an API-key-protected `verify-pin`
that returns match/no-match only, then sets ephemeral "admin unlocked" UI state with an
inactivity relock. No session row is created, a refresh clears the unlock, and backend
authorization never consults PIN state.

### Edge Cases

- A missing credential (any environment) locks the deployment — only `/health` is
  reachable; it never opens it.
- Last-key anti-lockout is a requirement for future key management; no installed mutation enforces it.
- An endpoint that declares no required capability rejects every request.
- Scoped keys are rejected outside their scopes. Key-management routes are absent.
- Revocation/expiry are not pushed — they take effect on the next request because each
  request re-validates the key record.

## Requirements

### Behavior requirements

- **FR-001**: Given any backend operation, when authorization is decided, then the API key MUST be the sole authorization boundary and the key's authority MUST be bounded by its scopes — a `*` key authorizes everything, a scoped key only its `domain:verb` capabilities. _(Realizes: AUTH-SESSIONS-INV-01)_

- **FR-002**: Given any endpoint, when the backend authorizes a request, then the PIN MUST NOT authorize backend operations; hash verification is server-side, while admin-unlocked state is client-side only. _(Realizes: AUTH-SESSIONS-INV-02)_

- **FR-003**: Given the auth model, when a request is authorized, then there MUST be no server-side session table, no `x-session-id`, and no server session lifecycle. _(Realizes: AUTH-SESSIONS-INV-03)_

- **FR-004**: Given any environment, when a credential is missing, then enforcement MUST be fail-closed (the deployment is locked, only `/health` reachable, never opened), and the system MUST NOT allow any code path to disable or relax auth enforcement based on environment. _(Realizes: AUTH-SESSIONS-INV-04)_

- **FR-005**: Given an endpoint that does not declare a required capability, when any request reaches it, then it MUST reject all requests (fail-closed default). _(Realizes: AUTH-SESSIONS-INV-05)_

- **FR-006 (planned, not implemented)**: Given a key-management operation (create/list/revoke), when it is authorized, then it MUST require a `*` key presented as a raw header value, MUST reject a cookie, and MUST NOT be delegable to a scoped key. _(Realizes: AUTH-SESSIONS-INV-06)_

- **FR-007 (planned, not implemented)**: Given the last active `*` key, when a revoke or expire is attempted, then the system MUST refuse it (anti-lockout). _(Realizes: AUTH-SESSIONS-INV-07)_

- **FR-008**: Given the trust model, when an operation is authorized, then there MUST be no second server-side privilege tier — a provisioned device's `*` cookie confers full household trust — and key-management MUST be the sole server-side operator boundary (with the `ADR-053` device-block as the lone pre-existing carve-out); every other operation — backups, plugins, telemetry-read, settings — MUST be household-tier (device-`*` cookie + client-side PIN), and any future operation that appears to need an ad-hoc per-endpoint "admin scope" carve-out MUST instead be treated as a signal to re-examine the threat model rather than add a tier. _(Realizes: AUTH-SESSIONS-INV-08)_

- **FR-009**: Given any authenticated request, when it is validated, then it MUST validate both the credential and that the referenced key record is active (not revoked, not expired), and revocation or expiry MUST take effect on the next request. _(Realizes: AUTH-SESSIONS-INV-09)_

- **FR-010**: Given raw credential values, when a key or PIN is handled, then device keys MUST never be exposed, integration keys MUST be shown exactly once at creation, and raw PINs MUST never be persisted or returned. _(Realizes: AUTH-SESSIONS-INV-10)_

- **FR-011**: Given any auth state, when it is stored, then it MUST live in the database and MUST NOT be held in process memory. _(Realizes: AUTH-SESSIONS-INV-11)_

- **FR-012**: Given telemetry or logs, when they are written, then they MUST never contain raw PINs, API keys, cookies, or access-gate tokens. _(Realizes: AUTH-SESSIONS-INV-12)_

- **FR-013**: Given no credential configured in any environment, when a non-health endpoint is called, then it MUST return 401/403 and the deployment MUST be locked, never open (the fail-closed acceptance surface; the representational invariant is FR-004/INV-04). _(Realizes: AUTH-SESSIONS-AC-01)_

- **FR-014**: Given a scoped key, when it calls outside its scopes or calls key-management, or when a cookie is presented to key-management, then the request MUST be rejected (the acceptance surface for the key-management boundary in FR-006/INV-06). _(Realizes: AUTH-SESSIONS-AC-02)_

- **FR-015**: Given an endpoint with no declared capability, when any request reaches it, then it MUST reject all requests (the acceptance surface for the fail-closed default in FR-005/INV-05). _(Realizes: AUTH-SESSIONS-AC-03)_

- **FR-016**: Given a revoked device key, when its bound cookie is presented on the next request, then the request MUST fail. _(Realizes: AUTH-SESSIONS-AC-04)_

- **FR-017 (planned, not implemented)**: Given only one `*` key remaining, when its revocation is attempted, then it MUST be refused (the acceptance surface for the anti-lockout invariant in FR-007/INV-07). _(Realizes: AUTH-SESSIONS-AC-05)_

- **FR-018**: Given a first connect with a raw `*` key, when the device is provisioned, then a `*` device key with no expiry MUST be minted and cookie-bound, and the response body MUST NOT contain the raw key. _(Realizes: AUTH-SESSIONS-AC-06)_

- **FR-019**: Given `verify-pin` with the correct PIN, when it is evaluated, then it MUST return match and MUST NOT create a session row anywhere. _(Realizes: AUTH-SESSIONS-AC-07)_

- **FR-020**: Given any backend authorization decision, when it is made, then it MUST NOT depend on PIN state (the acceptance surface for FR-002/INV-02; PIN is client-side only). _(Realizes: AUTH-SESSIONS-AC-08)_

### Key Entities

- **API key record**: the durable authorization credential. Attributes: scopes (`*`
  wildcard or a set of `domain:verb` capabilities), `expiresAt` (null for device keys),
  `revokedAt`, and a kind (bootstrap / device / integration). The sole backend
  authorization boundary; all key state lives in the database.
- **PIN record**: a single Argon2 hash of the client-side admin-UI gate, stored in the
  database and included in backups. Verified by the protected verify-pin endpoint; raw PINs are never
  persisted or returned.
- **API cookie**: an HttpOnly, Secure, SameSite=Lax cookie containing the raw device key. It is not separately signed; authorization validates the database key record on each request. Browser cookie removal does not revoke that record.
- **Frontend access-gate token**: a separate deployment-level secret controlling whether
  the app pages are served at all; covers page serving only, not `/api/*`.

## Success Criteria

- **SC-001**: With no credential configured, 100% of non-health endpoints return 401/403
  and `/health` remains the only reachable surface — in every environment.
- **SC-002 (planned, not implemented)**: Key-management is reachable by exactly one credential shape — a raw `*`
  header key — and rejects 100% of cookie and scoped-key attempts.
- **SC-003**: 0 session rows exist after any number of `verify-pin` calls, and toggling
  PIN state changes 0 backend authorization outcomes.

## Assumptions

- Fresh v2 data store; no legacy keys, sessions, or PINs are migrated (ADR-026). Fresh
  setup seeds one bootstrap `*` key (deployment config) + one frontend access-gate token
  (separate deployment secret).
- Credential concrete format/generation (`mpk-` prefix, CSPRNG, rate limiting) is owned
  by ADR-037; device-provisioning screen placement by ADR-036; restore behavior of key
  records and the PIN hash by ADR-017 (Backups).
- Connection-setup/admin route-guard _rendering_ is owned by Kiosk Shell & Navigation;
  this spec owns the unlock/provisioned _state_, not the screens.
- The PIN auto-relock duration is a configurable value with a sensible default (Open
  Decision carried into the Kiosk Shell grill).
