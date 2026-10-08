# ADR-059 Serving & API-Boundary Reconciliation

Status: accepted
Owner: architecture
Decision date: 2026-07-04
Peer-reviewed: yes (codex blind-debate, 2026-07-04 — critical finding folded: the access gate
cannot be deferred; Constitution II is non-negotiable)

## Context

The initial bootstrap implemented its auth boundary as a single app-wide
API-key deny hook and never assembled a runnable, client-serving deployment: routes were bare
(no `/api`), the SPA was never built or served (`dev`/`build` scripts were stubs; no `start`),
the entrypoint guard (`import.meta.main`) never fired under `tsx`, and the ADR-031 access gate
was absent. The critical-flow browser test required the running app and made
all of this due at once. This ADR reconciles the bootstrap with the already-accepted architecture
(ADR-031, ADR-055, ADR-056); it decides sequencing and minimal scope, not new topology.

## Reconciliation (2026-10-08)

The bootstrap sequencing and minimal API described below are historical. Runtime `BASE_PATH` injection and mounted client/API routes are now implemented as recorded in `ADR-055`/`ADR-056` and the `ADR-060` mount amendment. Their built-browser/container acceptance is separate evidence; `BASE_PATH` is no longer an unimplemented bootstrap follow-up.

## Decision

1. **API-key boundary scope.** The API-key deny hook covers **exactly `/api/*`**. Frontend
   routes (the SPA shell, assets, the SPA catch-all) are NOT subject to the API-key boundary —
   they are governed by the access gate (ADR-031's two-boundary split, which the app-wide hook
   had conflated). Within `/api/*` no route is credential-free; `POST /api/auth/provision` is
   reachable without a _prior cookie_ but authenticates the submitted raw key (ADR-031).
2. **`/health` stays at the root path.** It is NOT migrated under `/api`. Every accepted
   artifact (ADR-031, ADR-033, the [authentication contract](../contracts/auth-sessions.md) and [feature behavior](../../features/auth-sessions.md),
   Constitution II) names `/health` as the sole credential-free surface; keeping it at root
   preserves those statements literally and keeps infra probes trivial.
3. **All other API routes migrate under `/api` now** (ADR-056), before the e2e:
   `/api/auth/provision`, `/api/auth/verify-pin`, `/api/settings`, `/api/members`. The client
   calls relative `/api` via an `apiBase()` helper. `BASE_PATH` runtime injection (ADR-056) was outside the initial bootstrap and is now implemented; see the reconciliation above.
4. **The bootstrap includes a minimal access gate.** A single static deployment token
   (`MP_ACCESS_TOKEN` env, fail-closed: unset ⇒ the gate cannot be passed): with no gate
   cookie, any frontend request receives the minimal access-token entry form (200) — never the
   shell, never a 401. Submitting the correct token sets a dedicated httpOnly gate cookie,
   distinct from the device-key cookie; passing the gate authenticates no `/api` request.
   Token lifecycle management (rotation etc.) remains deferred to authentication lifecycle work, per
   ADR-031's own open question. _Deferring the gate itself was considered and rejected:_
   serving the shell ungated would make it an unauthenticated surface, violating Constitution
   II ("the only unauthenticated surface is health-check endpoints" — NON-NEGOTIABLE) and
   KIOSK-SHELL-NAVIGATION-INV-07, and no constitutional override mechanism exists.
5. **Fastify serves the built SPA same-origin** (ADR-055): `@fastify/static` over the Vite
   build output plus an explicit SPA catch-all for non-`/api` GETs (behind the gate).
6. **Runnable-process fixes.** The server entrypoint uses the standard ESM idiom
   (`process.argv[1] === fileURLToPath(import.meta.url)`) — `import.meta.main` is undefined
   under `tsx`; the file exports helpers, so an unconditional `main()` would fire on import.
   The server bundle (esbuild) marks native modules (`argon2`, `better-sqlite3`) as externals.

## Consequences

- Runtime assembly and the access gate precede the critical-flow browser test. Its
  assertions cover: gate → provision → PIN unlock → member create → real
  process restart → device key survives → member re-read via `GET /api/members` (minimal read
  endpoint proves SC-003 through the product API, not only at store level).
- The bootstrap requirements FR-001/FR-002 adopt the two-boundary model (this ADR); the
  boundary ledger keeps all dispositions unchanged (guarantee→spec coverage did not move) with
  `note:` annotations pointing here.
- Full member management (list UI, etc.) remains separate feature work; `GET /api/members`
  is deliberately minimal.

## Process lesson

Every feature must start with a **runnable skeleton** — boots as a real process, serves the
shell, one smoke path through the stack — instead of discovering assembly debt at e2e time.
The initial bootstrap sequenced assembly last; the cost surfaced as this reconciliation.

## Acceptance Criteria

- Given no access-gate cookie, when a browser requests any frontend route, then it receives the
  access-token entry form (200), never the app shell and never a 401.
- Given `MP_ACCESS_TOKEN` is unset, then no token submission passes the gate (fail-closed).
- Given a valid gate cookie and no device cookie, when the shell loads, then the provisioning
  screen renders from browser defaults without calling an authenticated settings endpoint.
- Given no API credential, when a client requests any `/api/*` route, then it receives 401/403;
  when it requests root `/health`, then it succeeds.
- Given a provisioned device after a real server-process restart, then `GET /api/members`
  (key-authorized) returns the member created before the restart.

## Traceability

- Extends: `ADR-031` (implements its two-boundary split + minimal gate; lifecycle still open),
  `ADR-033` (fail-closed), `ADR-055` (same-origin serving), `ADR-056` (`/api` rule; `BASE_PATH`
  follow-up), `ADR-036` (provisioning screen placement).
- Constitution: Principle II (fail-closed, health-only unauthenticated surface) — satisfied,
  not waived.
- Guarantees touched (dispositions unchanged): `AUTH-SESSIONS-INV-01`, `AUTH-SESSIONS-INV-04`,
  `KIOSK-SHELL-NAVIGATION-INV-07`, `KIOSK-SHELL-NAVIGATION-AC-01`.
