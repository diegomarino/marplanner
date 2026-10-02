# ADR-056 — Engineering Process / DX Baseline

Status: accepted
Date: 2026-06-30
Peer-reviewed: yes (codex, 2026-06-30 — folded with ADR-055)
Builds on: ADR-055 (stack). Depends on / reinforces: ADR-017/042 (backups), ADR-016 (telemetry/DX
split), ADR-015 (i18n parity), ADR-039 (plugin boundaries), ADR-028 (boundary validation),
ADR-046/054/025 (delete/archive lifecycle). Folds into [developer verification policy](../../quality/verification.md).

## Decision

The engineering processes, calibrated to a distributable single-instance self-hosted app built
substantially by AI agents. Governing meta-principle throughout: **convention → build-gate** — every
mechanizable rule is an enforced gate (lint/typecheck/drift/test), not prose; eliminate failure
modes by construction rather than by discipline.

### Dev loop & worktree-safety (Q11)

- **Inner loop:** `npm run dev` = Vite (HMR) proxying `/api` → Fastify (watch). Distinct automatically allocated API/frontend
  ports, with explicit `PORT`/`WEB_PORT` overrides and per-worktree `.data`. Only daily flow.
- **Detached worktree deploy:** a free on-demand capability via the ADR-055 image —
  `docker compose -p <wt> up -d/down`; status via `docker compose ls/ps --format json` (ports
  discovered, not pre-assigned). No bespoke worktree tooling; `gtr` et al. are personal ergonomics,
  out of the contract.
- **Same-origin API rule:** SPA is served by Fastify (ADR-055) → SPA calls **relative `/api`** via an
  `apiBase()` helper; lint bans absolute API base URLs. **`BASE_PATH` env** supports subpath
  reverse-proxy hosting — common self-hoster pattern (multiple apps under one domain). Fastify
  registers routes under it; the SPA's base path is **injected at runtime** (NOT Vite build-time
  `base`, which a single prebuilt image cannot vary per self-hoster — host-coupling re-scan
  2026-06-30). `BASE_PATH` is necessarily a **runtime** env, not a build-arg (a build-arg would
  force a rebuild per subpath, breaking ADR-055's pull-one-prebuilt-image distribution). Injection
  mechanism is an impl choice between two known patterns (placeholder + entrypoint rewrite of built
  assets, or Fastify templating `index.html` with `<base href>` + a runtime `window.__BASE_PATH__`
  for the router). [peer-review I-b]
- **Worktree-safety = externalized config** (per-worktree `DATA_DIR`, optional `DATABASE_PATH`), NOT a tool. The cause of the previous worktree failures (pnpm `nodeLinker:isolated` + monorepo + harness node_modules symlink → MODULE_NOT_FOUND +
  cache write-through corruption) is eliminated by ADR-055 single-package + npm. Residual rules:
  each worktree runs `npm ci`; **build caches/tsbuildinfo/Vite cache live OUTSIDE `node_modules`**.

### Check levels (Q12)

Current commands are defined by `package.json` and described in the [verification policy](../../quality/verification.md). The daily sequence is focused edit tests → broader `check:fast` checkpoint → exact `check:standard` acceptance → one `check:aggregate-only` browser milestone on unchanged bytes with retained valid standard evidence. A fresh `check:full` invocation combines both acceptance stages when no standard evidence is available.

- **`check:fast`**: formatting, generated member-color/emoji freshness, types and lint, plus all top-level Node tool tests and client unit tests. This command is not static-only.
- **`check:standard`**: early inventory/coverage-fingerprint/toolchain preflight, maintained candidate stamp, static/generated checks, production build, discovered Node and Vitest cohorts, instrumented coverage, OpenAPI checks, UI debt, exception-list and accessible-name gates, and standard evidence verification.
- **`check:full`**: standard plus retained-evidence/browser-environment preflight, built-render smoke, full Playwright discovery/execution and aggregate evidence verification. Container smoke remains a separate explicit command.

Run acceptance in a fresh validation worktree at the reviewed local candidate with its own `npm ci`. Development secrets and household data remain in the development checkout: ignored files still fail the strict candidate inventory. Preserve failed artifacts outside the validation tree before a retry; focused retries establish diagnosis, not a fabricated full pass. Historical release requirements below remain requirements until their implementation and runtime evidence exist.

### Tooling (Q13/Q14)

- **Tests:** Vitest + `fastify.inject` (boundary) + Testing Library/happy-dom + Playwright (e2e
  critical flows only).
- **Lint/format:** ESLint + Prettier; custom gate rules in a repo-local **`eslint-plugin-marplanner`**
  (chosen over Biome BECAUSE the architecture depends on many custom rules: Rule-B, plugin
  process.env ban, `apiBase()` use, `@/ui` reuse, i18n registry, typed event catalog).

### CI & release (Q15/Q15b/Q18)

- **GitHub Actions, 3 lanes:** PR (`check:standard` + drift, blocks merge) · Main (`check:standard` +
  build/push image to GHCR `:edge`) · Release (`check:full` + versioned image + evidence). **CI
  builds & publishes the artifact; it does NOT deploy** to self-hosters' boxes.
- **Versioning: SemVer.** MAJOR = breaking upgrade/migration baseline (Q16 consolidation) OR
  config/env format OR plugin API (ADR-039) OR external-integration contract. The ADR-017 DB version
  stamp IS this SemVer. **Conventional Commits + release-please**: a standing Release PR accumulates
  changes + computes the pending version (bookkeeping only, not feature code) and is the human gate +
  trigger; merging it → tag + GitHub Release + Release lane. Individual fixes only update the draft.
  Tag channels `:vX.Y.Z`/`:vX`/`:latest`/`:edge`; **`:vX` is the recommended self-hoster pinning
  channel** (auto minor/patch, no surprise MAJOR) [peer-review S-c]. First release `2.0.0`
  (`-alpha/-rc` during build-up).
- **Release evidence** on the GitHub Release: source/checks/migration/build-digest/smoke + **GitHub
  build-provenance attestation** (proportionate supply-chain hygiene when third parties run the
  image; cosign optional). Deploy/rollback = N/A (self-hoster owns).

### Migration policy (Q16)

- Drizzle-generated → **human-reviewed** SQL → commit; **append-only / forward-only**, NO
  down-migrations (rollback = restore pre-migration backup). Auto-applied at boot, idempotent
  (`__drizzle_migrations`), gates serving until done; single-instance ⇒ no cross-instance locking;
  multi-worker ⇒ migrations finish before any worker starts.
- **Auto-backup before apply, FAIL-FAST:** if the backup step returns non-zero (e.g. ENOSPC on a
  near-full home volume), abort the migration with a clear error — never proceed without a restore
  point [peer-review I-d]. **Migration failure surface:** human-readable stderr + nonzero exit (avoid
  a silent restart loop a non-sysadmin can't diagnose) + a `SKIP_MIGRATION` read-only escape hatch
  [peer-review I-e].
- Migrations **chain from ANY prior version** (distributable; never assume latest); newer-DB-on-older
  -app blocked by version stamp. **Never consolidate by default** — consolidation is a breaking
  change to the upgrade path (drops pre-baseline installs), allowed only as an explicit announced
  "min-supported-from vX" baseline = a MAJOR bump.

### Seeds (Q16b) — three sets, separation made unrepresentable-to-cross

1. **Essential/system** via **data migrations** (all envs, ordered, impossible to forget): default
   day-periods (ADR-010/011), initial household/settings row.
2. **Dev fixtures:** populated playground; **excluded from the prod image** + `NODE_ENV !==
'production'` guard with a loud refuse. Tests use programmatic per-test fixtures.
3. **Onboarding** (first-install prod, localized ADR-015, real example content; default-ON, wizard
   "start empty" deferred): **controlled deterministic IDs in a reserved namespace** + `INSERT …
ON CONFLICT(id) DO NOTHING` (idempotent vs re-run/edit/archive/partial-failure; never
   overwrites/un-archives). **`isExample` ⇒ archive-only**, enforced by a **`BEFORE DELETE` SQLite
   trigger (`RAISE(ABORT)`)** so it's bypass-proof even against in-process plugins doing raw `DELETE`
   - `ON DELETE CASCADE` (ADR-039/046) [peer-review L-b]. Reserved namespace enforced by a DB
     **CHECK constraint** `CHECK (id NOT LIKE 'example-%' OR is_example=1)` so a user ID can't silently
     block the seed [peer-review L-a]. Future caveat: any archived-row purge must exclude `isExample`.
     Prod image carries Set 1 + Set 3, NOT Set 2.

### Generated artifacts & component reuse (Q17)

- **Generated (4), each generator + drift check:** Drizzle migrations · OpenAPI spec
  (`@fastify/swagger`) · i18n key parity (ADR-015) · `COMPONENTS.md` (TypeScript export inventory; prop and cva contracts linked to maintained source). **API docs served LIVE at `/docs`** (not
  committed → can't drift). **NOT generated** (avoided by structure): API client types (shared via
  `src/shared`), route tree, ER diagram (YAGNI), design tokens (Tailwind config is source).
- **OpenAPI schema-coverage gate:** a Fastify `ready` hook asserts every route carries a schema
  (also serves ADR-028) [peer-review S-a].
- **Component-reuse (the agent-sprawl fear), three layers, NOT Storybook:** (1) one `@/ui` barrel;
  (2) **lint rejecting unsupported raw controls outside `src/client/components/ui/`** (`ui-policy` local rules; documented native recipes and exact domain exceptions) → inline
  re-invention fails CI; (3) the generated `COMPONENTS.md` catalog (agents read it before building
  UI). Storybook deferred (visual-only; weak for reuse — agents don't browse it).

### Contributor guardrails

Document runnable commands in [onboarding](../../development/onboarding.md) and verify them against `package.json`. Enforce module boundaries through lint and tests; keep generated artifacts under drift checks. A change to a shared contract requires consumer regression checks. Historical tool choices in this decision do not establish that a command or gate exists in the current repository.

## Implementation status (2026-10-02)

The implemented check workflow runs standard once in CI, then transfers and verifies its raw artifacts in the dependent browser job. Early preflights reject stale source policy and known environment mistakes before expensive work; they do not authenticate all historical execution inputs.

The coordinated local launcher and portable container recipe implement bounded
installation workflows. The shared boot/seed/restore migration runner creates a unique private logical SQLite
recovery snapshot through synchronous `VACUUM INTO`, including committed WAL data.
The snapshot file and containing directory are fsynced before migration ledger or
schema writes.
Snapshot failure aborts boot/seed; during restore it invokes existing rollback to
the original active pre-restore state. The migration snapshot captures the restored
older candidate, not that original active state. No pending migrations create no snapshot.
Fresh pending migrations also snapshot, and SQL failures retain the restore point.
Snapshots live under `BACKUPS_ROOT/pre-migration/snapshot-<unique>/database.db`, require
operator-managed disk space/retention, and are recovered offline outside the Admin
backup shelf. Failed attempts may leave partial files/directories; recovery requires
a completed, independently verified snapshot. These are logical snapshots, not
physical-byte copies. Explicit declared IDs survive; implicit rowids may change. See
[operations](../../operations.md#pre-migration-recovery-snapshots). Runtime `BASE_PATH`
injection, `SKIP_MIGRATION`, historical upgrade compatibility and remaining
distribution safety obligations are still open. The
container check is an explicit command; this ADR does not prove that every release
gate or publishing lane described above is implemented.

## Acceptance criteria

- A PR re-implementing a primitive inline (instead of `@/ui`) fails CI; a route without a schema fails
  CI; a stale generated artifact fails CI; a documented command absent from `package.json` is a documentation finding.
- A migration applied with a failed pre-backup aborts (no data-loss window); a migration failure
  surfaces a human-readable message and is recoverable via `SKIP_MIGRATION`.
- Onboarding example content survives archive but cannot be hard-deleted (trigger) and cannot be
  blocked by a user-chosen reserved-namespace ID (CHECK).
- The app runs correctly behind a subpath reverse proxy via `BASE_PATH`.

## Open questions

- ~~**OPEN (parked, structural):** "Vite `base` = `BASE_PATH`" collides with ADR-055's single
  prebuilt image.~~ **RESOLVED at spec level (2026-06-30):** the erroneous "Vite `base` = it" claim
  is corrected in the dev-loop section — `BASE_PATH` is a **runtime** env (build-arg is excluded as
  it would break the pull-one-prebuilt-image distribution), and the SPA base path is **injected at
  runtime**. The contradiction is gone; the only residual is the **impl choice of injection
  mechanism** (placeholder+entrypoint-rewrite vs Fastify `index.html` templating) — bounded, deferred
  to implementation, not a structural open question.
- Whether the wizard "start empty / start with examples" toggle ships in a later release (deferred).
- Follow-up (separate domain): ADR-016 security re-grill (telemetry ingest authorization vs ADR-030,
  browser-console pre-ingest leak, deny-list PII sufficiency) surfaced by Codex during this review.
