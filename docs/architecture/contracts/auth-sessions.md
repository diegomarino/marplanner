# Auth & Sessions Domain Contract

Status: maintained contract
Depends on decisions: `ADR-001`, `ADR-007`, `ADR-013`, `ADR-030`, `ADR-031`, `ADR-032`, `ADR-033`, `ADR-036`, `ADR-037`, `ADR-040`

> Credential concrete format and generation (`mpk-` prefix, CSPRNG, diceware, failure-based rate limiting) are specified in `ADR-037`. Device-provisioning screen placement is `ADR-036`. These decisions define the credential and provisioning boundaries.

## Delivered interface boundary

The installed API provides device provisioning and PIN verification. **Key create/list/revoke, last-key anti-lockout, and server-side cookie revocation are out of scope for this household release** (ops recovery only — see [operations](../../operations.md)). **`set-pin` is not planned:** replace the advisory PIN by setting `ADMIN_PIN`, restarting, and provisioning a browser again. Deferred multi-integration identifiers below do not claim delivered behavior.

## Purpose

Auth & Sessions owns the credentials and boundaries that protect the household deployment: the API key authorization model, the PIN admin-UI gate, and the frontend access gate. It defines what is reachable with which credential, and how credentials are established, validated, and retired.

It does not own member identity (Members), route structure or the admin-unlock UI (Kiosk Shell), or which capability each endpoint requires (each domain declares its own).

## Vocabulary

**API key** — a credential authorizing backend operations. Household device keys are minted with scope `*` (full household trust, `ADR-058`). For this family deployment, access to a feature means full use of that feature — not a per-user read/write split on the kiosk. Scoped `domain:verb` keys remain a valid extension shape for future non-kiosk integrations.

**Scope** — `*` (household device default) or `domain:verb` where `domain` is a `ADR-029` domain and `verb` is `read` | `write` | `admin`. Where a route declares a capability, a live `*` key satisfies it.

**Device key** — a `*` key minted by the UI provisioning flow, bound to a device's httpOnly cookie, never exposed as a raw value.

**Integration / management key** — operator credential from `MP_MANAGEMENT_KEY` reconcile (`kind=integration`). **Transport:** Bearer is admitted only on `/api/plugins*`. Other API routes use the **cookie** path, not a general Bearer on every route. Arbitrary scoped key issuance has no installed endpoint.

**Bootstrap key** — the first `*` key on a fresh deployment, established from a deployment-provided config value.

**PIN** — a client-side admin-UI gate (child deterrent). Not a security boundary.

**Frontend access gate** — a separate deployment-level token controlling whether the app pages are served at all.

**API cookie** — an HttpOnly, Secure, SameSite=Lax cookie containing a raw device key. The cookie is not separately signed; each request hashes the key and validates its database record.

## Invariants

- **AUTH-SESSIONS-INV-01** The API key is the sole backend authorization boundary. A key's authority is bounded by its scopes.
- **AUTH-SESSIONS-INV-02** The PIN never authorizes backend operations. The protected verify-pin endpoint checks its hash; admin-unlocked state exists only in the client.
- **AUTH-SESSIONS-INV-03** There is no server-side session table, no `x-session-id`, and no server session lifecycle.
- **AUTH-SESSIONS-INV-04** Enforcement is **fail-closed in every environment**. No code path disables or relaxes auth based on environment. A missing credential locks the deployment (only `/health` reachable), never opens it.
- **AUTH-SESSIONS-INV-05 (household calibration)** Capability checks apply where routes register them (`requireCapability` / full-access / management helpers). Household kiosk traffic uses device `*` after the live-key boundary; access to a feature ⇒ full use of that feature (`ADR-058`). An app-wide audit that every `/api/*` route declares a capability or is explicitly exempt is later quality work, not a release blocker. Registration helpers still fail closed when those helpers are used without a capability.
- **AUTH-SESSIONS-INV-06 (deferred, not this release)** If key management (create/list/revoke) is ever added, it MUST require a `*` key as a raw header value; never a cookie; never delegable to a scoped key.
- **AUTH-SESSIONS-INV-07 (deferred, not this release)** If revoke/expire mutations are ever added, the system MUST preserve the last operator-usable raw `*` credential (anti-lockout); device cookies do not satisfy this requirement. Bootstrap retirement additionally requires a retained replacement admitted for future device provisioning (`ADR-030`/`ADR-032`).
- **AUTH-SESSIONS-INV-08** **Single household trust tier (`ADR-058`).** There is **no second server-side privilege tier** by design. A provisioned device's `*` cookie is full household trust; kiosks and parent-admin-via-PIN both operate here. The **sole** server-side kiosk/operator boundary is **key-management** (the line above — the one self-escalating catastrophic act); the former `ADR-053` device-block carve-out was removed 2026-10-15 (network devices are household-tier). All other operations (backups, plugins, telemetry-read, settings) are household-tier (device-`*` cookie + client-side PIN), reversible/recoverable. **Anti-pattern: no ad-hoc per-endpoint "admin scope" carve-outs** — a future op that seems to need one is a signal to re-examine the threat model, not to add a tier.
- **AUTH-SESSIONS-INV-09** Every authenticated request validates the credential AND that the referenced key record is active (not revoked, not expired). Revocation/expiry take effect on the next request.
- **AUTH-SESSIONS-INV-10** Raw key values: device keys are never exposed; future generated integration keys must be shown exactly once at creation; current management keys are supplied through deployment configuration. Raw PINs are never persisted or returned.
- **AUTH-SESSIONS-INV-11** Credential and authorization state lives in the database; no in-memory sessions or cached authority. Transient failed-attempt counters (ADR-037) are not authentication state and never grant access.
- **AUTH-SESSIONS-INV-12** Telemetry/logs must never contain raw PINs, API keys, cookies, or access-gate tokens (`ADR-016`).

## Behaviors

**Establish the bootstrap key.** On startup, if the deployment config provides a bootstrap value and no matching active `*` key record exists, the system seeds a `*` key record for it. Deployment-agnostic: the config value is an environment variable / secret, with no hosting-platform coupling.

**Provision a device.** In connection-setup (no valid cookie), a human submits a raw `*` key. The server mints a new `*` device key (`expiresAt = null`), binds the httpOnly API cookie to it, and never returns the raw device key. The same bootstrap key may provision multiple devices.

**Bootstrap retirement (not this release).** Removing the environment value stops new provisioning, but the persisted key remains usable for authorized API requests. There is no retirement endpoint or last-key guard.

**Integration setup.** Startup reconciles `MP_MANAGEMENT_KEY`. No create/list/revoke API in this release.

**Authorize a request.** The boundary resolves the credential: **cookie** on general `/api/*`, or **Bearer** only under `/api/plugins*`. It verifies the key record is active. Routes that register capability/full-access/management preHandlers apply those next; other household routes authorize any live device `*` admitted by the boundary. Missing/invalid credentials → 401/403 or failure-only 429 (ADR-037); capability denials do not consume backoff.

**Revocation enforcement.** Authorization rejects `revokedAt` or elapsed expiry (`expires_at <= now` is inactive). No API mutates revocation or rotates keys; the offline operator command `devices` (`src/server/auth/devices-cli.ts`, shipped as `dist/server/devices.js`) lists credentials and sets `revoked_at`, refusing only the configured `MP_BOOTSTRAP_KEY` row that startup re-activates. Env changes do not revoke old rows. Clearing browser cookies does not delete database keys.

**Initialize / verify the PIN.** Each successful provisioning hashes `ADMIN_PIN` (fallback `0000`) with Argon2 and updates the database PIN. `verify-pin` is API-key protected and returns match/no-match without granting authority. There is no `set-pin` endpoint and none is planned. The hash is included in backups.

**Admin unlock (client-side).** On successful `verify-pin`, the frontend sets ephemeral "admin unlocked" UI state. It clears on leaving the admin route subtree, inactivity timeout, explicit Lock, or browser refresh. No server counterpart.

**Reset a forgotten PIN.** Configure `ADMIN_PIN`, restart and provision a browser with the current bootstrap key. There is no dedicated PIN-reset route or in-kiosk recovery flow.

**Gate frontend pages.** Without a valid access-gate cookie, the server serves the access-token entry form instead of the app shell. The gate covers page serving only, not `/api/*`. Misconfiguration fails closed (does not serve the app open).

**API cookie.** Provisioning with the configured bootstrap credential creates a device key and places it in the protected cookie. Clearing browser storage removes the local cookie but does not revoke the database key. No server-side cookie-revocation endpoint is installed.

## Failure-only authentication backoff

The API and bootstrap flows have separate source buckets; API failures aggregate across installed
routes. Defaults are 20 failures/1 minute for API credentials and 5 failures/10 minutes for bootstrap.
Fixed windows start at the first failure and exclude the upper endpoint. The threshold-reaching
failure returns 429; later eligible failures double cooldowns through 1, 2, 4, 8, 16, 32, 60 seconds.
Failures within cooldown do not extend it or escalate it. All failures, including those during
cooldown, refresh the 15-minute quiet-reset clock. Successful authentications neither consume nor
reset failure buckets, and active valid credentials always continue through the normal checks.

429 carries integer-second `Retry-After` rounded up, `Cache-Control: no-store`, and a generic
`{error: "too_many_requests", message: "Authentication retry required"}` body. Earlier failures
retain 401/403. Missing/unknown/revoked/expired credentials count; conflicting transports,
capability denials, request validation, unknown routes and server misconfiguration do not.
Provisioning consumes only its bootstrap bucket. Expiry at the current instant is inactive.

The store is bounded to 5000 source/flow entries, prunes 15-minute-idle state on failure updates,
and evicts least-recently-failed entries at capacity. It is process-local and not restored from
backups: eviction or restart resets counters. These are provisional defaults, not measured
protection guarantees. Sources use direct transport `request.ip`, normalize IPv4-mapped IPv6
and canonical IPv6 spelling, and ignore forwarding headers without enabling proxy trust.
NAT/proxy pooling, IPv6 address rotation and distributed sources limit per-address protection.

Validation runs before backoff: ignored 429s still incur credential work and a correct guess
succeeds. This is cooperative retry backpressure, not a hard brute-force/CPU ceiling. Successful
provisioning volume, edge controls, distributed stores and hard bootstrap lockout are separate
policy decisions. The client preserves provisioning on 429, exposes the server's retry delay
without inventing one when absent/malformed, and offers manual retry without an automatic loop.

## Interfaces

Implemented interfaces:

- Provision device (connection-setup): raw `*` key → device key + bound cookie.
- Authorize request: live key via cookie (general API) or Bearer (`/api/plugins*` only); optional capability/management preHandlers where registered.
- Verify PIN; provisioning initializes or replaces it from configuration.
- Provisioning sets the API cookie; server-side revocation API is not in this release.
- Frontend access-gate submission.
- Liveness/readiness probe (only unauthenticated surface).

## Events

(ADR-040.) **Emits: none. Subscribes: none.** Auth is a **pull / request-time** model, not
a bus participant. Revocation and expiry take effect because **every request re-validates
the key record** (active, not revoked, not expired) — not via a broadcast notification, so
there is no `key.revoked` event to drop or race. Credential authority lives in the database
(no in-memory sessions or cached authority, no push); transient backoff counters are not credentials. This non-participation is deliberate and fail-closed:
authority is decided at the boundary on each call, never cached off an event.

## Data / Setup Contract

- Fresh setup: one bootstrap `*` key (deployment config) + one frontend access-gate token (separate deployment secret). No legacy keys, sessions, or PINs are migrated (`ADR-026`).
- Key records, the PIN hash, and related auth state live in the database and are included in backups. Detailed restore behavior is owned by `ADR-017` (Backups).
- Dev/local ships a pre-seeded known bootstrap key in example config so development is convenient without any auth bypass.

## Acceptance Criteria

- **AUTH-SESSIONS-AC-01** No credential configured (any environment) → every non-health endpoint returns 401/403; the deployment is locked, never open.
- **AUTH-SESSIONS-AC-02** A scoped key outside its granted capabilities is rejected where capability preHandlers run. Device `*` satisfies household feature routes, including network devices.
- **AUTH-SESSIONS-AC-03** Capability registration helpers fail closed when used without a capability. Household routes without per-route capability still require a live API key (AC-01); they are not unauthenticated.
- **AUTH-SESSIONS-AC-04** A device key marked revoked or expired in the database fails on the next request (enforcement exists; no operator revoke API in this release).
- **AUTH-SESSIONS-AC-05 (deferred)** Only if revoke mutations ship: last operator-usable raw `*` credential → revocation/expiry refused, even when device `*` keys remain; retirement preserves future provisioning access.
- **AUTH-SESSIONS-AC-06** First connect with a raw `*` key → a `*` device key (no expiry) is minted and cookie-bound; no raw key in the response body.
- **AUTH-SESSIONS-AC-07** `verify-pin` with the correct PIN → match, and no session row is created anywhere.
- **AUTH-SESSIONS-AC-08** Backend authorization never depends on PIN state.

## Open Decisions

- **PIN auto-relock timeout (UI/UX).** The contract fixes "ephemeral client-side unlock with an inactivity relock timeout" but not the duration. Resolve as a configurable value with a sensible default; consider a future household App Setting object. → **carried into the Kiosk Shell & Navigation grill.**
- **Provisioning / connection-setup screen UX and admin route-guard UX.** Auth defines the unlock/provisioned _state_; how the screens render, navigate, and redirect is owned by **Kiosk Shell & Navigation**. → **carried into the Kiosk Shell & Navigation grill.**
- **`admin` verb semantics per domain.** Each domain that offers `domain:admin` documents what it authorizes. → resolved in each domain's grill.
- **Credential/key behavior on backup restore.** → `ADR-017` (Backups).
- **Telemetry secret-redaction enforcement.** → `ADR-016` (Telemetry).
