# ADR-058 Kiosk / Operator Trust Calibration (single household tier)

Status: accepted
Owner: architecture / security
Decision date: 2026-06-30
Peer-reviewed: no (deliberate non-mechanism — ratifies the existing calibration; low-risk)
Builds on: `ADR-030` (keys), `ADR-013` (PIN UI gate), `ADR-053` (device block), `ADR-057` (telemetry view).

## Decision

**Names and ratifies the trust calibration that was already emergent — there is no second
server-side privilege tier, by deliberate design for the family threat model.** Written to a
decision record (not just memory) so future domain grills stop re-litigating "should this
endpoint require admin scope?" (it surfaced ad-hoc in ADR-053 and ADR-057).

**The model:**

1. **One household trust tier.** A provisioned device's `*` key (ADR-030), carried in its
   httpOnly signed cookie, is **full household trust by construction**. Kiosks and the parent's
   admin-via-PIN both operate at this tier. Every member of the household is trusted; there is no
   modelled malicious API-capable insider.

2. **The PIN (ADR-013) is a UI affordance, never a server-side access control.** The server never
   consults it. It stops casual wandering into admin UI (a kid), not an attacker. Do not represent
   it as a security boundary anywhere.

3. **The single server-side kiosk/operator boundary is `key-management` (already ADR-030):**
   creating/revoking keys is the **one self-escalating, catastrophic, irreversible act**, so it
   alone requires a **raw `*` key presented in a header** (which a device cookie deliberately
   cannot supply) + anti-lockout. This is the one free security win worth taking, and it is already specified, with lifecycle mutations deferred in the installed release. **No new household privilege tier is added.**

4. **Everything else is household-tier** (reachable by a device `*` cookie + client-side PIN):
   backups (restore/delete — recoverable via pre-restore snapshot + count floor, ADR-017/042),
   plugin activate/install/uninstall (first-party, dormant, recoverable, ADR-039), telemetry read
   (read-only diagnostic, ADR-057), settings, and all household content. Reversible/recoverable
   operations do not warrant forcing the operator to hold the bootstrap key.

5. **ADR-053 device-block** was the one pre-existing extra carve-out (it rejected device-`*`
   kiosk keys at the API capability layer). **Removed 2026-10-15 by owner decision**: network
   devices are household-tier like everything else here, reachable by a device `*` cookie +
   client-side PIN.

**Anti-pattern named:** do **not** add ad-hoc per-endpoint "requires admin/operator scope"
carve-outs. If a future operation _feels_ like it needs one, that is a signal to re-examine the
threat model — not to proliferate tiers. The catastrophic-and-irreversible quadrant is exactly
`key-management`, and it is already covered.

**Distributable premise (ADR-055) does not change this:** each deployment is still **one trusted
household** (N self-hosters × 1 instance each). A device `*` key is an httpOnly cookie bound to a
device, not a leakable string; an outsider with access to a provisioned device is already inside
the household boundary.

## Rationale

The "wart" (kiosks hold `*`, so the server draws no kiosk/admin line beyond key-management; the
PIN is client-side) is **not a gap to fix — it is the correct calibration of a single-trust-tier
family kiosk.** Generalizing into an "operator tier" was over-engineering: (a) it solves only for
a malicious API-capable insider that the threat model excludes, and (b) it fights the kiosk's
own auth shape — the httpOnly device cookie cannot present a raw key, so any header-`*` op is, by
construction, "you must hold the bootstrap key," which is disproportionate friction for
_reversible_ operations. Future key-management must use the raw-header boundary and preserve an operator-usable credential; these mutations are deferred in the first release (`ADR-030`/`ADR-032`).
This is the same "accept + document" posture chosen for telemetry (ADR-057), applied consistently.

## Affected Specs

- [the auth sessions feature](../../features/auth-sessions.md), [authentication contract](../contracts/auth-sessions.md)
  (the trust tier is named here; no behavior change)

## Acceptance Criteria

- No endpoint other than key-management requires a non-cookie credential.
- The PIN is never used as a server-side authorization check.
- A future grill proposing a per-endpoint "admin scope" requirement is evaluated against this
  calibration first (re-examine threat model) rather than adding a carve-out.

## Open Questions

- None. (If the threat model ever gains a malicious insider — e.g. a multi-tenant deployment,
  which ADR-055 explicitly is not — reopen this together with ADR-030.)

## Traceability

- Closes the cross-cutting kiosk-`*`-vs-admin thread surfaced by the ADR-016 security re-grill
  (2026-06-30) and previously hit ad-hoc by ADR-053 / ADR-057.
- Related: `ADR-013`, `ADR-030`, `ADR-053`, `ADR-055`, `ADR-057`.
