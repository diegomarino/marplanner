# ADR-034 Admin Entry Affordance: Visible Link, Long-Press to Activate

Status: accepted
Owner: product / design
Decision date: 2026-06-28

## Decision

The admin/settings entry link remains **visible** in the kiosk shell (e.g. top bar), but activating it requires a **sustained long-press** (~3 seconds) rather than an ordinary tap. A quick tap does nothing. After the long-press activates, the admin UI is still gated by the PIN (`ADR-013`).

This is the deliberate-gesture admin entry for the child-facing kiosk: discoverable for the adult, but not triggered by a child's casual tap.

## Rationale

The kiosk is a child-facing surface most of the time. A plain tappable admin button invites constant child "poking" that lands on the PIN screen. A hidden gesture (corner long-press, typed route) is harder for the adult to rediscover. The long-press-on-a-visible-link middle ground keeps the entry discoverable while filtering casual activation: the affordance is visible, but a sustained 3-second press is a deliberate adult action a child rarely performs by accident.

The long-press is **not** a security control — a child could discover it. It is a casual-access filter. The PIN remains the gate behind it, making the PIN the second line (defense in depth) rather than the only barrier against a child wandering in.

## Affected Specs

- `docs/rewrite-spec/15-kiosk-shell-navigation.md` — §4 navigate routes, §11 top-bar affordance quirk, §12 Q6
- `docs/rewrite-spec/12-auth-sessions.md` — admin entry precedes the PIN gate

## Acceptance Criteria

- Given a child-facing kiosk route, the admin/settings link is visible in the shell.
- Given an ordinary tap on the admin link, nothing happens (no navigation to admin/PIN).
- Given a sustained press (~3s) on the admin link, the admin entry flow begins and the PIN gate is presented.
- The long-press duration is a configurable UI parameter with a sensible default (~3s).

## Open Questions

- Exact long-press duration and visual feedback (progress ring, etc.) are design details with a sensible default; not blocking.

## Traceability

- Conflicts: `CR-024`
- Related prior: `ADR-023`
- Related: `ADR-013` (PIN gate behind the entry)
- Domain grill: `domain-grills/kiosk-shell-navigation.md` (historical record, not preserved in this repository)
