# Feature: Backups (operational snapshot & restore safety)

Behavior reference. The [owning contract](../architecture/contracts/backups.md) defines invariants and extension limits.

Backups is the operational-safety domain: an authenticated key-scoped admin can
snapshot the whole database, list / download (`.db` or read-only SQL export) /
import (`.db`) / restore / delete backup files. Backups are operational safety
data, **not** household planning content; backup files live **outside** the active
database in a configured `backups/` root, so their list, version, and source are
derived from files rather than any active-DB row. marplanner is a single
self-hosted instance, and restore is whole-database replacement — never a
per-domain merge — gated on the migration-version number and made reversible by an
automatic pre-restore snapshot.

## User workflows

### User Story 1 — Restore the database from a backup

An admin types the exact backup filename to confirm, the system takes a retained
`pre-restore` snapshot, re-reads and version-checks the backup, quiesces writes,
force-closes all DB handles, swaps to the backup, reopens fresh connections,
migrates current, and signals clients to reload — with no half-restored state ever
observable and no process restart.

### User Story 2 — Snapshot on cadence and prune safely

The scheduler (or an admin) creates a `snapshot`-prefixed `.db` atomically, and only
**after** a confirmed-good durable new backup exists does retention prune older
regular backups — never below the count floor, never to zero, and never touching a
`pre-restore` snapshot.

### User Story 3 — Import and export backup files safely

An admin uploads a `.db` file (validated extension, path-safe filename, atomic
write, suffixed on collision) or downloads a `.db` / on-demand read-only SQL export;
`.sql` execute-into-DB import is refused, and every path is resolved inside the
backups root.

### Edge Cases

- The pre-restore snapshot write fails → restore aborts and the active DB is left
  untouched (no swap attempted).
- A backup newer than the running code (downgrade) → restore is rejected before any
  swap.
- Forward migration fails after the swap → roll back to the pre-restore snapshot
  with no loss.
- A delete that would leave zero regular backups, or that targets a `pre-restore`
  snapshot during an in-flight restore → refused.
- A filename containing `/`, `..`, an encoded traversal form, or a non-`.db`
  extension → rejected before any filesystem op.
- An oversized upload → fails before a partial file is written.
- An unstattable entry in the backups root → skipped during list, not fatal.

## Requirements

### Functional Requirements

- **FR-001**: Given the backups domain, when the list, version, or source of a backup is derived, then it MUST be derived from the files in the backups root and there MUST NOT be any manifest, run, or audit table in the active DB, because a restore would destroy such a table. Contract: BACKUPS-INV-01.

- **FR-002**: Given a restore request, when it begins, then the system MUST first take an automatic `pre-restore` snapshot retained outside normal prune, and if that snapshot write fails the restore MUST abort with the active DB left untouched; the `pre-restore` lane MUST stay bounded to roughly the last K≈5. Contract: BACKUPS-INV-02.

- **FR-003**: Given a restore in progress, when the DB swap occurs, then writes MUST be quiesced around the swap and all DB handles MUST be force-closed before it with fresh connections opened to the new path (connections MUST NOT be recycled, owing to the old inode/WAL hazard), so that no half-restored state is observable; on success clients MUST be signalled to reload and the process MUST NOT be restarted. Contract: BACKUPS-INV-03.

- **FR-004**: Given a restore candidate, when its compatibility is decided, then the decision MUST be made on the migration-version number and never on a schema diff, a downgrade (backup newer than the running code) MUST be rejected, and a same-or-older backup MUST be accepted and migrated current by invoking the migration runner directly within the restore sequence. Contract: BACKUPS-INV-04.

- **FR-005**: Given retention enforcement, when it runs, then it MUST be count-primary (keep N≈14 most recent) with age as secondary, MUST never drop below the count floor and never leave zero backups, MUST prune only after a confirmed-good new backup, and MUST exempt `pre-restore` snapshots; an explicit admin delete MUST also respect the floor and MUST NOT remove a `pre-restore` snapshot during an in-flight restore. Contract: BACKUPS-INV-05.

- **FR-006**: Given an import operation, when a file is brought into the backups root, then only a `.db` upload MUST be accepted and a `.sql` execute-into-DB import MUST be refused, while `download-sql` MUST remain available as a read-only export. Contract: BACKUPS-INV-06.

- **FR-007**: Given any backup operation that names a file, when the name is validated, then it MUST pass an allowlist (`.db` extension + safe charset), `/`, `..`, and encoded traversal forms MUST be rejected, every op MUST resolve inside the backups root, and the stale list MUST NOT be trusted — the name MUST be re-validated per action. Contract: BACKUPS-INV-07.

- **FR-008**: Given any backup operation, when it is authorized, then it MUST require the authenticated key-scoped admin backend class and MUST be fail-closed, and downloads MUST be treated as sensitive exports within that same class. Contract: BACKUPS-INV-08.

- **FR-009**: Given a snapshot creation, when it executes, then it MUST NOT mutate any household domain row and MUST only write or prune files in backup storage. Contract: BACKUPS-INV-09.

- **FR-010**: Given a restore, when it is performed, then it MUST create a retained `pre-restore` snapshot before the swap, a mismatched typed filename confirmation MUST block the restore, half-restored state MUST NOT be observable, clients MUST reload on success, and the process MUST NOT be restarted (the acceptance surface for the reversibility/observability invariants in FR-002/FR-003). Contract: BACKUPS-AC-01.

- **FR-011**: Given a restore candidate's migration version, when it is checked, then a backup newer than the running code MUST be rejected as a downgrade, a same-or-older backup MUST be accepted and migrated current, and a failed forward migration MUST roll back to the pre-restore snapshot with no loss (the acceptance surface for the version-gating invariant in FR-004). Contract: BACKUPS-AC-02.

- **FR-012**: Given the import/export surface, when a `.sql` import is attempted it MUST be rejected, and when a `download-sql` is requested it MUST still produce a read-only export (the acceptance surface for the `.db`-only invariant in FR-006). Contract: BACKUPS-AC-03.

- **FR-013**: Given a prune, when it runs, then it MUST keep the N most recent plus all `pre-restore` snapshots, MUST never drop below the floor, MUST never leave zero backups, and MUST run only after a confirmed-good new backup (the acceptance surface for the retention invariant in FR-005). Contract: BACKUPS-AC-04.

- **FR-014**: Given a filename containing `/`, `..`, or an encoded traversal form, when any backup op receives it, then the op MUST be rejected and all ops MUST resolve inside the backups root (the acceptance surface for the path-safety invariant in FR-007). Contract: BACKUPS-AC-05.

- **FR-015**: Given a completed restore, when the backup list is requested, then it MUST still be derivable from file-derived metadata (no active-DB manifest required). Contract: BACKUPS-AC-06.

- **FR-016**: Given a backup run, when old backups are pruned, then the prune MUST occur only after a new durable backup exists, so pruning never runs against an unconfirmed or non-durable new backup (carried from Background Jobs; prune ordering/durability is Backups' domain action). Contract: BACKGROUND-JOBS-SCHEDULER-AC-06.

### Key Entities

- **Backup file**: a `.db` snapshot of the active database at a point in time,
  stored outside the active DB and restorable without depending on any active row.
  Its `createdAt` is encoded in the filename at creation (mtime is advisory only).
- **Pre-restore snapshot**: an automatic backup taken immediately before a restore,
  `pre-restore`-prefixed, exempt from normal retention prune and from explicit
  delete during an in-flight restore; the rollback target if forward migration
  fails. The lane is bounded (keep last K≈5).
- **Source prefix**: the filename prefix encoding origin — `scheduled` / `snapshot`
  / `pre-restore` / `upload` — used for display and restore-proof metadata, not as
  an auth boundary.
- **Migration-version stamp**: the monotonic schema/migration version read from
  inside a backup file (re-read at restore-execution time) and used to gate restore
  compatibility (reject downgrade; accept same-or-older).

## Success Criteria

- **SC-001**: Every restore is preceded by a durable, retained `pre-restore`
  snapshot; if that snapshot fails to write, 100% of such restores abort with the
  active DB unchanged.
- **SC-002**: 100% of restore-version decisions are made on the migration-version
  number — downgrades are rejected, same-or-older are migrated current, and failed
  forward migrations roll back to the pre-restore snapshot with no loss.
- **SC-003**: Retention and explicit delete never leave zero backups and never drop
  below the count floor; prune runs only after a confirmed-good durable new backup.
- **SC-004**: 100% of path-traversal or non-`.db` filenames, and 100% of `.sql`
  execute-into-DB imports, are rejected; every op resolves inside the backups root.

## Assumptions

- Auth & Sessions owns the authenticated key-scoped admin backend class and the
  fail-closed enforcement that gates all backup ops; this spec consumes that
  boundary (ADR-030/031/033) and does not define a second privilege tier.
- The scheduler (ADR-014) owns the scheduled backup cycle, household-tz cadence,
  startup catch-up, and the in-flight guard that prevents overlapping runs; it
  invokes the same snapshot + prune actions this spec defines.
- Fresh setup starts with zero backups; the scheduler's catch-up creates the
  first, and no legacy backup files are imported automatically (ADR-026) — a legacy
  `.db` re-enters only via upload, subject to the restore version check.
- Backup files may contain all household data (including auth/session rows) and are
  handled with active-DB sensitivity; telemetry must never record their contents,
  SQL dumps, keys, session IDs, or uploaded payloads.
- Atomic file writes (temp-write + rename, ADR-014) and household-tz timestamp
  display (ADR-005) are provided primitives.
