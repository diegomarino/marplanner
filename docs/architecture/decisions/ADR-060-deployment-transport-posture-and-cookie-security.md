# ADR-060 Deployment Transport and Cookie Security

Status: accepted
Owner: architecture
Decision date: 2026-07-06

## Context

Gate/device cookies carry protected credentials and must work both in localhost
development and behind a production TLS terminator. Runtime mount paths must also
support sibling deployments without ordinary cross-path cookie delivery.

## Decision

1. Require HTTPS for all non-localhost browser access. Plain HTTP on a LAN address
   or non-localhost hostname is unsupported. Local development may use
   `http://localhost` / `127.0.0.1` without TLS.
2. Emit `Secure` unconditionally. The browser evaluates its own HTTPS connection,
   including when a TLS-terminating proxy uses HTTP upstream. Do not sniff socket
   protocol, trust `X-Forwarded-Proto` to weaken cookies or add an insecure opt-out.
3. Use plain cookie names, not `__Host-` or `__Secure-`: the recorded Chromium
   localhost probe rejected those prefixes over HTTP while accepting plain Secure
   cookies. Preserve the recorded evidence below rather than relying on
   secure-context reasoning to infer prefix support.
4. Use the single factory in `src/server/auth/cookies.ts` for both protected
   cookies: Secure, HttpOnly, SameSite=Lax and mount-scoped Path. Root uses `/`;
   a non-root mount uses `{basePath}/`. The provisioning marker and its deletion
   use the same mount path.
5. Cookie Path controls ordinary delivery, not origin isolation. Mutually untrusted
   applications require separate origins. SameSite=Lax supports ordinary incoming
   navigation while limiting cross-site cookie delivery.

## Empirical Evidence

The recorded Chromium/Playwright probe on `http://localhost` observed a plain
Secure cookie accepted and both `__Secure-`/`__Host-` cookies rejected. Prefix
enforcement required an HTTPS scheme despite localhost's trustworthy-origin
status. This supports plain names for no-TLS development; it is not new execution
evidence from this documentation edit.

## Consequences

Deployment instructions must supply TLS for LAN/remote access and explain the
reverse-proxy/local-CA recipe. Protected cookies retain the same policy behind
direct TLS and TLS termination. The access gate and API authorization remain
independent (ADR-031/059); transport policy does not waive either boundary.

## Acceptance Criteria

- Localhost HTTP stores the plain Secure gate cookie and admits the shell after
  valid gate entry.
- Non-localhost plain HTTP is documented as unsupported; operators use TLS.
- A browser connected to an HTTPS terminator accepts the Secure cookie despite
  an HTTP upstream hop.
- Both protected cookies use the single factory, plain names, Secure, HttpOnly,
  SameSite=Lax and the configured mount Path.
- A non-root provisioning marker is set/cleared with the same path; no Path value
  is represented as an origin security boundary.

## Related Decisions

ADR-031/033/059 (authorization and serving), ADR-055/056 (portable distribution),
ADR-032/037 (configuration and credential format).
