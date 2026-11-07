# ADR-034 Admin Entry Affordance: Visible Link, Tap to Open the PIN Gate

Status: accepted (amended 2026-11-07 — the long-press was removed)
Owner: product / design
Decision date: 2026-06-28

> Note (2026-11-07, owner decision): the original decision required a sustained ~3-second
> long-press on the visible admin link, as a casual-access filter against children, before the
> PIN gate appeared. On the kitchen tablet the hold made adult entry slow and unreliable (a press
> released early opened nothing and needed a "keep holding" hint), so the hold, its progress bar
> and its hint were removed. The PIN (`ADR-013`) is now the only safeguard against a child
> wandering into admin; it was always the actual gate, and the hold never was a security control.

## Decision

The admin/settings entry link remains **visible** in the kiosk shell (the Options button, or the
Admin item of the Options menu once it has other entries). An ordinary activation — tap, click,
Enter/Space, or an assistive-technology click — opens the admin PIN gate immediately. There is no
hold timer, progress indicator or hint.

The PIN gate submits the PIN by itself once it has 4, 5 or 6 digits, so the parent does not need to
press Unlock (the button remains for accessibility and as a fallback):

- Attempts at 4 and 5 digits are silent probes: a rejection shows no error, keeps the digits and
  announces nothing, so the parent keeps typing a longer PIN.
- A rejection at 6 digits, or of a manual submit (Unlock button or Enter), shows the error and
  clears the digits.
- Verifications are strictly sequential. A newer entry waits behind the one in flight and only the
  latest waiting entry is sent; Backspace sends nothing and drops an entry that has not been sent.

## Rationale

The kiosk is child-facing most of the time, which is why a deliberate gesture was first chosen. In
use, the hold cost every adult entry three seconds and failed on early releases, while a child who
reaches the PIN screen still cannot get past it. A plain tap that lands a child on the PIN screen is
harmless: Cancel returns to the family surface.

Auto-submit at every valid length cannot lock a household out: `verify-pin` has no attempt counter
or rate limiter (`ADR-013`: it is behind the device key, which already authorizes everything), and
the authentication backoff counts only failed device credentials, never PIN mismatches. A correct
6-digit PIN typed normally sends at most two failed probes first.

## Affected Specs

- `docs/architecture/contracts/kiosk-shell-navigation.md` — admin entry and AC-02
- `docs/features/kiosk-shell-navigation.md` — User Story 2, FR-009
- `docs/ui/household-contract.md` — family shell and admin lock

## Acceptance Criteria

- Given a child-facing kiosk route, the admin/settings link is visible in the shell.
- Given a tap, click, Enter/Space or assistive-technology activation on the admin link, the PIN gate
  is presented at once.
- Given 4 or 5 entered digits that the server rejects, no error is shown and the digits are kept.
- Given 6 entered digits, or a manual submit, that the server rejects, the error is shown and the
  digits are cleared.
- Given a correct PIN of 4–6 digits, the admin surface unlocks without pressing Unlock.
- At most one PIN verification is in flight at a time.

## Traceability

- Conflicts: `CR-024`
- Related prior: `ADR-023`
- Related: `ADR-013` (PIN gate behind the entry)
- Domain grill: `domain-grills/kiosk-shell-navigation.md` (historical record, not preserved in this repository)
