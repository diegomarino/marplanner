# Daily Messages Domain Contract

Status: maintained contract
Depends on decisions: `ADR-002`, `ADR-005`, `ADR-006`, `ADR-013`, `ADR-015`, `ADR-022`,
`ADR-026`, `ADR-027`, `ADR-030`, `ADR-048`

## Purpose

Ad-hoc **per-member/date sticky notes**: a parent/admin writes short free text for one
member on one household-local date; it surfaces as the personal `message` block in that
member's Daily Briefing. Not a reminder engine — no recurrence, no calendar gating, no
rules. Absence = no block.

## Vocabulary

- **Daily message** — one note for a `(member, date)` pair: stable id, recipient member,
  household-local date, text, created/updated timestamps.
- **Recipient** — an active member (`ADR-002`); the note's only output is that member's
  own briefing.

## Invariants

1. **DAILY-MESSAGES-INV-01** **One message per `(member, date)`**; re-saving replaces text + advances `updatedAt`.
   Delete is a separate idempotent command; a blank field is a no-op, never a delete.
2. **DAILY-MESSAGES-INV-02** **Targeting = active members** (`ADR-048`/`ADR-002`); not child-only (aligned with the
   de-gated briefing, `ADR-027`). A message to a member without a briefing simply never
   surfaces. Inactive/archived members are inassignable for new writes; historical rows
   stay readable.
3. **DAILY-MESSAGES-INV-03** **Dates** strict calendar-valid `YYYY-MM-DD`, household-local (`ADR-006`/`ADR-005`);
   "today" and the list window use household tz. Window half-open `[from, from+days)`,
   `days` capped (≈60), zero/negative rejected.
4. **DAILY-MESSAGES-INV-04** **Text** required, **trimmed, non-empty after trim**; stored **verbatim** (`ADR-015`
   user-authored, never translated). Emoji stripping / print wrapping are render-layer
   concerns, not authoring. Sanity cap ≈500 chars.
5. **DAILY-MESSAGES-INV-05** **Snapshot** (`ADR-022`): a generated briefing snapshots the text at generation;
   later edits/deletes do not mutate generated payloads and do **not** auto-regenerate or
   mark stale — regeneration is an explicit Daily Briefing action.
6. **DAILY-MESSAGES-INV-06** **Permissions** (`ADR-013`/`ADR-030`): parent/admin write only; a message is exposed
   only via its recipient's own briefing (no cross-member leak).
7. **DAILY-MESSAGES-INV-07** **Concurrency:** per-`(member, date)` last-write-wins; no etag/version.
8. **DAILY-MESSAGES-INV-08** **Reads distinguish** missing member (not-found) from a valid member with no messages
   (empty list, ordered by date ascending).

## Behaviors

- **List** messages for a member over `[from, from+days)`: pure read, date-ascending;
  missing dates = absence, not placeholders.
- **Create/replace**: non-empty trimmed text for an active member + valid date; upserts
  the single `(member, date)` row.
- **Delete**: idempotent removal; deleting a missing message succeeds as a no-op.
- **Consumed by Daily Briefing**: at generation, if a message exists for the briefing
  `(member, date)`, the briefing includes the `message` block with the text (render
  sanitizes); absence = no block, no failure.

## Interfaces

- Inbound (parent/admin): list (member + window), create/replace (member + date + text),
  delete (member + date) — recipient-existence and active-state validated at the boundary.
- Outbound: read of the current message for a `(member, date)` consumed by Daily Briefing
  during generation (no cross-module table access; Rule B).

## Events

(`ADR-040`.) Emits none; subscribes to none. It is a pull-time content source read by
Daily Briefing at generation. No auto-regen signal (snapshot model, `ADR-022`).

## Data / Setup Contract

Owned: `daily_messages` (id, member_id, date, text, created_at, updated_at), unique
`(member_id, date)`. No owned settings (block enable/order/schedule belong to Daily
Briefing, `ADR-008`). Fresh v2 (`ADR-026`); 4 prod rows (active children, single date)
are evidence only.

## Acceptance Criteria

- **DAILY-MESSAGES-AC-01** At most one message per `(member, date)`; re-save replaces text.
- **DAILY-MESSAGES-AC-02** Authoring allowed for any active member (not child-gated); inactive members rejected
  for new writes.
- **DAILY-MESSAGES-AC-03** Whitespace-only text rejected; blank field writes nothing and never deletes.
- **DAILY-MESSAGES-AC-04** Write to a missing member fails; read of a missing member is not-found; valid member
  with no messages is an empty date-ascending list.
- **DAILY-MESSAGES-AC-05** `days` beyond cap or ≤ 0 rejected; window half-open; dates strict + household tz.
- **DAILY-MESSAGES-AC-06** Editing/deleting does not alter already-generated briefings (explicit regen only).
- **DAILY-MESSAGES-AC-07** Text stored verbatim; emoji/wrapping handled at render.

## Open Decisions

- None. (Emoji-at-authoring vs render-strip resolved: render-layer; max-length is a
  generous sanity cap, not a product feature.)

## Peer Review

Not peer-reviewed: small authoring domain, no new security or data-loss surface; every
rule is either cross-cutting precedent (`ADR-002/005/006/013/015/022/026/030`) or a cheap
v1-ambiguity cleanup (`ADR-048`). (Same rationale as Day Periods.)
