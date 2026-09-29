# Feature: Daily Messages (briefing content source)

Behavior reference. The [owning contract](../architecture/contracts/daily-messages.md) defines invariants and extension limits.

Daily messages are parent/admin-authored **per-member/date sticky notes**: short free
text written for one member on one household-local date. A message surfaces as the
personal `message` block in that member's Daily Briefing. This is not a reminder engine —
no recurrence, no calendar gating, no rules. Absence of a message means no block.

## User workflows

### User Story 1 — Write a sticky note for a member/date

A parent writes a short note ("don't forget your swim kit") for an active member on a
specific household-local date; re-saving for the same `(member, date)` replaces the text
and advances `updatedAt`, so there is always at most one note per pair.

### User Story 2 — Read a member's notes over a window

A parent lists a member's messages over a half-open date window `[from, from+days)`,
date-ascending; a valid member with no notes returns an empty list, while an unknown
member returns not-found.

### User Story 3 — Edit after a briefing was generated

A parent edits or deletes a note after a briefing was already generated; the generated
briefing keeps the snapshotted text and does not auto-regenerate, so reflecting the change
requires an explicit Daily Briefing regeneration.

### Edge Cases

- Whitespace-only text is rejected; a blank field is a no-op and never deletes.
- Deleting a message that does not exist succeeds as an idempotent no-op.
- A `days` value beyond the cap (≈60) or ≤ 0 is rejected; the window is half-open.
- A note to an inactive/archived member is rejected for new writes; historical rows stay
  readable.

## Requirements

### Functional Requirements

- **FR-001**: Given a `(member, date)` pair, when a message is saved, then at most one row MUST exist for that pair and a re-save MUST replace its text and advance `updatedAt`, and delete is a separate idempotent command while a blank field is a no-op that never deletes. Contract: DAILY-MESSAGES-INV-01.

- **FR-002**: Given a new daily-message write, when its recipient is resolved, then the target MUST be an active member (not child-gated) and inactive/archived members MUST be rejected for new writes, and historical rows for them stay readable while a message to a member without a briefing simply never surfaces. Contract: DAILY-MESSAGES-INV-02.

- **FR-003**: Given a message date or list window, when it is validated at the boundary, then the date MUST be a strict calendar-valid `YYYY-MM-DD` interpreted in household-local time and the window MUST be half-open `[from, from+days)` with `days` capped (≈60) and zero/negative rejected. Contract: DAILY-MESSAGES-INV-03.

- **FR-004**: Given message text, when it is written, then it MUST be required and trimmed and non-empty after trim and stored verbatim (never translated), and emoji stripping / print wrapping stay render-layer concerns under a generous sanity cap (≈500 chars). Contract: DAILY-MESSAGES-INV-04.

- **FR-005**: Given a briefing that was generated, when its message text was snapshotted at generation, then later edits or deletes MUST NOT mutate the generated payload and MUST NOT auto-regenerate or mark it stale, and regeneration MUST remain an explicit Daily Briefing action. Contract: DAILY-MESSAGES-INV-05.

- **FR-006**: Given a daily-message write, when authorization is checked, then only a parent/admin MUST be permitted to write, and a message MUST be exposed only via its recipient's own briefing with no cross-member leak. Contract: DAILY-MESSAGES-INV-06.

- **FR-007**: Given concurrent writes to the same `(member, date)`, when they are persisted, then last-write-wins MUST be applied and no etag or version MUST be required. Contract: DAILY-MESSAGES-INV-07.

- **FR-008**: Given a read for a member, when the member is missing, then it MUST return not-found, and when the member is valid with no messages it MUST return an empty list ordered by date ascending. Contract: DAILY-MESSAGES-INV-08.

- **FR-009**: Given a `(member, date)` pair, when a second message is saved for it, then at most one message MUST exist per pair and the re-save MUST replace the text. Contract: DAILY-MESSAGES-AC-01.

- **FR-010**: Given an authoring request, when the target is any active member, then the write MUST be allowed (not child-gated) and inactive members MUST be rejected for new writes. Contract: DAILY-MESSAGES-AC-02.

- **FR-011**: Given a write whose text is whitespace-only, when it is validated, then it MUST be rejected, and a blank field MUST write nothing and never delete. Contract: DAILY-MESSAGES-AC-03.

- **FR-012**: Given a request referencing a member, when the member is missing on write, then the write MUST fail and a read of that missing member MUST be not-found, and a valid member with no messages MUST return an empty date-ascending list. Contract: DAILY-MESSAGES-AC-04.

- **FR-013**: Given a list request, when `days` exceeds the cap or is ≤ 0, then it MUST be rejected, and the window MUST be half-open with dates strict and interpreted in household tz. Contract: DAILY-MESSAGES-AC-05.

- **FR-014**: Given an already-generated briefing, when a message is edited or deleted, then the generated briefing MUST NOT be altered and only an explicit regeneration reflects the change. Contract: DAILY-MESSAGES-AC-06.

- **FR-015**: Given message text, when it is stored, then it MUST be persisted verbatim and emoji and wrapping MUST be handled at render. Contract: DAILY-MESSAGES-AC-07.

### Key Entities

- **Daily message**: one note for a `(member, date)` pair. Attributes: stable id,
  recipient member id, household-local date, verbatim text, created/updated timestamps.
  Unique on `(member_id, date)`.
- **Recipient**: an active member (ADR-002); the note's only output is that member's own
  Daily Briefing.

## Success Criteria

- **SC-001**: 100% of `(member, date)` pairs hold at most one message; a re-save replaces
  text rather than appending a row.
- **SC-002**: Editing or deleting a message changes 0 already-generated briefings (snapshot
  model; explicit regeneration only).
- **SC-003**: A valid member with no messages returns an empty date-ascending list and a
  missing member returns not-found — the two cases are never conflated.

## Assumptions

- Daily Briefing owns block enable/order/schedule settings (ADR-008); this domain owns no
  settings and is read by Daily Briefing at generation as a pull-time content source.
- Member active-state and identification are owned upstream (ADR-002/ADR-048); this spec
  validates recipient existence and active-state at the write boundary only.
- Fresh v2 data store (ADR-026); the 4 prod rows are evidence only, not imported.
- Date and household-timezone derivation primitives are provided per ADR-005/ADR-006.
