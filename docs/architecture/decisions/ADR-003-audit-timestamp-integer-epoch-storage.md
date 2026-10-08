# ADR-003 Audit Timestamp Encoding

Status: accepted
Owner: architecture
Decision date: 2026-07-31

## Context

UTC semantics do not determine a timestamp's on-disk encoding. STRICT tables
require each writer to agree with its column type, and DTO consumers need one
citable convention for operational timestamps.

## Decision

Audit and operational timestamp columns (`created_at`, `updated_at` and peers)
use INTEGER epoch-milliseconds in STRICT tables. Writers use `Date.now()` and
DTOs expose numbers. This refines ADR-005's UTC semantics.

| Kind                 | Purpose                                | Storage                         | Source      |
| -------------------- | -------------------------------------- | ------------------------------- | ----------- |
| Business date        | Household calendar day                 | TEXT YYYY-MM-DD                 | ADR-005/006 |
| Domain event instant | Timed event and originating wall-clock | TEXT ISO instant plus IANA TZID | ADR-062     |
| Audit timestamp      | Operational ordering and diagnostics   | INTEGER epoch-ms                | ADR-003     |

The convention is per purpose, not a SQLite prohibition on mixed column types.
One STRICT table may contain INTEGER and TEXT columns; rejection occurs when a
value mismatches its particular column. Audit timestamps may be displayed in
diagnostics without changing their storage encoding.

Plugin lifecycle and installation-lineage tables currently use ISO TEXT with
matching string DTOs and CHECKs. They work internally but do not satisfy the
integer convention. A bounded exception or a safe forward migration with consumer
checks remains an explicit open decision; documentation does not change data.

## Rationale

Epoch-ms matches Date.now() directly, avoids formatting/parsing for writes and
provides a UTC instant. Calendar TZID and business dates serve different domain
semantics and retain their own representations. Consistent column/DTO contracts
prevent latent STRICT insert failures.

## Empirical Evidence

The recorded SQLite probe establishes acceptance of integer epoch-ms and rejection
of an ISO string in an INTEGER STRICT column. It does not establish that TEXT audit
columns are inherently invalid or prove a migration has run.

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

## Acceptance Criteria

- Audit migrations use INTEGER epoch-ms and numeric DTOs unless an explicit
  bounded exception has been approved.
- Audit data-model annotations cite this encoding; each writer matches its column.
- Plugin lifecycle/lineage encoding remains unresolved until its exception or
  safe migration and consumer checks are accepted.

## Related Decisions

ADR-005/006 (time/date semantics), ADR-062 (timed events), ADR-055 (STRICT SQLite),
ADR-056 (forward-only migration safety).
