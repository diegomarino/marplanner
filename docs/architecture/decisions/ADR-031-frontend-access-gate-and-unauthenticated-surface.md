# ADR-031 Frontend Access Gate Stays Separate; Unauthenticated API Surface is Health-Only

Status: accepted
Owner: architecture / security
Decision date: 2026-06-28

## Decision

### Frontend access gate

The product keeps the frontend access gate as a **separate deployment-level token**, distinct from the API key model. It gates whether a browser is served the application pages at all. It is a defense-in-depth outer layer.

- The access gate protects serving frontend routes only. It does **not** protect `/api/*`.
- Without a valid access-gate cookie, the server returns a minimal access-token entry form instead of the app shell.
- It is a deployment access control, not the PIN model and not the API key model. It has its own token and its own cookie.

### Unauthenticated API surface

The API surface reachable with **no credential at all** is **only liveness/readiness probes** (`/health` or equivalent).

- All settings reads and writes require a valid API key (cookie or header). The provisioned kiosk holds a key via its device cookie, so it reads settings without friction.
- No subset of settings is publicly readable. There is no unauthenticated settings endpoint.
- Bootstrap routes (device provisioning / key exchange) are reachable without a prior cookie, but they **authenticate the raw `*` key the human submits** — they are not "no credential" surface.
- The pre-provisioning connection-setup screen renders using the browser's language and a default timezone, converging to household settings once the device is provisioned and holds a key.

## Rationale

The legacy system had an inconsistent unauthenticated surface (some settings were readable before credentials in some paths). The product closes this: the only thing reachable without any credential is health.

Keeping the frontend access gate separate is a deliberate defense-in-depth choice. Because the gate does not cover `/api/*`, exposing any "public settings subset" would make those values genuinely public regardless of the gate — so the unauthenticated API surface is kept minimal instead. The connection-setup screen does not need server settings to render, so there is no functional reason to expose them.

## Affected Specs

- [the auth sessions feature](../../features/auth-sessions.md) — §4 frontend gate, §5 permissions, §11 quirk (gate returns 200 HTML)
- [the app settings registry feature](../../features/app-settings-registry.md) — settings reads require a key; no public subset
- the kiosk shell navigation feature (deferred) — pre-provisioning screen uses browser defaults

## Data / Setup Implications

- Fresh setup configures a frontend access-gate token alongside the bootstrap `*` API key. These are two distinct deployment secrets.
- The access-gate cookie and the API cookie are separate; passing the access gate does not authenticate API requests.

## Acceptance Criteria

- Given no access-gate cookie, when a browser requests a frontend page, then the server returns the access-token entry form, not the app shell.
- Given no API credential, when a client requests any `/api/*` endpoint other than health, then the backend returns 401/403.
- Given no API credential, when a client requests `/health`, then it succeeds.
- Given a valid access-gate cookie but no API key, when the app shell loads, then it shows the connection-setup screen and exposes no household settings.
- Given the pre-provisioning connection-setup screen, then it renders using the browser language and a default timezone without calling an authenticated settings endpoint.

## Open Questions

- Whether the access-gate token should itself gain lifecycle management like API keys, or remain a single static deployment token. Deferred; current decision is a single static token.

## Traceability

- Conflicts: `CR-007`, `CR-022`
- Related prior: `ADR-007`, `ADR-013`
