# ADR-060 Deployment Transport Posture & Cookie Security

Status: accepted (amended 2026-07-07 — see Correction: `__Host-` reversed)
Owner: architecture
Decision date: 2026-07-06
Peer-reviewed: yes (codex + claude blind round, 2026-07-06 — findings folded: single cookie
factory, `__Host-` prefix, explicit `SameSite`, trusted-proxy note made moot by the posture).
**The peer-reviewed `__Host-` recommendation was later empirically falsified — see Correction.**

## Correction (2026-07-07) — `__Host-` prefix REVERSED

Implementing #100 surfaced that Decision 3 (adopt the `__Host-` prefix) is **incompatible with
Decision 1** (local dev over `http://localhost`, no TLS). **Empirically verified** (Chromium via
Playwright, `http://localhost`): a plain `Secure` cookie is accepted, but both `__Secure-` and
`__Host-` prefixed cookies are **rejected** — the prefix enforcement requires a genuine HTTPS
scheme, which localhost's secure-context status does NOT satisfy. Adopting `__Host-` would make
the access-gate cookie unstorable in no-TLS local dev → the developer is locked out of the gate
(a _worse_ regression than the #100 bug, which never affected localhost). Both the ADR author and
the blind peer review missed this — we reasoned "`__Host-` has no downside under TLS-required" and
neither checked the localhost case against a browser.

**Amended decision:** keep plain `Secure` (accepted on localhost, enforced on real TLS); do NOT
adopt `__Host-`. Decision 4 (single cookie factory) still stands and is implemented in
`src/server/auth/cookies.ts` — that is the actual #100 deliverable. Decision 3 below is retained
verbatim for the record but is **superseded by this Correction**.

## Runtime mount amendment (2026-10-03)

Plain cookie names and `Secure`, `HttpOnly` and `SameSite=Lax` remain the policy.
Gate/device cookies now use the configured runtime mount plus `/` as their cookie
Path; an unset/root mount keeps `Path=/`. The nonsecret provisioning marker and
client-side marker deletion use the same path. This supports sibling deployment
paths without ordinary cookie delivery across those paths. Cookie Path is not an
origin security boundary; mutually untrusted applications require separate origins.
The earlier root-path wording below is historical and is superseded for non-root
mounts. No `__Host-` prefix is introduced.

## Context

Initial bootstrap sets both the access-gate cookie (`mp_gate`) and the device-key cookie
(`mp_device_key`) with a **hardcoded `Secure` attribute** (`src/server/auth/gate.ts`,
provisioning handler). Issue #100 flagged this as a latent deploy defect: a browser silently
drops a `Secure` cookie sent over a non-secure origin, so over plain HTTP the access gate can
never be passed → total lockout with **no error surfaced**.

The nuance that reframes the whole issue: `http://localhost` and `127.0.0.1` are browser
**secure contexts** ("potentially trustworthy origins" — WHATWG). Browsers therefore **accept
`Secure` cookies over plain HTTP on localhost**. That is exactly why `npm run dev` and the
Playwright critical-flow e2e (both over `http://localhost:3000`) pass through the gate cleanly.
The lockout reproduces **only on a non-localhost plain-HTTP origin** (a LAN IP like
`http://192.168.x.x`, or a bare hostname without TLS) — never on localhost, never in CI.

ADR-031/059 defined the access gate but never decided the **deployment transport posture**
(is plain-HTTP-on-a-network a supported deployment?). This ADR decides that; it is a new
decision, not previously contemplated.

## Decision

1. **TLS is REQUIRED for all non-localhost access.** Local development over
   `http://localhost` / `127.0.0.1` needs **no** TLS (secure context; `Secure` cookies are
   accepted). Every other origin — a real domain, a home server, a phone on the same wifi —
   must be served over HTTPS, via either a direct certificate or a **TLS-terminating reverse
   proxy** (Caddy + local CA, Tailscale, cloudflared, nginx). **Plain HTTP on a non-localhost
   origin is explicitly UNSUPPORTED.**

2. **The app emits `Secure` UNCONDITIONALLY.** No protocol sniffing, no `X-Forwarded-Proto`
   handling, no `trustProxy` configuration, and **no insecure opt-out env flag**. The current
   hardcoded-`Secure` code is _correct_ under this posture; #100 requires **no cookie-logic
   change**. (Behind a TLS-terminating proxy the browser's connection is HTTPS and it accepts
   the `Secure` cookie even though the app's upstream hop is HTTP — the `Secure` attribute is
   evaluated by the browser against _its own_ connection, not the app's internal socket. This
   is precisely why the naive "drop `Secure` when my socket is HTTP" fix would be a _new_ bug.)

3. **⚠️ SUPERSEDED by the Correction above (2026-07-07) — do NOT adopt `__Host-`; it is rejected
   over `http://localhost` and would break no-TLS local dev. Retained verbatim for the record.**
   ~~Defense-in-depth — adopt the `__Host-` cookie prefix~~ for both cookies
   (`__Host-mp_gate`, `__Host-mp_device_key`). `__Host-` makes the **browser enforce**
   `Secure` + `Path=/` + no `Domain`, so the transport invariant is guaranteed by the browser
   rather than trusted to server code. It has no downside under a TLS-required posture (those
   cookies are never issued over an insecure non-localhost origin). Implement as a **small
   follow-up** (issue #100, re-scoped): rename + issue via the cookie factory below.

4. **Centralize cookie attributes in a single cookie-factory helper** used by BOTH the gate and
   provisioning, enforcing `__Host-` prefix + `Secure` + `HttpOnly` + `SameSite=Lax` + `Path=/`
   from **one** call site. Two independent `Set-Cookie` sites drift over time; a factory makes
   "same policy for both cookies" a code-level guarantee, not a prose intention.

5. **`SameSite=Lax` is the explicit default** for both cookies (`gate.ts` already uses `Lax` —
   pin it). `Strict` would drop the cookie on a cross-site navigation _into_ the app (e.g. a
   bookmark followed from another site), which is too tight for a family-accessed planner;
   `None` is never used (it would require the very insecure mode this posture forbids).

## Consequences

- **#100 downgrades** from a deploy-blocker code fix to: (a) **this ADR + deployment docs**
  (TLS-required-for-non-localhost, plus the localhost-dev and reverse-proxy recipe) — done now;
  (b) an **optional small hardening follow-up** (`__Host-` prefix + the cookie factory), tracked
  on the re-scoped #100. It is **not** a merge-blocker for feat/001 → main, and under this
  posture it is not a code bug.
- **Deployment documentation must state** the TLS-required posture and give a reverse-proxy
  recipe. A self-hoster who wants LAN access from other devices without a public domain uses a
  **TLS terminator on the LAN** (Caddy local CA / Tailscale), **never** a weakened cookie.
- **Local dev is unchanged** (no SSL); **e2e and CI are unaffected** (localhost is a secure
  context). No behavioural change ships in this ADR itself.
- This ADR concerns **transport only** — the access gate's fail-closed authorization decision
  (ADR-031/059, Constitution II) is untouched.

## Acceptance Criteria

- Given the app served over `http://localhost`, when a browser passes the gate, then the
  `Secure` gate cookie is accepted and the SPA loads — no TLS required for local dev.
- Given the app served over a **non-localhost plain-HTTP** origin, then this is a **documented
  UNSUPPORTED** configuration; the deployment docs direct the operator to front it with TLS.
- Given the app behind a **TLS-terminating reverse proxy**, when a browser (HTTPS) passes the
  gate, then the `Secure`/`__Host-` cookie is accepted even though the app's upstream hop is HTTP.
- Given the `__Host-` hardening follow-up lands, then both the gate and device-key cookies are
  issued via a **single cookie factory** with `__Host-` prefix + `Secure` + `HttpOnly` +
  `SameSite=Lax` + `Path=/`.

## Traceability

- Resolves / re-scopes: **issue #100** (hardcoded `Secure` cookie → the follow-up is now the
  optional `__Host-` + cookie-factory hardening, not a lockout fix).
- Extends: `ADR-031` (two-boundary access gate), `ADR-059` (initial bootstrap gate assembly),
  `ADR-055`/`ADR-056` (same-origin serving; `/api`; distribution), `ADR-037` (`mpg-`/`mpk-`
  credential format), `ADR-032` (deployment-agnostic bootstrap config).
- Constitution: Principle II (fail-closed; health-only unauthenticated surface) — untouched;
  this ADR is about cookie transport, not the authorization decision.
- The decision index in this repository lists this record alongside `ADR-059`
  precedent for architect-authored slice/reconciliation ADRs.
