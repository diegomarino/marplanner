# ADR-048 Daily Messages Targeting and Authoring Rules

Status: accepted
Owner: product
Decision date: 2026-06-29

## Decision

Daily Messages is a small authoring domain = **ad-hoc per-member/date sticky notes**
whose only output channel is the personal `message` block in that member's Daily
Briefing. Not a reminder engine (no recurrence, no calendar gating, no rules); just
free text for one member on one household-local date.

**Targeting = active members (not child-only).** New messages target **active members**
(`ADR-002`); not restricted to children. Rationale: v2 de-gated the Daily Briefing from
child-only (`ADR-027` opt-in, any active member), and a daily message is only useful if
its recipient receives a briefing — restricting messages to children while briefings
serve any opted-in member would be incoherent. A message to a member who has no briefing
simply never surfaces (absence-tolerant), not an error. Adds Daily Messages evidence to
`ADR-002`. Archived/inactive members are inassignable for new writes; existing historical
rows stay readable (evidence only, `ADR-026`).

**Authoring rules:**

- **Whitespace text rejected.** Text is trimmed; empty-after-trim is rejected at the
  domain boundary (consistent with `ADR-047` recipe name). A blank editor field is a
  **no-op**, never an implicit delete; delete is a separate idempotent command.
- **Text stored verbatim** (`ADR-015` user-authored content, never translated). Emoji
  stripping and print wrapping are **render-layer** concerns (Daily Briefing/Printing),
  not authoring — the domain never mutates authored text. A generous sanity cap
  (≈500 chars) bounds abuse/print; no hard product max beyond that.
- **Missing recipient → not-found** for a non-existent member; a valid member with no
  messages → **empty list** (the two are distinguished, fixing v1's ambiguous empty).
- **List ordered by date ascending**, explicitly.
- **Window capped:** `days` bounded to a max (≈60); zero/negative rejected. Window stays
  half-open `[from, from+days)`.
- **No author audit.** Per-message last-write-wins text is sufficient; no who-authored
  history (calibration; → Telemetry if ever needed).

**Inherited by precedent:** dates strict `YYYY-MM-DD` household-local (`ADR-006`/
`ADR-005`); one message per `(member, date)`, save replaces text + advances `updatedAt`;
generated briefings snapshot the text (`ADR-022`) and are **not** auto-regenerated or
marked stale on message edit/delete (explicit regen only); parent/admin write
(`ADR-013`/`ADR-030`), no cross-member exposure; per-`(member,date)` last-write-wins, no
etag.

## Rationale

Almost everything is settled by cross-cutting precedent; the one real product fork was
targeting, resolved by consistency with the de-gated briefing. The authoring cleanups
remove v1 ambiguities (whitespace, missing-member reads, unordered lists, uncapped
windows) as cheap correctness wins without new machinery.

## Affected Specs

- `../../08-daily-messages.md`

## Data / Setup Implications

Owned: `daily_messages` (id, member_id, date, text, created_at, updated_at), unique on
`(member_id, date)`. Fresh v2 (`ADR-026`); 4 prod rows (active children, 1 date) are
evidence only.

## Acceptance Criteria

- A message can be authored for any active member; targeting is not child-gated.
- Whitespace-only text is rejected; a blank field writes nothing and does not delete.
- A message references an existing member; a write to a missing member fails.
- Reads for a non-existent member return not-found; a valid member with no messages
  returns an empty list ordered by date ascending.
- `days` beyond the cap or ≤ 0 is rejected; the window is half-open.
- Editing/deleting a message does not alter already-generated briefings (explicit regen
  only); text is stored verbatim with emoji/wrap handled at render.
- At most one message per `(member, date)`; re-save replaces text.

## Open Questions

- None.

## Traceability

- Pre-v2: extends `ADR-002` with Daily Messages targeting evidence; resolves spec `08`
  open questions.
- Domain grill: `../domain-grills/daily-messages.md`
- Related: `ADR-005`, `ADR-006`, `ADR-013`, `ADR-015`, `ADR-022`, `ADR-026`, `ADR-027`,
  `ADR-030`
