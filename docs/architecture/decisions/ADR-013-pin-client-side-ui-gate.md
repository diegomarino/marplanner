# ADR-013 PIN is a Client-Side UI Gate; No Server-Side Admin Sessions

Status: accepted (amended 2026-10-03 — PIN recovery and hash algorithm)
Owner: architecture / security
Decision date: 2026-06-27

> Note (2026-11-07): the PIN variable `ADMIN_PIN` was renamed to `MP_ADMIN_PIN`, matching the
> `MP_` prefix of every other app variable.

## Decision

The PIN is a **client-side admin-UI gate**, not a security boundary. Its only purpose is to prevent a child standing at the kiosk from wandering into admin screens (settings, member management). The real security boundary is the API key (`ADR-007`).

### Rules

1. The backend stores a **single global PIN hash** (**Argon2**) owned by the Auth domain. Raw PIN values are never persisted or returned.
2. The backend exposes **`verify-pin` only**. It is protected by the API key, exactly like every other endpoint. There is **no `set-pin` route** and none is planned: changing the advisory PIN is an **ops redeploy** (`MP_ADMIN_PIN` in the service environment, restart, then provision a browser again with the current bootstrap key so provisioning rewrites the DB hash). See [operations](../../operations.md).
3. `verify-pin` returns only match / no-match. It does **not** create a server-side session, does **not** return a session token, and does **not** gate any other endpoint.
4. The server-side `sessions` table is **eliminated entirely**. There is no `x-session-id` header, no 24-hour admin session, and no server-side session expiry, cleanup, or logout.
5. On successful PIN verification, the **frontend** sets local "admin unlocked" UI state. This is pure UI state with no server counterpart. It re-locks on these triggers, with no grace period (PIN re-entry is cheap enough that no carry-over is warranted):
   - **Leaving admin:** navigating out of the admin route subtree re-locks immediately (`AdminUnlockRouteReset` in the shell when the route is no longer admin). The next person to touch the kiosk (likely a child) is not in admin.
   - **Inactivity:** after a configurable period without interaction inside admin (default ~5 min), it re-locks automatically — a safety net for an admin screen left open.
   - **Explicit Lock** control in the admin chrome (immediate hand-back without waiting for idle).
   - **Refresh / close:** reloading the page clears the unlock (ephemeral state).
     The inactivity timeout is a configurable UI parameter with a sensible default, and may later become a household App Setting.
6. The API-key device credential in the HttpOnly cookie remains the real security boundary (`ADR-007` / `ADR-030`); the PIN never participates in backend authorization.

### Threat model (made explicit per peer review)

- **Attacker A — a child at the kiosk, no special access:** blocked from admin screens by the client-side PIN gate. They cannot call `verify-pin` in a brute-force loop in any meaningful way, because the admin screens they would reach are only UI; the data-mutating boundary is the API key.
- **Attacker B — anyone holding the API key (or its cookie):** already authorized for every backend operation. For this actor the PIN adds nothing, which is correct: the PIN was never meant to defend against someone with the API key.

Because `verify-pin` is itself behind the API key, brute-forcing the PIN requires already holding the API key — which already grants full access. Server-side PIN rate-limiting is therefore unnecessary. A light client-side throttle may remain for UX (slowing repeated wrong entries), but it is not a security control.

## Rationale

The legacy server-side `sessions` table (88 rows in production) only protected `/auth/session`, `/auth/logout`, and existing-PIN replacement. All broad feature and settings writes were already API-key-only. Under `ADR-007`, those three remaining operations also become API-key-gated, so the server session provides no additional capability beyond the cookie. Removing it is a correct simplification with no security regression (confirmed by peer review).

Verifying the PIN server-side (rather than purely client-side) centralizes the ground truth of the PIN across any browser or device that accesses the kiosk. After an ops PIN change (`MP_ADMIN_PIN` + restart + re-provision), every device uses the new hash on the next `verify-pin`. A purely client-side PIN hash would produce stale state on other devices.

## Affected Specs

- [the auth sessions feature](../../features/auth-sessions.md) — entire session model, §2 ownership, §4 behaviors, §5 permissions
- the kiosk shell navigation feature (deferred) — admin route guard now keys on client unlock state, not a server session
- [the app settings registry feature](../../features/app-settings-registry.md) — settings admin UI gate is the client unlock, not a server session

## Data / Setup Implications

- Fresh setup creates no session rows. There is no `sessions` table.
- A single record holds the global PIN hash. No legacy rows are migrated (`ADR-026`); first-run / each successful **device provisioning** writes the hash from `MP_ADMIN_PIN` (fallback `0000`).
- **PIN hash lives in the database** (household state, not infrastructure config). It is therefore included in backups: restoring the household to an earlier point restores that point's PIN, which is the coherent behavior.
- **Forgotten-PIN recovery is deliberately simple and ops-only:** set `MP_ADMIN_PIN` in the deployment environment, restart the service, and provision a browser again with the current bootstrap key. Provisioning stores the configured PIN as an Argon2 hash. There is no in-kiosk recovery flow and no `set-pin` API — the PIN never protected against someone holding the API key, and redeploying env is enough. Existing device API credentials remain valid; this procedure resets the UI PIN only.

## Acceptance Criteria

- Given a valid API key, when a client calls `verify-pin` with the correct PIN, then the response indicates a match and no session row is created anywhere.
- Given a valid API key, when a client calls `verify-pin` repeatedly, then no server-side counter blocks the API key (rate-limiting is not a server concern here).
- Given a successful PIN verification, when the browser is refreshed **or navigates out of the admin route subtree**, then the admin-unlock UI state is cleared (ephemeral client state).
- Given the admin attempts any backend write, then authorization depends only on the API key, never on PIN state.
- There is no `sessions` table, no `x-session-id` header, and no `/auth/session` or `/auth/logout` server session lifecycle.

## Open Questions

- None. PIN hash storage (database, Argon2), recovery (`MP_ADMIN_PIN` env + restart + re-provision; no `set-pin`), and leave-admin/idle/refresh/Lock re-lock are settled. API-key/cookie and access-gate questions resolved in `ADR-030` and `ADR-031`.

## Traceability

- Conflicts: `CR-013`, `CR-007`
- Related prior: `ADR-007`
- Peer review: codex-peer-review blind-debate pass (2026-06-27) — confirmed no security regression; surfaced forgotten-PIN recovery and PIN-hash backup as operational gaps.
- Amendment 2026-10-03 (step 02 access review): drop planned `set-pin`; recovery = env redeploy; hash algorithm Argon2; document shell leave-admin re-lock + explicit Lock.
