# ADR-054 Member Referential Integrity — Archive-Only, No Hard Delete

Status: accepted
Owner: product + architecture
Decision date: 2026-06-29

## Decision

Every domain must preserve member references when a member leaves the household. Fresh-store policy (`ADR-026`) excludes legacy-row migration; runtime integrity follows the archive-only lifecycle below.

**v2 member lifecycle is `active` | `archived` only. There is NO hard delete of a member —
not even a narrow carve-out** (`ADR-025`). A member that leaves the household, or one created
by mistake, is **archived**, never physically removed: invisible and inassignable in ordinary
flows, but its row always exists so historical references stay legible read-only.

A peer-reviewed earlier draft proposed a "discard a member with zero _core_ references"
carve-out; it was **rejected** because a member can hold **plugin-only** references (e.g. a
Network Devices `memberId`) with zero core references — those have no cross-namespace FK
(`ADR-039`), so a core-FK-gated discard would physically remove a member still referenced by a
plugin, producing a **missing-row** (not archived-row) the read-tolerance pattern was never
designed for. Archive-only eliminates that entire failure class: **the row never disappears.**

### Cross-cutting referential-integrity invariant (was emergent across 6 domains, now stated once)

Because a member row is never destroyed, **no domain ever holds a dangling member reference.**
The universal rule — already applied independently in Reminders (`ADR-049` R2), Daily Messages
(`ADR-048`), Network Devices (`ADR-053` Q6/Q7), and Daily Briefing eligibility — is:

- **Strict on write:** **any write that establishes or replaces a `memberId` — INSERT _or_
  UPDATE** — must validate the target member is **active** (`ADR-002`). You cannot create or
  re-point a reference to an archived (or non-existent) member. (Covering UPDATE, not just
  INSERT, closes a PATCH-to-archived-member bypass — peer-review issue-4.)
- **Tolerant on read:** a pre-existing reference to a now-**archived** member **renders
  read-only ("archived/inactive member"), never breaks** the read. Because no member is ever
  deleted, read-tolerance only ever faces the **archived-row** case (row present, status
  archived) — never a missing row — so the existing per-domain implementations are sufficient
  as-is.

This makes orphaned references **unrepresentable** rather than handled — the strongest form.

### FK policy for member references

Core tables referencing `members(id)` use `ON DELETE RESTRICT` / `NO ACTION` with
`PRAGMA foreign_keys=ON` (already mandated by `ADR-043`) as a **defensive backstop** — but
since no member is ever deleted, no member-FK `ON DELETE` path is ever exercised in normal
operation. The `SET NULL` / `CASCADE` / `RESTRICT` choice is therefore **moot by
construction**; `RESTRICT` is chosen only so that any future code path attempting a member
delete fails loudly instead of silently orphaning. Plugin references remain soft (no
cross-namespace FK, `ADR-039`) and are governed entirely by archived-row read-tolerance.

### Mistaken-member UX

A mis-created / test / typo member is handled by **archiving** it (disappears from pickers and
assignment flows). If the archived list becomes cluttered, a UI "recycle bin / archived
with no activity" filter is a **presentation-only** convenience — never a data-loss path. No
backend erase is introduced.

## Rationale

The orphan problem was a hard-delete-world problem; v2 already chose an archive-only world, so
the right move is to _name the invariant that world implies_ rather than build orphan-repair
machinery or a delete path. Peer review showed the proposed zero-reference discard was not the
simpler option it appeared: it would have required FK RESTRICT discipline on every future core
table, plugin read paths rewritten to handle missing rows, and the core-exact/plugin-tolerant
split reasoning — all to serve a 1–2-per-lifetime mis-created-member case that archiving
already covers. Pure archive-only is both simpler and strictly safer. Calibrated to the
family-kiosk model: no compliance-driven erase requirement, your own data on your own box.

## Affected Specs

- [members](../../features/members.md), [routines-chores](../../features/routines-chores.md)
- `../domain-contracts/members.md` (adds the cross-cutting invariant; confirms no hard delete)
- Routine assignment eligibility belongs to Routines; assignment-set writes follow `ADR-043` atomicity.

## Data / Setup Implications

No member row is ever physically removed. Core member-FK columns use `ON DELETE RESTRICT`/
`NO ACTION` with `foreign_keys=ON` as a backstop only. Plugin member references remain soft
(no cross-namespace FK, `ADR-039`), governed by archived-row read-tolerance. No legacy orphan
rows are imported (`ADR-026`).

## Acceptance Criteria

- There is no API path that physically deletes a member; the only lifecycle transition away
  from `active` is `archived` (and restore, if exposed).
- A write (INSERT or UPDATE) that sets/replaces a `memberId` to an archived or non-existent
  member is rejected (`ADR-002`).
- A pre-existing reference to a member who is later archived continues to render read-only
  ("archived member"), in every referencing domain (core and plugin), without error.
- Read-tolerance is only ever exercised against an existing archived row, never a missing row.
- Archiving a zero-activity mis-created member removes it from all ordinary pickers/flows.

## Open Questions

- None. Member eligibility belongs to the referencing domain; assignment-set atomicity follows ADR-043.

## Traceability

- Fresh-store scope: `ADR-026`; runtime integrity is defined here.
- Consolidates the emergent rule from `ADR-002`, `ADR-025`, `ADR-048`, `ADR-049`, `ADR-053`.
- Peer-reviewed: rejected the zero-reference-discard carve-out (issue-1 plugin-orphan +
  issue-2 missing-row vs archived-row); folded issue-4 (invariant covers INSERT+UPDATE).
- Related: `ADR-039` (no cross-namespace FK), `ADR-043` (`foreign_keys=ON`), `ADR-040`.
- Domain grill: `domain-grills/members.md` (historical record, not preserved in this repository)
