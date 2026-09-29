# ADR-042 Backup Storage, Format, and Retention Model

Status: accepted
Owner: architecture + ops + security
Decision date: 2026-06-28

## Decision

Defines what a backup _is_, how it is stored/retained, and its security boundary
(restore _behavior_ is ADR-017).

**Format — `.db` only for import:**

- **Import accepts `.db` only.** The `.sql` execute-into-database import is removed.
  A backup is a database file, period.
- **`download-sql` is kept** as a read-only inspection/portability export — never a
  re-importable format.

Rationale: importing `.sql` executes foreign-authored code into the system (a
write/exec surface plus a dependency on an external `sqlite3` binary the spec flags
as a failure point); exporting `.sql` only serializes data already held (read-only).
Killing the dangerous direction loses no real value.

**Retention — count-primary, age-secondary, not configurable in MVP:**

- **Primary rule (count):** keep the N most recent backups (N≈14). This guarantees a
  floor — never zero backups regardless of elapsed time. It is the real protection.
- **Secondary rule (age):** among backups beyond the count, very old ones (>~30d)
  may be dropped, but **age can never reduce below the count floor**.
- **`pre-restore` snapshots are exempt** (ADR-017) — own lane / guaranteed minimum.
- **Not configurable in MVP** (sensible hardcoded constant, documented). **Not
  size-based** (disk-full is operational; count bounds size indirectly).
- Pruning runs only **after a confirmed-good new backup** (ADR-014) and never below
  the floor — never leaves zero backups.
- **Explicit admin delete also respects the floor:** a delete that would leave zero
  regular backups is refused, and a `pre-restore` snapshot cannot be deleted while a
  restore is in flight (restore-in-progress lock, ADR-017). The floor is not a
  prune-only rule.

Rationale: age-only retention can silently violate the guarantee that matters
(having _something_ to restore) under irregular kiosk uptime; mtime is fragile
(clock/copy). Count gives an existence guarantee; age is secondary frosting.

**Metadata — file-only, no active-DB manifest/audit:**

- **No manifest or audit table in the active DB.** A backup's metadata must not live
  in what the backup replaces — restore would destroy it (spec §6).
- **Metadata derived from the file:** schema version (for ADR-017) is read from the
  backup file's own migrations table (re-read at restore-execution time, not from the
  list cache); `type` and **`createdAt` are encoded in the filename at creation
  time** — mtime is advisory only, because mtime is fragile (an `rsync -a`/copy resets
  it and would otherwise make every backup look simultaneous, corrupting age-ordering
  and display).
- **Source encoded in the filename prefix** (`scheduled` / `snapshot` /
  `pre-restore` / `upload`) — restore-proof and sufficient.
- **No actor/session/event audit in MVP** (trusted family admins). If ever needed it
  belongs to Client Logging / Telemetry, not a Backups-owned table.

**Security — invariants:**

- Backup ops are an **authenticated, key-scoped admin backend class**, fail-closed
  (ADR-030/031/033), not route-visibility. Downloads are **sensitive exports**
  (contain all household data incl. session/auth rows) → same admin class.
- **Filename/path safety is an invariant:** filenames validated against an allowlist
  (`.db` + safe charset); reject `/`, `..`, and encoded forms; every operation
  resolves **inside the configured backups root** and never trusts the stale list
  (re-validate per action).
- Telemetry must never record backup file contents, SQL dumps, API keys, session
  IDs, or uploaded payloads.

**Legacy:** old v1 backup files are **not auto-migrated** (ADR-026); they remain
operator artifacts and can only re-enter via the `.db` upload path (subject to the
ADR-017 version check).

## Rationale

See per-section rationale above. The unifying design rule: a backup's truth (its
list, version, source) must live **outside** the active DB because restore replaces
the active DB — the same anti-"two-sources-of-truth" pattern applied elsewhere,
here forced by restore mechanics.

## Affected Specs

- `../../18-backups.md`
- `../../16-background-jobs-scheduler.md` (prune-after-confirmed-good, ADR-014)
- `../../19-client-logging-telemetry.md` (sensitive-payload exclusion)

## Data / Setup Implications

Backup files live in a configured `backups/` root outside the active DB. **The
"configured backups root" is `BACKUPS_ROOT`, defaulting to `${DATA_DIR}/backups`**
(host-coupling re-scan 2026-06-30; canonical env-var scheme in
`../target-dx-contract-v2.md` § _Operator Configuration & Runtime Environment_). No new
active-DB tables. Fresh v2 setup starts with zero backups; the scheduler's
domain-state catch-up (ADR-014) creates the first one. No legacy backup files
imported automatically (ADR-026).

## Acceptance Criteria

- Given a `.sql` upload, when imported, then it is rejected (import is `.db`-only).
- Given a listed backup, when `download-sql` is invoked, then a read-only SQL dump
  is produced without making it re-importable.
- Given more than N backups exist, when prune runs, then the N most recent (plus all
  `pre-restore` snapshots) are retained and prune never leaves zero backups.
- Given an old backup beyond the count, when only the age rule would remove it but
  doing so drops below N, then it is retained.
- Given an explicit admin delete that would leave zero regular backups, when invoked,
  then it is refused; given a delete of a `pre-restore` snapshot during an in-flight
  restore, then it is refused.
- Given a restore replaces the active DB, when it completes, then the backup list is
  still derivable (metadata lives in files, not the replaced DB).
- Given a filename containing `/`, `..`, or an encoded traversal, when any backup op
  receives it, then it is rejected and resolves only inside the backups root.

## Open Questions

- Configurable retention / count and size-based caps → evolution.
- Actor/session audit → evolution, via Telemetry if ever needed.

## Traceability

- Conflicts: backup format/retention/manifest open questions in `../../18-backups.md` §12
- Pre-v2: extends `ADR-017` scope; relates to `ADR-009` (atomicity), `ADR-026`
- Domain grill: `../domain-grills/backups.md`
- Related: `ADR-014`, `ADR-030`, `ADR-031`, `ADR-033`, `ADR-039`
