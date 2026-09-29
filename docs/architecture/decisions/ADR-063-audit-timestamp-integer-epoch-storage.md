# ADR-063 Audit-Timestamp Storage — Integer Epoch-Milliseconds (and the Storage Time Taxonomy)

Status: accepted

Owner: architecture

Decision date: 2026-07-31

Peer-reviewed: no — architect-authored convention ratification surfaced during slice-004 T001
verification (PR #268). The convention is already established by existing code (cited below); the
STRICT-column encoding claim is **empirically probed** (below), per Constitution XIV.

## Context

Slice-004's first calendar migration (`T001`/PR #268) declared `created_at`/`updated_at` as
`INTEGER`, matching every existing table that carries audit timestamps (`members`, `api_keys`, `settings_objects`,
`admin_config`). But
the slice's `data-model.md` annotated those same columns as `text (ISO instant)`. Both descriptions
are "UTC" — they disagree only on the **storage encoding** (integer epoch-ms vs. text ISO-8601).

The disagreement is not cosmetic on a STRICT table: a writer that follows the `data-model.md`
annotation literally (`new Date().toISOString()`) inserts a TEXT value into an INTEGER column and is
**rejected at runtime** (probed below). So spec and implementation genuinely diverge, and the divergence
is latent until the first insert task (T007) runs.

The root cause is a gap in the decision record, not a new controversy:

- **ADR-005** fixed the _semantic_: _"`createdAt`, `updatedAt`, and similar audit fields are UTC. They
  record when something happened, not a business date."_ Epoch-milliseconds **is** a UTC instant (ms
  since `1970-01-01T00:00:00Z`), so the existing `INTEGER` columns already satisfy ADR-005.
- ADR-005 did **not** pin the on-disk _encoding_ (integer epoch vs. text ISO). The codebase filled
  that gap de facto (`Date.now()` → `INTEGER(...)` → DTO `created_at: number`); the design docs, with
  no canonical source to cite, guessed the other encoding.

This ADR pins the encoding ADR-005 left open, so the convention is **citable** and the divergence
stops recurring on every future table migration (Reminders, Routines, …). It refines ADR-005; it does
not contradict it.

## Decision

**Audit / operational timestamp columns** — the record-keeping "when did this happen" fields
(`created_at`, `updated_at`, and peers) — are stored as **`INTEGER` epoch-milliseconds (UTC)** in
STRICT tables: exactly the value `Date.now()` returns. The DTO exposes them as `number`. This is a
refinement of ADR-005 (which fixed the UTC semantic); epoch-ms is a UTC instant, so there is no
contradiction.

This positions audit timestamps as the third leg of the **storage time taxonomy** — three distinct
representations, split by purpose, each with a canonical source:

| Kind                              | Purpose                         | Example columns                    | Storage encoding                      | Source            |
| --------------------------------- | ------------------------------- | ---------------------------------- | ------------------------------------- | ----------------- |
| **Business date**                 | a calendar day, household-tz    | `birth_*`, `start_date`/`end_date` | `text` `YYYY-MM-DD`                   | ADR-005 / ADR-006 |
| **Domain event instant**          | a displayed moment, tz-paired   | `start_utc`/`end_utc` + `tzid`     | `text` ISO-8601 instant + IANA `tzid` | ADR-062           |
| **Audit / operational timestamp** | record-keeping, never displayed | `created_at`/`updated_at`          | **`INTEGER` epoch-ms (UTC)**          | ADR-063 (this)    |

**Why audit = integer but domain-instant = text** (the split is principled, not accidental): audit
timestamps are never displayed, never timezone-converted, and never inspected as domain values — they
exist for ordering and record-keeping, and `Date.now()` yields epoch-ms directly, so `INTEGER` is the
minimal STRICT-friendly encoding and it matches the entire existing schema. Domain event instants, by
contrast, **are** rendered in the household timezone, are paired with their originating `tzid`, and are
human-inspected during debugging — `text` ISO-8601 is legible and pairs naturally with the `tzid`
(ADR-062). Mixing the two encodings on one STRICT table is a runtime error, so a single citable rule
per purpose is what keeps writers correct.

## Empirical Evidence (Constitution XIV)

**Claim probed**: on a STRICT table, an `INTEGER` audit column accepts `Date.now()` epoch-ms and
round-trips it, while a `text` ISO-8601 instant is rejected.

**Probe** (`sqlite3` 3.51.0, matching the ADR-055 STRICT baseline):

```sql
CREATE TABLE t (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL) STRICT;
INSERT INTO t (id, created_at) VALUES ('a', 1753970100000);          -- epoch-ms
SELECT created_at FROM t WHERE id='a';                                -- reads 1753970100000
INSERT INTO t (id, created_at) VALUES ('b', '2026-07-31T13:00:00Z'); -- text ISO instant
```

**Observed**:

- Epoch-ms insert **accepted**; read back `1753970100000` exactly; reconstructs via
  `new Date(1753970100000)` / `datetime(created_at/1000,'unixepoch')`.
- Text ISO insert **rejected**: `Runtime error: cannot store TEXT value in INTEGER column
t.created_at (19)` (SQLite constraint / STRICT datatype mismatch).

**Observed existing practice** (the convention this ADR ratifies): every audit-timestamp column in the
pre-existing schema is `integer` — `members` (`created_at`/`updated_at`), `api_keys` (`created_at`),
`settings_objects` (`updated_at`), and `admin_config` (`updated_at`) across `src/server/db/schema.ts` +
`drizzle/0000_*.sql`; tables without audit columns (e.g. `day_periods`) simply omit them.
`src/server/db/migrate.ts` and `src/server/modules/members/index.ts` write `Date.now()`; the Members DTO
types `created_at: number`.

## Rationale

Integer epoch-ms is the information-complete, minimal encoding for a value whose only job is "when did
this happen": it is exactly what `Date.now()` produces (no parse/format round-trip), it is a UTC
instant (satisfying ADR-005), and it matches every existing audit-timestamp column so a STRICT schema stays
internally consistent. Pinning it in one citable ADR closes the doc-vs-impl divergence at its source —
future `data-model.md` files cite `ADR-063` instead of guessing — and prevents the T007-class latent
insert failure the probe reproduces.

## Affected Specs

- the Calendar data model — the `created_at`/`updated_at` cells must read
  `integer (epoch ms, UTC)`, not `text (ISO instant)`; corrected alongside its first consumer (PR
  #268), per the "contract-fix travels with the first consumer" policy.
- Every future slice `data-model.md` with audit timestamps cites `ADR-063` for those columns.
- Refines `ADR-005` (the UTC audit-field _semantic_ → this pins the _encoding_). Complements `ADR-062`
  (domain event instants) and `ADR-005`/`ADR-006` (business dates). the architecture contracts are unaffected
  (this is a storage-encoding detail the contracts leave to implementation).

## Data / Setup Implications

No schema change to existing tables — this ratifies what `members`, `api_keys`, `settings_objects`, and `admin_config` already do. New
tables declare audit columns `INTEGER NOT NULL` and write `Date.now()`. No legacy import (ADR-026).
`start_utc`/`end_utc` (domain instants, ADR-062) remain `text` ISO — this ADR governs audit timestamps
only, not domain time values.

## Acceptance Criteria

- Given any table with audit timestamps, when its migration is authored, then `created_at`/`updated_at`
  are `INTEGER NOT NULL` epoch-ms and the DTO exposes them as `number`.
- Given a `data-model.md` that annotates an audit timestamp, then it reads `integer (epoch ms, UTC)`
  citing `ADR-063`, never `text (ISO instant)`.
- Given a STRICT `INTEGER` audit column, when a writer persists a timestamp, then it writes `Date.now()`
  (an integer), never an ISO string — the latter is rejected at runtime (probed above).

## Traceability

- Surfaced by: the original Calendar migration review.
- Refines: `ADR-005` (household-tz / UTC audit-field semantic). Related: `ADR-006` (strict date
  validation), `ADR-062` (calendar timed-event instant storage), `ADR-055` (SQLite WAL/STRICT
  baseline), `ADR-026` (no legacy import).
- Constitution: IV (Time and Date Discipline), XIV (Empirical Evidence — probe above).
- **Not** added to the the decision checklist — matching the
  `ADR-059`/`ADR-060`/`ADR-061`/`ADR-062` precedent for architect-authored implementation-time ADRs;
  discoverable via this Traceability and the slice that surfaced it.
