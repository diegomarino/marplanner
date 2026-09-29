# Auth & Sessions Domain Contract

Status: maintained contract
Depends on decisions: `ADR-001`, `ADR-007`, `ADR-013`, `ADR-030`, `ADR-031`, `ADR-032`, `ADR-033`, `ADR-036`, `ADR-037`, `ADR-040`

> Credential concrete format and generation (`mpk-` prefix, CSPRNG, diceware, failure-based rate limiting) are specified in `ADR-037`. Device-provisioning screen placement is `ADR-036`. These decisions define the credential and provisioning boundaries.

## Delivered interface boundary

The installed API provides device provisioning and PIN verification. Key create/list/revoke, last-key anti-lockout, `set-pin`, and server-side cookie revocation are planned interfaces, not implemented routes. Their identifiers below preserve the extension contract and do not claim delivered behavior. See [operations](../../operations.md) for the current credential and PIN recovery limits.

## Purpose

Auth & Sessions owns the credentials and boundaries that protect the household deployment: the API key authorization model, the PIN admin-UI gate, and the frontend access gate. It defines what is reachable with which credential, and how credentials are established, validated, and retired.

It does not own member identity (Members), route structure or the admin-unlock UI (Kiosk Shell), or which capability each endpoint requires (each domain declares its own).

## Vocabulary

**API key** — a credential authorizing backend operations. Each key has capability scopes. A `*` key authorizes everything; a scoped key authorizes only its `domain:verb` capabilities.

**Scope** — `domain:verb` where `domain` is a `ADR-029` domain and `verb` is `read` | `write` | `admin`. `*` is the wildcard.

**Device key** — a `*` key minted by the UI provisioning flow, bound to a device's httpOnly cookie, never exposed as a raw value.

**Integration key** — a header credential. Startup reconciles `MP_MANAGEMENT_KEY` into a management-scoped integration record; arbitrary scoped key issuance has no installed endpoint.

**Bootstrap key** — the first `*` key on a fresh deployment, established from a deployment-provided config value.

**PIN** — a client-side admin-UI gate (child deterrent). Not a security boundary.

**Frontend access gate** — a separate deployment-level token controlling whether the app pages are served at all.

**API cookie** — an HttpOnly, Secure, SameSite=Lax cookie containing a raw device key. The cookie is not separately signed; each request hashes the key and validates its database record.

## Invariants

- **AUTH-SESSIONS-INV-01** The API key is the sole backend authorization boundary. A key's authority is bounded by its scopes.
- **AUTH-SESSIONS-INV-02** The PIN never authorizes backend operations. The protected verify-pin endpoint checks its hash; admin-unlocked state exists only in the client.
- **AUTH-SESSIONS-INV-03** There is no server-side session table, no `x-session-id`, and no server session lifecycle.
- **AUTH-SESSIONS-INV-04** Enforcement is **fail-closed in every environment**. No code path disables or relaxes auth based on environment. A missing credential locks the deployment (only `/health` reachable), never opens it.
- **AUTH-SESSIONS-INV-05** An endpoint that does not declare a required capability rejects all requests (fail-closed default).
- **AUTH-SESSIONS-INV-06 (planned, not implemented)** Key management (create/list/revoke) requires a `*` key presented as a raw header value; never a cookie; never delegable to a scoped key.
- **AUTH-SESSIONS-INV-07 (planned, not implemented)** The system refuses to revoke or expire the last active `*` key (anti-lockout).
- **AUTH-SESSIONS-INV-08** **Single household trust tier (`ADR-058`).** There is **no second server-side privilege tier** by design. A provisioned device's `*` cookie is full household trust; kiosks and parent-admin-via-PIN both operate here. The **sole** server-side kiosk/operator boundary is **key-management** (the line above — the one self-escalating catastrophic act); `ADR-053` device-block is the lone pre-existing extra carve-out. All other operations (backups, plugins, telemetry-read, settings) are household-tier (device-`*` cookie + client-side PIN), reversible/recoverable. **Anti-pattern: no ad-hoc per-endpoint "admin scope" carve-outs** — a future op that seems to need one is a signal to re-examine the threat model, not to add a tier.
- **AUTH-SESSIONS-INV-09** Every authenticated request validates the credential AND that the referenced key record is active (not revoked, not expired). Revocation/expiry take effect on the next request.
- **AUTH-SESSIONS-INV-10** Raw key values: device keys are never exposed; future generated integration keys must be shown exactly once at creation; current management keys are supplied through deployment configuration. Raw PINs are never persisted or returned.
- **AUTH-SESSIONS-INV-11** All auth state lives in the database. No auth state in process memory.
- **AUTH-SESSIONS-INV-12** Telemetry/logs must never contain raw PINs, API keys, cookies, or access-gate tokens (`ADR-016`).

## Behaviors

**Establish the bootstrap key.** On startup, if the deployment config provides a bootstrap value and no matching active `*` key record exists, the system seeds a `*` key record for it. Deployment-agnostic: the config value is an environment variable / secret, with no hosting-platform coupling.

**Provision a device.** In connection-setup (no valid cookie), a human submits a raw `*` key. The server mints a new `*` device key (`expiresAt = null`), binds the httpOnly API cookie to it, and never returns the raw device key. The same bootstrap key may provision multiple devices.

**Bootstrap retirement (not implemented).** Removing the environment value stops new provisioning, but the persisted key remains usable for authorized API requests. There is no retirement endpoint or last-key guard.

**Integration setup.** Startup reconciles the operator-provided `MP_MANAGEMENT_KEY`. A create/list/revoke management endpoint is not implemented; the future issuance contract requires showing generated raw keys only once.

**Authorize a request.** The middleware resolves the presented credential (cookie or raw header key) to a key record, verifies it is active, and checks it carries the capability the endpoint declares (or `*`). Otherwise 401/403.

**Revocation enforcement and rotation limits.** Request authorization rejects records with `revokedAt` or an elapsed expiry. This enforcement exists, but there is no supported API to mutate revocation or rotate keys. Changing environment values does not revoke old records; last-key anti-lockout is not implemented.

**Initialize / verify the PIN.** Each successful provisioning hashes `ADMIN_PIN` (fallback `0000`) with Argon2 and updates the database PIN. `verify-pin` is API-key protected and returns match/no-match without granting authority. There is no `set-pin` endpoint. The hash is included in backups.

**Admin unlock (client-side).** On successful `verify-pin`, the frontend sets ephemeral "admin unlocked" UI state with an inactivity relock timeout. Browser refresh clears it. No server counterpart.

**Reset a forgotten PIN.** Configure `ADMIN_PIN`, restart and provision a browser with the current bootstrap key. There is no dedicated PIN-reset route or in-kiosk recovery flow.

**Gate frontend pages.** Without a valid access-gate cookie, the server serves the access-token entry form instead of the app shell. The gate covers page serving only, not `/api/*`. Misconfiguration fails closed (does not serve the app open).

**API cookie.** Provisioning with the configured bootstrap credential creates a device key and places it in the protected cookie. Clearing browser storage removes the local cookie but does not revoke the database key. No server-side cookie-revocation endpoint is installed.

## Interfaces

Implemented interfaces:

- Provision device (connection-setup): raw `*` key → device key + bound cookie.
- Planned: issue integration key with one-time raw output.
- Planned: list / revoke keys with raw-header authorization.
- Authorize request: credential + endpoint capability → allow / deny.
- Verify PIN; provisioning initializes or replaces it from configuration.
- Provisioning sets the API cookie; server-side revocation is planned.
- Frontend access-gate submission.
- Liveness/readiness probe (only unauthenticated surface).

## Events

(ADR-040.) **Emits: none. Subscribes: none.** Auth is a **pull / request-time** model, not
a bus participant. Revocation and expiry take effect because **every request re-validates
the key record** (active, not revoked, not expired) — not via a broadcast notification, so
there is no `key.revoked` event to drop or race. All auth state lives in the database
(no in-memory auth state, no push). This non-participation is deliberate and fail-closed:
authority is decided at the boundary on each call, never cached off an event.

## Data / Setup Contract

- Fresh setup: one bootstrap `*` key (deployment config) + one frontend access-gate token (separate deployment secret). No legacy keys, sessions, or PINs are migrated (`ADR-026`).
- Key records, the PIN hash, and related auth state live in the database and are included in backups. Detailed restore behavior is owned by `ADR-017` (Backups).
- Dev/local ships a pre-seeded known bootstrap key in example config so development is convenient without any auth bypass.

## Acceptance Criteria

- **AUTH-SESSIONS-AC-01** No credential configured (any environment) → every non-health endpoint returns 401/403; the deployment is locked, never open.
- **AUTH-SESSIONS-AC-02** A scoped key calling outside its scopes, or calling key-management, or presented via cookie to key-management → rejected.
- **AUTH-SESSIONS-AC-03** An endpoint with no declared capability → rejects all requests.
- **AUTH-SESSIONS-AC-04** Revoking a device key → its cookie fails on the next request.
- **AUTH-SESSIONS-AC-05 (planned, not implemented)** Only one `*` key remaining → revocation refused.
- **AUTH-SESSIONS-AC-06** First connect with a raw `*` key → a `*` device key (no expiry) is minted and cookie-bound; no raw key in the response body.
- **AUTH-SESSIONS-AC-07** `verify-pin` with the correct PIN → match, and no session row is created anywhere.
- **AUTH-SESSIONS-AC-08** Backend authorization never depends on PIN state.

## Open Decisions

- **PIN auto-relock timeout (UI/UX).** The contract fixes "ephemeral client-side unlock with an inactivity relock timeout" but not the duration. Resolve as a configurable value with a sensible default; consider a future household App Setting object. → **carried into the Kiosk Shell & Navigation grill.**
- **Provisioning / connection-setup screen UX and admin route-guard UX.** Auth defines the unlock/provisioned _state_; how the screens render, navigate, and redirect is owned by **Kiosk Shell & Navigation**. → **carried into the Kiosk Shell & Navigation grill.**
- **`admin` verb semantics per domain.** Each domain that offers `domain:admin` documents what it authorizes. → resolved in each domain's grill.
- **Credential/key behavior on backup restore.** → `ADR-017` (Backups).
- **Telemetry secret-redaction enforcement.** → `ADR-016` (Telemetry).
