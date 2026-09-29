# ADR-013 PIN is a Client-Side UI Gate; No Server-Side Admin Sessions

Status: accepted
Owner: architecture / security
Decision date: 2026-06-27

## Decision

The PIN in v2 is a **client-side admin-UI gate**, not a security boundary. Its only purpose is to prevent a child standing at the kiosk from wandering into admin screens (settings, member management). The real security boundary is the API key (`ADR-007`).

### Rules

1. The backend stores a **single global PIN hash** (bcrypt) owned by the Auth domain. Raw PIN values are never persisted or returned.
2. The backend exposes `set-pin` and `verify-pin` endpoints. Both are protected by the API key, exactly like every other endpoint.
3. `verify-pin` returns only match / no-match. It does **not** create a server-side session, does **not** return a session token, and does **not** gate any other endpoint.
4. The server-side `sessions` table is **eliminated entirely**. There is no `x-session-id` header, no 24-hour admin session, and no server-side session expiry, cleanup, or logout.
5. On successful PIN verification, the **frontend** sets local "admin unlocked" UI state. This is pure UI state with no server counterpart. It re-locks on any of three triggers, with no grace period (a 6-digit PIN re-entry is cheap enough that no carry-over is warranted):
   - **Leaving admin:** navigating out of the admin route subtree re-locks immediately. The next person to touch the kiosk (likely a child) is not in admin.
   - **Inactivity:** after a configurable period without interaction inside admin (default ~5 min), it re-locks automatically — a safety net for an admin screen left open.
   - **Refresh / close:** reloading the page clears the unlock (ephemeral state).
     The inactivity timeout is a configurable UI parameter with a sensible default, and may later become a household App Setting.
6. The API-key → httpOnly signed cookie exchange is kept unchanged; that cookie is the real security boundary.

### Threat model (made explicit per peer review)

- **Attacker A — a child at the kiosk, no special access:** blocked from admin screens by the client-side PIN gate. They cannot call `verify-pin` in a brute-force loop in any meaningful way, because the admin screens they would reach are only UI; the data-mutating boundary is the API key.
- **Attacker B — anyone holding the API key (or its cookie):** already authorized for every backend operation. For this actor the PIN adds nothing, which is correct: the PIN was never meant to defend against someone with the API key.

Because `verify-pin` is itself behind the API key, brute-forcing the PIN requires already holding the API key — which already grants full access. Server-side PIN rate-limiting is therefore unnecessary. A light client-side throttle may remain for UX (slowing repeated wrong entries), but it is not a security control.

## Rationale

The legacy server-side `sessions` table (88 rows in production) only protected `/auth/session`, `/auth/logout`, and existing-PIN replacement. All broad feature and settings writes were already API-key-only. Under `ADR-007`, those three remaining operations also become API-key-gated, so the server session provides no additional capability beyond the cookie. Removing it is a correct simplification with no security regression (confirmed by peer review).

Verifying the PIN server-side (rather than purely client-side) centralizes the ground truth of the PIN across any browser or device that accesses the kiosk. A PIN change from any device with the cookie is immediately effective everywhere. A purely client-side PIN hash would produce stale state on other devices.

## Affected Specs

- [the auth sessions feature](../../features/auth-sessions.md) — entire session model, §2 ownership, §4 behaviors, §5 permissions
- the kiosk shell navigation feature (deferred) — admin route guard now keys on client unlock state, not a server session
- [the app settings registry feature](../../features/app-settings-registry.md) — settings admin UI gate is the client unlock, not a server session

## Data / Setup Implications

- Fresh v2 setup creates no session rows. There is no `sessions` table.
- A single record holds the global PIN hash. No legacy rows are migrated (`ADR-026`); first-run setup creates the PIN.
- **PIN hash lives in the database** (household state, not infrastructure config). It is therefore included in backups: restoring the household to an earlier point restores that point's PIN, which is the coherent behavior.
- **Forgotten-PIN recovery is deliberately simple:** any `*` key can reset the PIN via `set-pin` (raw `*` key in a header, callable from any non-kiosk device — e.g. a phone or laptop). There is no in-kiosk recovery flow because none is needed: the PIN never protected against someone holding the API key. Setting/replacing the PIN does not require knowing the current PIN; it requires a `*` key. The PIN is only a child-deterrent UI gate and must not be over-engineered into a security credential.

## Acceptance Criteria

- Given a valid API key, when a client calls `verify-pin` with the correct PIN, then the response indicates a match and no session row is created anywhere.
- Given a valid API key, when a client calls `verify-pin` repeatedly, then no server-side counter blocks the API key (rate-limiting is not a server concern here).
- Given a successful PIN verification, when the browser is refreshed, then the admin-unlock UI state is cleared (it is ephemeral client state).
- Given the admin attempts any backend write, then authorization depends only on the API key, never on PIN state.
- There is no `sessions` table, no `x-session-id` header, and no `/auth/session` or `/auth/logout` server session lifecycle in v2.

## Open Questions

- None. PIN hash storage (database) and recovery (`*`-key reset, no in-kiosk flow) resolved 2026-06-28. API-key/cookie and access-gate questions resolved in `ADR-030` and `ADR-031`.

## Traceability

- Conflicts: `CR-013`, `CR-007`
- Pre-v2: `ADR-013`, `ADR-007`
- Peer review: codex-peer-review blind-debate pass (2026-06-27) — confirmed no security regression; surfaced forgotten-PIN recovery and PIN-hash backup as operational gaps.
