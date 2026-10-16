# Squash Migrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `drizzle/0000_current_baseline.sql` + `0001..0005` with one generated `drizzle/0000_baseline.sql`.

**Architecture:** `drizzle-kit generate` from `src/server/db/schema.ts`, plus hand additions (STRICT on three calendar tables, fixed rows, lifecycle seed via the runner's temp context). The runner and restore key on the new sentinel; `prior_baseline` lineage disappears.

**Tech Stack:** Node 24.21.0 (fnm), better-sqlite3, drizzle-kit 0.31, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-16-squash-migrations-design.md`

## Global Constraints

- Only one file in `drizzle/*.sql`: `0000_baseline.sql`. No `drizzle/meta`.
- `installation_lineage.kind` CHECK: `kind IN ('fresh')`.
- Members CHECK keeps exactly: blue, sky, teal, green, lime, amber, orange, red, pink, violet.
- `daily_briefing_optin.weekdays` is a nullable text column in the baseline.
- Never lower `minimumRates` in `tests/fixtures/assembly-cohort.json`; lower `minimumTotals` only where code shrank.

## Review Focus

1. Dev DB whose ledger holds `0000_current_baseline.sql` (+ deltas) → runner throws `Unsupported migration history.` before snapshot/write (Task 2 test).
2. Backup from the old lineage → restore `unsupported_lineage` (Task 3: existing pre-baseline test keeps covering it with the old name as "unknown sentinel").
3. Fresh DB catalog equals clean Drizzle generation including lifecycle tables (Task 1 test).
4. Member colour CHECK rejects `cyan` on a fresh DB (Task 1 test).
5. `npm run seed` on a fresh `DATA_DIR` and dev server boot (Task 5).

---

### Task 1: Generate the baseline and retarget schema tests

**Files:** Create `drizzle/0000_baseline.sql`; delete `drizzle/0000_current_baseline.sql`, `drizzle/0001..0005*.sql`; modify `src/server/db/schema.ts` (lineage CHECK); tests `tests/boundary/database-baseline.test.ts`, `tests/integration/database-baseline.test.ts`, `tests/integration/calendar-feed-sync-migration.test.ts`, delete `tests/boundary/member-palette-migration.test.ts`.

- [ ] Change the schema CHECK to `kind IN ('fresh')`; generate into scratch with a temp config (same as the integration test), copy to `drizzle/0000_baseline.sql`, prepend a header comment (regeneration recipe + hand additions), append ` STRICT` to the three calendar tables, append day_periods INSERTs (from old 0000) and the lifecycle seed (lineage from `temp.plugin_lifecycle_migration_context`, nine registry rows `inactive`, `updated_at = captured_at`).
- [ ] Prove the catalog equals the old chain modulo qualification/STRICT/FK-form via the scratch compare script.
- [ ] Integration test: compare only `BASELINE_FILE` (instantiate with temp context table created first) against generation without excluding lifecycle tables; ledger expectation `[{fileName:"0000_baseline.sql"}]`; add assertions: members CHECK rejects `'cyan'`, `daily_briefing_optin` has nullable `weekdays`.
- [ ] Boundary test: `readdirSync("drizzle")` `.sql` files equal `["0000_baseline.sql"]`; sentinel/day-period assertions retargeted.
- [ ] Calendar test: drop the "migrates a current-baseline source forward" case; build from the baseline file.
- [ ] Commit.

### Task 2: Migration runner on the new sentinel

**Files:** `src/server/db/migrate.ts`, `tests/boundary/plugin-lineage.test.ts`, `tests/boundary/plugin-lifecycle.test.ts`, `tests/boundary/migrate-runner.test.ts` (check only), `tests/fixtures/plugin-lifecycle/*`.

- [ ] Constants: one `BASELINE_MIGRATION = "0000_baseline.sql"`; context created when pending includes it; `classifyLifecycleHistory` returns fresh for empty ledger, else throws `Unsupported migration history.`; metadata assertion when ledger has the baseline. `kind: "fresh"` type.
- [ ] plugin-lineage tests: drop prior_baseline cases, retarget the context-handoff probe to the baseline file name, add the old-ledger refusal test (no snapshot directory created, ledger unchanged).
- [ ] Remove now-unused fixtures (`prior-baseline.sql`, `migrated-prior.sql`) if no users remain.
- [ ] Commit.

### Task 3: Restore lineage and plugin compatibility

**Files:** `src/server/backups/restore.ts:36`, `tests/boundary/backups-lineage.test.ts`, `tests/integration/backups-lineage.test.ts`, `tests/integration/backups-restore.test.ts`, `tests/integration/database-lifecycle-aggregate.test.ts`, `tests/integration/plugin-compatibility.test.ts`, `tests/integration/plugin-lifecycle-skeleton.test.ts`, `tests/e2e/plugin-lifecycle-visual.spec.ts`, `tests/helpers/schema-tables.ts`.

- [ ] Sentinel constant → `0000_baseline.sql`; all tests' file lists collapse to the baseline; prior-baseline matrix rows and restored-prior-baseline test deleted; e2e `seedFixture` drops its lineage parameter (always fresh).
- [ ] Commit.

### Task 4: Weekday integrity cleanup and docs

**Files:** `src/server/db/weekday-integrity.ts`, `tests/boundary/weekday-integrity.test.ts`, docs (ADR-017, `docs/architecture/database-lifecycle.md`, `docs/features/backups.md`, `docs/architecture/contracts/backups.md`, `docs/ui/plugin-management.md`, `docs/quality/boundary-guarantees.yaml` if wording names lineage values).

- [ ] Remove the missing-column skip and any test of it.
- [ ] Dated note "2026-10-16 squash": single baseline, pre-squash dev DBs and backups unsupported.
- [ ] Commit.

### Task 5: Verify and gate

- [ ] Fresh `DATA_DIR`: `npm run seed` succeeds; dev server starts and serves health.
- [ ] Clean detached checkout gate: `npm run check:standard`, then `check:aggregate-only` with the given ports; resync `tests/fixtures/assembly-cohort.json`.
- [ ] Write `REPORT-squash.md` (uncommitted).
