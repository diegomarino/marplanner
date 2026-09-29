# ADR-036 Connection-Setup / Device Provisioning Placement

Status: accepted
Owner: product / architecture
Decision date: 2026-06-28

## Decision

Device provisioning is **self-contained on the tablet**, presented as a deliberate device-setup screen — not as an ordinary kiosk route. A fresh (unprovisioned) device shows the provisioning screen on its own display; the operator enters the bootstrap `*` key there directly (`ADR-030`/`ADR-032`).

### URL parameter rule

- The **server/API URL** field may be pre-filled from a URL query parameter (and otherwise defaults to the current origin). The server URL is not a secret; pre-filling it enables a convenient "here is the setup link" flow.
- The **raw key** is **never** pre-filled, never read from a URL query parameter, and never reflected into the address bar. Credentials in URLs leak into browser history, server/proxy access logs, the `Referer` header, screenshots, and shared links. The key is always entered manually, and the field supports paste (from a password manager).

### Presentation

The provisioning screen is framed as a device-setup/installation screen, distinct from the household-visible kiosk routes. It does not pre-fill or display any key. Once provisioned, the device never shows this screen again unless its device key is revoked.

## Rationale

For a self-hosted household kiosk, self-contained provisioning is the pragmatic choice — it does not require a second device to pair the first. The risk that a child sees the setup form is low and transient: it only appears on an unprovisioned device (a freshly unboxed or reset tablet), never on the day-to-day operative surface. Keeping the raw key out of URLs entirely closes the credential-in-URL leak class while still allowing the convenient pre-filled server URL.

## Affected Specs

- the kiosk shell navigation feature (deferred) — §4 boot into connection gate, §12 Q13
- [the auth sessions feature](../../features/auth-sessions.md) — provisioning flow

## Acceptance Criteria

- Given a fresh device, when the browser loads, then it shows a device-setup provisioning screen (after the access gate), not an ordinary kiosk route.
- Given a URL query parameter for the server URL, when the provisioning screen loads, then the server URL field is pre-filled.
- Given any URL query parameter purporting to carry a key, when the provisioning screen loads, then the key field remains empty and no key is read from the URL.
- Given a successful provisioning, then the raw key never appears in the address bar, history, or response body (`ADR-030` device-key minting).
- Given a provisioned device, then the provisioning screen does not reappear unless the device key is revoked.

## Traceability

- Conflicts: `CR-024`
- Pre-v2: `ADR-013`, `ADR-023`
- Related: `ADR-030` (device provisioning), `ADR-031` (access gate precedes this), `ADR-032` (bootstrap)
