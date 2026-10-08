# Backups Domain Contract

Status: maintained contract
Depends on decisions: `ADR-017`, `ADR-042`, `ADR-014`, `ADR-005`, `ADR-009`, `ADR-026`, `ADR-030`, `ADR-031`, `ADR-033`, `ADR-039`, `ADR-040`

## Purpose

Operational safety domain: an authorized admin can **snapshot** the whole database,
**list / download (DB or SQL export) / import (.db) / restore / delete** backup
files. Backups are operational safety data, **not** household planning content.
Backup files live **outside** the active database, in a configured `backups/` root.
marplanner is a **single self-hosted instance**.

## Vocabulary

- **Backup file** — a `.db` snapshot of the active database at a point in time,
  stored outside the active DB. Restorable without depending on any active row.
- **Snapshot** — the act of creating a backup file.
- **Restore** — whole-database replacement of the active DB by a backup's content.
  Never a per-domain merge.
- **Pre-restore snapshot** — an automatic backup taken immediately before a restore,
  `pre-restore`-prefixed, exempt from normal retention prune (ADR-017).
- **Source prefix** — filename prefix encoding origin: `scheduled` / `snapshot` /
  `pre-restore` / `upload`. Display + restore-proof metadata, **not** an auth boundary.
- **Regular retention lane** — scheduled/manual snapshots. Uploaded files are exempt
  from automatic pruning and require explicit deletion; pre-restore has its own lane.
- **Migration lineage** — the baseline sentinel and migration-file set read from inside a backup at restore-execution time. Unsupported lineage or unknown migrations are refused; supported equal/subset sets can restore and migrate (ADR-017/056).
- **`createdAt`** — encoded in the filename at creation time; mtime is advisory only
  (mtime is fragile under copy/rsync) (ADR-042).

## Invariants

1. **BACKUPS-INV-01** **Backup truth lives outside the active DB.** No manifest/audit table in the
   active DB; restore would destroy it. List/version/source derive from files
   (ADR-042).
2. **BACKUPS-INV-02** **Restore is reversible:** every restore is preceded by an automatic
   `pre-restore` snapshot retained outside normal prune; **if that snapshot write
   fails, restore aborts and the active DB is untouched** (ADR-017). The pre-restore
   lane is bounded (keep last K≈5).
3. **BACKUPS-INV-03** **No half-restored state is observable:** restore quiesces writes around the DB
   swap (single instance + ADR-014 in-flight guard); **all DB handles are force-closed
   before the swap and fresh connections opened to the new path** (recycling
   connections is unsafe — old inode/WAL hazard); on success clients are signalled to
   reload; the process is not restarted (ADR-017).
4. **BACKUPS-INV-04** **Restore compatibility uses supported baseline lineage and migration-file sets, never a schema diff.** Missing baseline is unsupported lineage; unknown migrations are rejected as downgrade. Supported equal/subset sets are **migrated current by invoking the migration runner directly within the restore sequence** (ADR-017/056); arbitrary historical compatibility is deferred.
5. **BACKUPS-INV-05** **Retention guarantees existence:** count-primary (keep N≈14 most recent),
   age-secondary, never below the regular count floor when enough backups exist; prune only after a confirmed-good new backup. Pre-restore snapshots use a separate last-K lane (currently five). **Explicit admin delete preserves one regular backup** and cannot remove a pre-restore snapshot during an in-flight restore (ADR-042/017/014).
6. **BACKUPS-INV-06** **Import is `.db`-only;** `.sql` execute-into-DB import is removed. `download-sql`
   remains a read-only export (ADR-042).
7. **BACKUPS-INV-07** **Filename/path safety:** allowlist (`.db` + safe charset); reject `/`, `..`, and
   encoded forms; every op resolves inside the backups root; never trust the stale
   list — re-validate per action (ADR-042).
8. **BACKUPS-INV-08** **Auth:** all backup ops are an authenticated key-scoped admin backend class,
   fail-closed (ADR-030/031/033); downloads are sensitive exports in the same class.
9. **BACKUPS-INV-09** Snapshot creation does not mutate household domain rows; it only writes/prunes
   files in backup storage.

## Behaviors

- **Create snapshot:** write a `snapshot`-prefixed `.db` (atomic temp-write + rename,
  ADR-014), then prune per retention. Prune failure does not fail the snapshot but is
  surfaced (not silently swallowed); a successful snapshot is reported only when the
  file is durable.
- **List:** read the backups root; return `.db` files newest-first; skip unstattable
  entries; create the directory if missing. Operational timestamps display in
  household tz (ADR-005).
- **Import (.db upload):** validate extension/filename, write atomically, suffix on
  name collision; reject `.sql` and path-like names. Oversized uploads fail before
  writing partial files.
- **Download (.db) / download-sql:** read the selected file; `download-sql` generates
  a read-only dump on demand. Sensitive export — same admin class.
- **Restore:** require a typed-filename confirmation match; take the `pre-restore`
  snapshot (abort if it fails); re-read supported lineage/migrations (reject unsupported lineage and downgrade);
  quiesce writes; force-close all DB handles; swap; reopen fresh connections; invoke
  the migration runner directly; signal clients to reload; on forward-migration
  failure, roll back to the pre-restore snapshot (ADR-017).
- **Delete:** validate filename; delete only the backup file; never mutate the active
  DB; **refuse if it would leave zero regular backups, and refuse to delete a
  `pre-restore` snapshot during an in-flight restore** (restore-in-progress lock).
- **Scheduled backup cycle & catch-up:** owned by the scheduler (ADR-014):
  domain-state catch-up — if no backup exists within the window, make one on startup;
  household-tz cadence; in-flight guard prevents overlap.

## Interfaces

Conceptual admin operations (transport per Auth contract): `createSnapshot`,
`listBackups`, `importBackup(.db)`, `downloadBackup`, `downloadSqlExport`,
`restoreBackup(filename, typedConfirmation)`, `deleteBackup(filename)`.
The scheduler (ADR-014) invokes the same snapshot + prune actions on cadence.

## Events

(ADR-040.) Backups owns no household events. It **emits** an operational signal on
successful restore so clients reload (consumed by Kiosk Shell's reload mechanism);
this is a notification, never state. It **subscribes** to nothing. Backup action
failures may be reported to Client Logging / Telemetry (without sensitive payloads),
not via the domain event bus.

## Data / Setup Contract

Backup files live in a configured `backups/` root outside the active DB. No
active-DB tables for manifests, runs, or audit. Fresh setup starts with zero
backups; the scheduler's catch-up creates the first. No legacy backup files imported
automatically (ADR-026). Upload stores a candidate file; unsupported legacy lineage cannot be restored. Backup files may contain all household data (incl. auth/
session rows) and must be handled with active-DB sensitivity; telemetry must never
record their contents, SQL dumps, keys, session IDs, or uploaded payloads.

## Acceptance Criteria

- **BACKUPS-AC-01** Restore creates a retained `pre-restore` snapshot before swap; mismatched typed
  filename blocks restore; no half-restored state observable; clients reload on
  success; no process restart.
- **BACKUPS-AC-02** Missing supported baseline → unsupported lineage; migrations unknown to running code → downgrade rejected; supported equal/subset migration sets → restore and migrate; failed forward migration → rollback to pre-restore with no loss.
- **BACKUPS-AC-03** `.sql` import rejected; `download-sql` still works read-only.
- **BACKUPS-AC-04** Normal prune keeps the N newest regular backups plus younger beyond-N backups and runs only after a confirmed-good new backup; pre-restore uses its own last-K lane. Explicit delete refuses to remove the last regular backup.
- **BACKUPS-AC-05** Path traversal (`/`, `..`, encoded) rejected; all ops resolve inside the root.
- **BACKUPS-AC-06** After a restore, the backup list is still derivable (file-derived metadata).
- **BACKGROUND-JOBS-SCHEDULER-AC-06** Given a backup run, old backups are pruned only after a new durable backup exists. _(carried from Background Jobs; prune ordering/durability is Backups' domain action. See boundary-ledger.yaml.)_

## Open Decisions

- Configurable retention/count + size-based caps — evolution (ADR-042).
- Actor/session restore audit — evolution, via Telemetry if needed (ADR-042).
- Robust migrate-on-restore over old/dirty data — evolution (ADR-017).
- Download error UI parity — deferred to UI build (known UX debt).
