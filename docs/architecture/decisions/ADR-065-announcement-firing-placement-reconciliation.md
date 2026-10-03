# ADR-065 Announcement firing placement: ADR-035 / ADR-051 reconciliation

Status: accepted
Owner: architecture
Decision date: 2026-09-03

## Context

`ADR-035` (runtime service placement, 2026-06-28) places time announcements under its
decision/execution split: the server owns the scheduling decision (Principle 1 examples, :13),
hardware execution is claimed from a server queue by a capability-registered browser
(Principles 2–3, :19–24), stale slots are expired server-side (Principle 4, :29–31), and the
model "**replaces the legacy browser leader-election (BroadcastChannel)**" (:20). Its Affected
Specs list (:54) and acceptance criteria (:67–68) restate that server-queue model for
announcements.

`ADR-051` (time announcements firing and surface, 2026-06-29 — one day later) decides the
opposite for this domain: firing/dedupe is client-side per connected browser, the server owns
only rule data and never fires, tabs elect one leader (e.g. BroadcastChannel), and multi-device
double-speak is accepted rather than coordinated (:14–27), with the explicit proportionality
argument that a server-coordinated single speaker would be over-engineering because — unlike
printing — duplicate speech costs nothing (:21–27).

Both ADRs are `accepted`. The domain contract and the boundary ledger already encode ADR-051's
model (`docs/architecture/contracts/time-announcements.md` INV-06 :31, INV-07 :34; all TIME-ANNOUNCEMENTS
guarantees `active`), while one kiosk-shell guarantee still encodes ADR-035's
(`docs/architecture/contracts/kiosk-shell-navigation.md` AC-07 :96 — and the untagged Behaviors prose at
:45 repeats the same model: announcement work "dispatched only to capability-registered
browsers and executed once"). The contradiction surfaced while preparing .

## Decision

1. **For Time Announcements, `ADR-051` governs.** Firing is client-side per connected browser;
   the server owns rule CRUD only and never fires; leader election is browser-local
   (mechanism unpinned — "e.g. BroadcastChannel"); multi-device double-speak is accepted.
   `TIME-ANNOUNCEMENTS-INV-06`, `-INV-07` and `-AC-04` are the enforceable statement.
2. **`ADR-035` Principles 1 and 5 are unaffected** (placement by capability: UI-bound services
   run per connected browser; announcements are not paused on admin routes — P5 is precisely
   what keeps AC-07's surviving clause alive). Principles 2, 3 and 4 — the decision/execution split, capability
   registration, and the atomic-claim queue with staleness compaction — are hereby **scoped to
   hardware behaviors whose duplicate execution is costly or irreversible**, which in this system is
   **Printing alone** (`docs/architecture/contracts/printing.md` INV-05, AC-04). The clause at
   `ADR-035:20` ("replaces the legacy browser leader-election") and the announcement examples
   at :29–31, :54 and :67–68 do **not** apply to Time Announcements.
3. **Corollary — no server queue, no capability registration, no staleness expiry for
   announcements.** A missed slot is simply not spoken; no server-side record exists that it
   was missed. Audio capability is _implicit_ (a browser that cannot speak swallows the
   failure per `TIME-ANNOUNCEMENTS-INV-08`), never registered.
4. **`KIOSK-SHELL-NAVIGATION-AC-07`'s announcement half is narrowed.** The "dispatched only to
   capability-registered browsers and executed once" clause applies to print/hardware-claim
   work only; the "time announcements continue on admin routes" clause stands unchanged and
 binds . `docs/features/kiosk-shell-navigation.md` FR-014 is narrowed accordingly and
   the boundary ledger entry carries a note citing this ADR (disposition stays `active` — a
   `superseded` disposition would wrongly drop the still-valid printing half).
5. **Dependency correction**: Time Announcements depends on neither Day Periods
   nor the background-jobs scheduler (the contract's dependency list contains no Day-Periods
   ADR; the only "Day Periods" mention is a peer-review rationale analogy at :104). Its real
   dependencies are the plugin host-API seam (Rule B), the household timezone/language
   settings, and the kiosk shell mount point.

## Rationale

The proportionality argument in `ADR-051:21–27` is correct, and `ADR-035`'s own printing
analogy supports it: the atomic claim exists to prevent a _costly_ duplicate action
(double-print wastes paper); duplicate speech wastes nothing. Building the queue for
announcements would require the entire Printing substrate — persisted work-units, atomic
claim, lease/TTL, staleness compaction, capability registration — which
the scheduler contract delegates to Printing, to ship a
feature whose worst failure mode is "the kiosk says the time twice". The oracle
(`docs/architecture/contracts/time-announcements.md`) and the ledgered guarantee set adopted ADR-051's
model at contract-authoring time; this ADR records the scope rule that makes the two accepted
ADRs consistent instead of leaving the contradiction implicit.

## Acceptance Criteria

- Given the Time Announcements slice, no server-side scheduler job, queue row, claim, or
  staleness sweep exists for announcements.
- Given two kiosk devices, both may speak the same minute; nothing coordinates them.
- Given two tabs in one browser, exactly one speaks (browser-local leader).
- Given `docs/features/kiosk-shell-navigation.md`, FR-014's "executed once" clause applies to
  print/hardware work only.
- Given the installed dependencies, Time Announcements declares no Day Periods and no
  background-jobs-scheduler dependency.

## Traceability

Reconciles `ADR-035` × `ADR-051` (scope rule, no retro-edit of either — the design corpus is
read-only; this ADR is the erratum vehicle per the implementation-time series precedent
`ADR-059`/`ADR-060`/`ADR-063`/`ADR-064`). Deliberate choice: the ADR-064 alternative (amend the
vendored contract + regen its hash) was considered and declined — the contract AC's wording
stays; the narrowing lives here, in the realizing FR, and in the ledger note that makes the
machine-invisible divergence legible. Related: `ADR-029` (plugin placement), `ADR-015`
(speech language), `ADR-005`/`ADR-020` (household time/weekdays), `ADR-028` (tz validity),
`ADR-030` (admin capability). Ripples: `docs/features/kiosk-shell-navigation.md` FR-014
narrowing + ledger note on `KIOSK-SHELL-NAVIGATION-AC-07`; the dependency correction is recorded above.
