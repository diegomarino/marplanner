# ADR-017 Backup Restore Safety and Compatibility

Status: accepted
Owner: architecture + ops
Decision date: 2026-06-28

## Decision

Restore is the only operation that replaces all-domains database state at once, so
it is treated as destructive and rare — safety beats convenience. Restore is a
**reversible, version-checked, quiesced** operation:

**Safety (turn restore into an undoable transaction):**

1. **Automatic pre-restore snapshot, always.** Before swapping the active DB, take a
   snapshot tagged with a `pre-restore` filename prefix. Any restore is therefore
   reversible. Pre-restore snapshots are **exempt from normal retention prune**, but
   the lane is **bounded** (keep the last K≈5; older ones pruned by the lane's own
   count rule) so it cannot accumulate unbounded.
   **If the pre-restore snapshot write fails for any reason, restore aborts
   immediately and the active DB is not touched** — the net must exist before the
   swap, by definition.
2. **Reinforced confirmation: type the filename.** The admin must type the target
   backup filename to confirm. Proportionate friction against the wrong-row accident
   (the real family-kiosk risk is a fat finger, not an attacker). No heavier gate.
3. **Quiesce + force client reload; no process restart.** Drain/refuse writes around
   the file swap (tractable on a single instance with the ADR-014 in-flight guard) so
   no half-restored DB is observable. **All DB handles are force-closed before the
   file swap, and fresh connections are opened to the swapped path** — recycling
   existing connections is unsafe (open FDs keep referencing the old inode; a WAL
   checkpoint on an old-inode connection after the new file is in place can corrupt
   it). After success, signal clients to reload (reuses the Kiosk Shell PWA reload)
   because browser-local session/cache no longer matches the restored DB. No process
   restart is needed — force-close + reopen achieves the same effect.

**Compatibility (migration-lineage checked, not schema-diffed):**

Restore supports the installed baseline lineage and its migration-file subsets. Arbitrary historical upgrades are outside the first-release scope (`ADR-056`). The shared migration runner upgrades supported candidates; uploading a legacy SQLite file does not make it restorable (`ADR-026`).

4. Restore reads the **baseline sentinel and migration-file set** from inside the backup file (its own
   migrations table), **re-read at restore-execution time, not from the list cache**
   (per-action re-validation, consistent with the path-safety invariant in ADR-042).
   Compatibility is decided on the **supported baseline and migration-file set**, never on a
   field-by-field schema comparison (an unused/drifted table or column must not
   false-positive as "incompatible").
5. **Reject unsupported lineage and downgrade** — a backup without the supported baseline or with migrations unknown to the running code is
   refused (no supported backward migration path; prevents real corruption).
6. **A supported equal/subset migration set is allowed and migrated current within the restore
   sequence.** The restore flow **invokes the migration runner directly** — after the
   force-close/reopen (#3) and before unquiescing — never relying on a future process
   restart to migrate (without a restart, nothing else would). It is the same runner
   the app uses at startup, called explicitly here. The pre-restore snapshot (#1) is
   the net if a forward migration fails on old/dirty data.

## Rationale

Restore replaces members, sessions, settings, calendar, routines, meals, briefing
history, printing records, and telemetry simultaneously (spec §1). v1 has no
pre-restore snapshot, a generic confirm dialog, and no quiesce/reload (spec §6,
§11) — a wrong restore is irreversible data loss and may leave a half-restored DB.

Safety items #1 and #2 attack different axes: typing the filename lowers the
_probability_ of the error; the pre-restore snapshot lowers its _impact_. Both are
nearly free given snapshot machinery already exists. #3 fixes the technical
incoherence (new DB + stale client state), not human error.

On compatibility, comparing supported migration lineage (a _path_ token) rather than the
schema (a _state_ description) is what dissolves the "unused field/table drift"
concern: the migration chain already defines old→new, including dropped/ignored
objects, so structural drift is solved work, not ambiguity to detect. Forward
migrations are a proven, supported path (run every deploy); reusing them is cheap.
Downgrade has no supported path, so failing loudly is safer. The prod dump's 9 real
`routine_assignments` FK violations show old/dirty data is a genuine hazard — which
the pre-restore snapshot covers.

## Affected Specs

- `../../18-backups.md`
- `../../16-background-jobs-scheduler.md` (quiesce around ADR-014 in-flight guard)
- `../../15-kiosk-shell-navigation.md` (post-restore client reload)

## Data / Setup Implications

A `pre-restore`-prefixed snapshot is created on every restore and retained outside
normal prune. No new active-DB table is introduced (see ADR-042). No legacy DB
migration (ADR-026); the ADR-042 `.db`
upload path stores candidate files, but unsupported legacy lineage is rejected at restore.

## Acceptance Criteria

- Given a restore request, when confirmed, then a `pre-restore` snapshot exists
  before the active DB is replaced, and it is not removed by normal retention prune.
- Given a pre-restore snapshot write fails, when it errors, then restore aborts and
  the active DB is untouched.
- Given a restore confirmation, when the typed filename does not match the target,
  then restore does not proceed.
- Given a restore in progress, when concurrent writers exist, then no half-restored
  state is observable (writes quiesced, all DB handles force-closed before swap, fresh
  connections opened to the new path) and clients are signalled to reload on success;
  the process is not restarted.
- Given a restore is in progress, when a concurrent delete targets the `pre-restore`
  snapshot it depends on, then the delete is refused (restore-in-progress lock).
- Given a backup whose migration version is **newer** than the running code, when
  restore is attempted, then it is rejected with a clear downgrade error.
- Given a backup with the supported baseline and an equal/subset migration set, when restored, then the
  migration runner is invoked directly within the restore sequence (before
  unquiescing) and the DB is current without any process restart.
- Given a forward migration fails on restored old/dirty data, when it errors, then
  rolling back to the pre-restore snapshot returns the prior state with no loss.

## Open Questions

- Robust migrate-on-restore over arbitrarily old/dirty data is **deferred to
  evolution**; MVP relies on the existing startup migration path + pre-restore net.

## Traceability

- Conflicts: restore-safety open questions in `../../18-backups.md` §12
- Related prior: `ADR-017`
- Domain grill: `../domain-grills/backups.md`
- Related: `ADR-042` (backup storage/format/retention), `ADR-014`, `ADR-026`
