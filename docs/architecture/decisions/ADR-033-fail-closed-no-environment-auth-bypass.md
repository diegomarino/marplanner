# ADR-033 Fail-Closed Always; No Environment-Conditional Auth Bypass

Status: accepted
Owner: architecture / security
Decision date: 2026-06-28

## Decision

API authorization enforcement is **fail-closed in every environment**. There is **no code path that disables or relaxes API-key validation based on the runtime environment** (`NODE_ENV`, a "dev mode" flag, the presence/absence of a configured key, or any equivalent).

### Rules

1. **No credential configured → locked, not open.** If no bootstrap key is configured and no active `*` key record exists, every endpoint except liveness/readiness (`/health`) rejects all requests with 401/403. The system is inert and unusable until a bootstrap key is provided — it is never open.
2. **No environment-conditional bypass.** Enforcement is byte-for-byte identical in development, staging, and production. There is no "if not production, skip auth" branch. Misconfiguring the environment can only ever make the system _more_ locked, never open.
3. **Development convenience without a bypass.** Local development remains convenient by shipping a **pre-seeded, well-known dev bootstrap key** in example configuration (e.g. `.env.example`, a compose file). Dev is fail-closed too — it simply ships with the key already filled in. The enforcement code does not know or care that it is running in dev.

## Rationale

The legacy system failed startup in production when the API key was missing (fail-closed) but **disabled API-key validation entirely outside production** (fail-open dev mode). That environment-conditional fallback is a critical footgun: if a production deployment is ever misevaluated as non-production — a misset `NODE_ENV`, a container missing the environment variable, a platform that does not inject the expected env — the validation silently switches off and the deployment is exposed to the internet with no credential required.

Discovered during the Auth & Sessions grill (2026-06-28) while reasoning about "what happens if the bootstrap key is not set." The correct behavior is that a missing credential produces a _locked_ deployment (immediately and obviously unusable), never an _open_ one (silently exposed, unnoticed until exploited). Removing the environment branch entirely is the only way to guarantee a misconfiguration cannot flip the system open.

## Affected Specs

- [the auth sessions feature](../../features/auth-sessions.md) — §3 (API key disabled in dev), §6 (API key missing outside production), §11 quirks
- [the app settings registry feature](../../features/app-settings-registry.md) — all reads/writes depend on this enforcement default

## Data / Setup Implications

- Fresh deploy with no bootstrap configured: locked. The operator must provide the bootstrap key (`ADR-032`) to gain access.
- Dev/local: example config ships a known dev bootstrap key so developers are not blocked, without any code-level bypass.
- The frontend access gate (`ADR-031`) follows the same principle: misconfiguration must not serve the app open; it should fail closed.

## Acceptance Criteria

- Given no bootstrap key and no `*` key record, when any non-health endpoint is called in any environment, then the response is 401/403.
- Given the runtime environment is changed (e.g. `NODE_ENV` unset or set to a non-production value), when the API handles a request, then enforcement behavior is unchanged — no validation is skipped.
- Given a code search for environment-conditional auth branches, then none exist (no `if (env !== 'production') skipAuth` or equivalent).
- Given a local dev checkout using example config, then a pre-seeded dev bootstrap key is present and the developer can provision without disabling auth.

## Open Questions

- None.

## Traceability

- Related prior: `ADR-007`, `ADR-013`
- Related: `ADR-030` (enforcement model, fail-closed capability default), `ADR-031` (access gate), `ADR-032` (bootstrap)
- Discovered: Auth & Sessions grill, 2026-06-28 — "what if the bootstrap key is not sent — are you exposed to the internet?"
