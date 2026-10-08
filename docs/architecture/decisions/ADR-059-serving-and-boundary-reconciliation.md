# ADR-059 Same-Origin Serving and API Boundaries

Status: accepted
Owner: architecture
Decision date: 2026-07-04

## Context

The household kiosk needs two independent boundaries: an access gate for frontend
serving and API credentials for household operations. The runtime must assemble a
built SPA and server into one runnable product, including subpath deployments.

## Decision

1. Fastify serves the built React/Vite SPA and assets from the same origin.
   Frontend requests pass the access gate; they do not use the API-key deny hook.
2. Household API routes live under the configured mount's `/api` path. They require
   API credentials; provisioning validates the submitted bootstrap credential
   without requiring a prior device cookie. Root `/health` remains credential-free
   and is not relocated under `/api` or `BASE_PATH`.
3. The frontend gate uses configured `MP_ACCESS_TOKEN` and its own protected cookie.
   Without a valid gate cookie, frontend requests receive the token-entry form
   (200), never the app shell. Missing configuration fails closed. Passing the
   gate authorizes no API request. Token lifecycle management remains future work.
4. `BASE_PATH` is runtime configuration. The same portable build uses relative
   assets and Fastify HTML base/meta injection, mounted API/gate routes and client
   URL helpers. Cookie paths follow the mount policy in ADR-060.
5. After passing the frontend gate, an unprovisioned browser renders provisioning
   from browser defaults without an authenticated settings probe.
6. Every feature must begin with a runnable skeleton: real process boot, shell
   serving and a smoke path through the stack. Native modules remain external to
   the server bundle; importable server helpers must not start a second process.

## Rationale

Separate boundaries allow household settings to load before PIN unlock without
exposing the frontend to unauthenticated access. Runtime mount configuration keeps
one portable artifact usable behind root and subpath reverse proxies. Early
assembly prevents independently working modules from concealing integration debt.

## Acceptance Criteria

- Without a gate cookie, frontend requests receive the token form, not the shell.
- Missing `MP_ACCESS_TOKEN` cannot admit a token submission.
- A valid gate cookie does not authorize an API request without API credentials.
- Root `/health` succeeds without credentials, including under a non-root mount.
- Provisioning, PIN unlock, member creation and re-read work through the built
  process; a real restart preserves the device key and created member.
- One built artifact runs at root and a runtime `BASE_PATH`; release acceptance
  requires candidate-specific built-browser and container evidence.

## Related Decisions

ADR-031/033 (access and fail-closed policy), ADR-036 (provisioning), ADR-055/056
(portable runtime and aggregate gates), ADR-060 (transport and cookies).
