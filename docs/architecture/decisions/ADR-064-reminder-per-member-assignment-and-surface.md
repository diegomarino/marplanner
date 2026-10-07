# ADR-064 Reminder per-member assignment model and first surface

Status: accepted
Owner: product + architecture
Decision date: 2026-08-13

## Decision

Refines the Reminders targeting model (`ADR-049` / `ADR-018` / `reminders.md`) and fixes
the domain's first interactive surface, ahead of the first Reminders implementation slice.

### 1. Per-member weekday assignment (targeting becomes a discriminated `targeting_mode`)

The previous model coupled **one rule-level `weekday-set`** to a **flat list of targeted
members** — every targeted member inherited the same weekdays. That cannot express the
real requirement: _one prompt, different children, different days_ (e.g. "coges el bus"
→ Pablo on Mon/Wed, Lucas on Fri). The targeting model is replaced by a discriminated
union on `targeting_mode`, mirroring the proven **Routines/Chores Assignment** model
(`routines-chores.md`: _assignment = routine → one active child on a set of weekdays_):

- **`targeting_mode: apply_to_all` — household-wide, same days.** A rule-level
  `weekday-set` (`scheduled`) applying to every active member. No assignment rows.
- **`targeting_mode: specific` — per-member, own days.** N **assignments**, each binding
  **one active member** to **its own `weekday-set`** (`scheduled`). Different members may
  carry different weekdays under one rule.

An **Assignment** always binds a member; it carries a `weekday-set` iff `kind` is
`scheduled` (for `calendar_gated` the calendar _is_ the schedule, `ADR-049`, so a
`calendar_gated` assignment is member-membership only, no weekdays). This is a second
discriminant layered under `kind`, in the same "make invalid states unrepresentable"
spirit as `ADR-049`'s kind split and `ADR-028`'s settings union — and, like `INV-01`,
enforced by **boundary rejection** of the wrong field placement (realized as
`REMINDERS-INV-09`).

**Emission** for `(member, date)`:

- `scheduled` + `apply_to_all`: emit iff the date's weekday ∈ the rule's weekday-set.
- `scheduled` + `specific`: emit iff the member has an assignment whose weekday-set ∋
  the date's weekday.
- `calendar_gated`: unchanged (`ADR-049`) — evaluated every day via `Calendar.getEvents`;
  targeting still selects which members the gate runs for (all active, or the assigned
  set). No weekday gates it.

### 2. First surface is admin-only; no user-facing dashboard widget

Reminders is a **briefing content source** (`reminders.md`): non-completable,
informational prompts (e.g. "hoy vuelves en el autobús"), evaluated pull-time during
briefing generation, with no real-time render of its own. Its interactive surface is
therefore **admin-only**:

- **`admin/reminders`** — author/manage rules + assignments and **visualize the
  assignment matrix** (member × weekdays). Uses the kiosk contract's **generic
  admin-gating mechanism** (`KIOSK-SHELL-NAVIGATION-INV-02` + the admin-entry/unlock
  Behavior), which gates admin routes without enumerating each domain's admin route; adds
  **no** user-facing route and **no** dashboard widget, so `kiosk-shell-navigation.md` is
  **not amended** and the boundary ledger's kiosk guarantees are untouched.
- **Outbound read** (`getReminders(member, date)`, the briefing-consumer interface) —
  independently demoable and testable via the API before the **Daily Briefing** producer
  (Tier-2) exists.

Reminders' **user-facing render is the Daily Briefing** and is **deferred** to that
slice. Fabricating a "today's reminders" dashboard widget now would invent a surface the
domain does not have and pre-empt Daily Briefing's block-render ownership (`ADR-008`).

### 3. Rollout — `scheduled` first

The first implementation slice builds `kind: scheduled` (both targeting modes), the
`admin/reminders` surface, and the outbound read. `kind: calendar_gated` — with the
`Calendar.getEvents` `query`/`queryFields` text-matching that work item 4 `FR-010`
deliberately deferred to "the first consumer (Reminders)", and the dry-run/explain path
(`REMINDERS-AC-10`) for its opaque non-emission — lands in a **later** slice. `scheduled`
carries no Calendar dependency, so the first slice stays additive on the proven spine.

## Rationale

Per-member assignment captures the household's real usage without inventing a grouping
("named set") entity — which was considered and **rejected** (informational reminders do
not benefit from being bundled; each is independently authored and targeted). It reuses a
model the team built and validated one slice ago (Routines/Chores assignments,
work item 5), so the schema, atomic-write, and archive-self-heal patterns transfer
directly. The flat model's alternative — duplicating the same text across one row per
(member, day-pattern) — is redundant authoring the maintainer explicitly wanted to avoid.

Admin-only surfacing matches the domain's nature and keeps the slice honest: it exercises
a full vertical cut (schema → API → auth → admin UI → the outbound read → tests) on a
surface that already exists in the kiosk contract, with zero new user-facing-render design
debt and no oracle churn in the kiosk domain. Distinguishing reminders (non-completable,
briefing-only) from chores (completable, streaked — Routines/005) keeps the two domains
from re-inventing each other; the shared piece is the _assignment_ shape, not the
completion semantics.

## Affected Specs

- `docs/architecture/contracts/reminders.md` — Vocabulary (Assignment replaces flat targeting +
  rule-level weekday coupling), `REMINDERS-INV-02` (targeting→assignments),
  `REMINDERS-INV-03` (weekday placement), `REMINDERS-INV-08` (rule + assignments atomic),
  `REMINDERS-AC-03`/`-AC-04`/`-AC-07` (weekday/zero-assignment/atomic wording), evaluate
  Behaviors, and a **new** `REMINDERS-INV-09` (per-member assignment model).
- `docs/features/reminders.md` — re-quote the affected FRs to match; add an FR realizing
  `REMINDERS-INV-09`.
- `kiosk-shell-navigation.md` — **no change** (recorded here to close the peer-review
  "undesigned surface" finding: the surface is admin, not a dashboard widget).

## Data / Setup Implications

Owned (namespaced): `reminder` rules (`kind`, `targeting_mode`, `text`, `active`,
`priority`; rule-level `weekdays` only for `scheduled` + `apply_to_all`) and
`reminder_assignment` rows (`reminder_id`, `member_id`, and `weekdays` only for
`scheduled` + `specific`). A `specific`-mode rule with zero assignments is rejected at
write (`active:false` to silence). Rule + assignments persist atomically (`ADR-043` class
1). Archived members drop from active emission and self-heal on reactivation (`ADR-002` /
`ADR-054`, read-tolerance separate from write validation). Prod has 0 reminder rows; no
legacy import (`ADR-026`).

## Acceptance Criteria

- A `scheduled` + `specific` rule holds N assignments each binding one active member to
  its own weekday-set; emission for `(member, date)` checks that member's own assignment
  weekdays (new `REMINDERS-INV-09`).
- A `scheduled` + `apply_to_all` rule emits for every active member on the rule's
  weekdays (`REMINDERS-AC-03`, reworded to the targeting modes).
- A `specific`-mode rule with zero assignments is rejected at write (`REMINDERS-AC-04`).
- Rule + assignments persist atomically (`REMINDERS-AC-07` / `-INV-08`).
- No user-facing dashboard widget is added; `kiosk-shell-navigation.md` is unchanged.
- All unchanged Reminders invariants (pull-time, snapshot immutability, `getEvents`-only
  gate for `calendar_gated`) continue to hold.

## Peer Review

codex-peer-review blind-debate (2026-08-13, 2 rounds, converged). **Verdict:
AGREE-WITH-AMENDMENTS** — no security/architecture rejection; the assignment model, the
Routines/Chores parity, and the admin-only surface all held under stress-testing. Machine
checks verified independently (contract-hash matches; `check-coverage --domains reminders`
green, 347 guarantees). One **critical** + four **important** findings, all incorporated
before publication:

- (Critical) `targeting_mode` was presented as a discriminant but the contract lacked the
  matching **write-time rejection** guarantee (INV-01's defining property). Fixed:
  `REMINDERS-INV-09` restructured to reject invalid targeting/weekday combinations at the
  boundary (rule-level weekdays on `specific`, per-assignment weekdays on `apply_to_all`,
  any weekdays on a `calendar_gated` assignment).
- (Important) `AC-02`/`FR-010` (`calendar_gated`) were not threaded through `targeting_mode`
  eligibility, asymmetric with `AC-03`. Fixed for parity.
- (Important) `INV-09`/`FR-018` omitted the `calendar_gated`-no-weekdays clause. Folded into
  the restructured `INV-09` + `FR-018`.
- (Important) `FR-003` normative text still modeled weekday writes as flat. Threaded through
  the rule-level (`apply_to_all`) vs per-assignment (`specific`) split.
- (Important) `INV-09` restated `AC-03`'s emission semantics (dual source of truth).
  Resolved: `INV-09` owns structure + boundary rejection; `AC-03` owns emission.

Style: `Assignment` (rule→member) disambiguated from Calendar's `assignedTo` (event→member)
in Vocabulary; the imprecise `INV-05` citation corrected to the generic admin-gating
mechanism above.

## Open Questions

- `apply_to_all` storage: a rule-level `weekdays` column vs. materialized per-member
  assignments — an implementation choice settled in the slice plan, not a contract
  guarantee.
- Whether `calendar_gated` + `specific` assignments (member-membership, no weekdays)
  should reuse the same `reminder_assignment` table with a null weekday-set or a distinct
  shape — settled when the `calendar_gated` slice lands.

## Traceability

- Refines `ADR-049` (reminder kind split) — which refined `ADR-018` (calendar read
  interface). Lineage: `ADR-018 → ADR-049 → ADR-064`.
- Assignment parallel: `routines-chores.md` (work item 5 Assignment model).
- Related: `ADR-002` / `ADR-054` (member targeting + referential integrity), `ADR-020`
  (weekday model), `ADR-005` / `ADR-006` (household tz + strict dates), `ADR-043`
  (atomic writes), `ADR-008` (Daily Briefing render ownership — deferred user render),
  `ADR-059` (assembly-seam-first for the implementation slice).
