# ADR-007 API Key as the Backend Authorization Boundary; PIN is UI-Only

Status: accepted (narrowed by `ADR-030`)
Owner: architecture / security
Decision date: 2026-06-27

## Decision

The API key boundary is the sole backend authorization boundary for all settings reads, settings writes, and all other feature operations. The PIN is a UI-layer gate only — its purpose is to prevent casual or accidental access to admin UI screens. PIN state must never be evaluated by the backend as a required condition for any API endpoint.

Credential authority is bounded by declared capabilities (`ADR-030`), the household trust model and its documented carve-outs (`ADR-058`). Device `*` cookies carry household authority; arbitrary scoped issuance remains future integration work. Neither key scope nor transport may be inferred from PIN state.

`/health` is the root credential-free infrastructure endpoint (`ADR-031`/`ADR-059`). Household API operations require API credentials; frontend serving uses the separate access gate.

## Rationale

Encoding PIN enforcement in the backend API created a chicken-and-egg impossibility: the kiosk cannot read settings (timezone, language, printer configuration) needed to render correctly before the PIN is entered, but the backend requires a PIN session to return those settings. This forced inconsistent workarounds where some consumers (weather, auto-print) bypassed the PIN session requirement while others (AppSettingsProvider) gate-checked it — producing unpredictable cold-boot behavior depending on which consumer fetched first.

The PIN was never the right backend boundary. It is a household convenience mechanism to prevent family members from accidentally navigating into configuration screens. It carries no server-side secret-value or credentials-management semantics. That role belongs entirely to the API key.

## Scope

This decision resolves CR-007 (settings/admin write authorization) and partially resolves CR-022 (effective settings cold-boot read availability) from the App Settings Registry perspective.

The PIN lifecycle is resolved by **ADR-013**: verification unlocks client UI state, with no backend admin session; recovery uses operator configuration. This decision only establishes that whatever PIN mechanism Auth & Sessions defines must not be consulted by the backend for API endpoint authorization.

## Affected Specs

- [the app settings registry feature](../../features/app-settings-registry.md) — read/write authorization (§5, §11 quirks)
- [the auth sessions feature](../../features/auth-sessions.md) — PIN/session boundary
- the kiosk shell navigation feature (deferred) — cold-boot settings read
- the weather feature (deferred) — settings reads without session
- the printing feature (deferred) — printer settings reads at cold boot
- the time announcements feature (deferred) — settings reads before PIN unlock
- the backups feature (deferred) — admin write boundary

## Data / Setup Implications

Fresh setup configures a bootstrap credential; provisioning creates per-device keys (`ADR-030`/`ADR-032`). The advisory PIN hash exists, but there is no backend PIN session or admin session-token table (`ADR-013`). Arbitrary scoped issuance and key-management mutations remain future lifecycle work, as stated in the authentication contract.

## Acceptance Criteria

- Given a valid API key, when a client requests the settings map at cold boot (no PIN entered, no admin session), then it receives the complete effective settings map.
- Given a valid API key, when a client submits a settings write, then the backend accepts or rejects based on API credential validity and the declared capability, never PIN state.
- Given no API key, when a client requests any endpoint other than liveness probes, then the backend returns 401/403 regardless of PIN state.
- Given a valid API key, when a client enters or skips the PIN, then the backend response to any endpoint is identical.

## Traceability

- Conflicts: `CR-007`, `CR-022`
- Related prior: `ADR-007`, `ADR-013`
