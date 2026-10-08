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
- **`check:standard`**: early inventory, coverage-cohort and toolchain preflight, maintained candidate stamp, static/generated checks, production build, discovered Node and Vitest cohorts, instrumented coverage, OpenAPI checks, UI debt, exception-list and accessible-name gates, and standard evidence verification.
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
  config/env format OR plugin API (ADR-039) OR external-integration contract. A future release/DB compatibility policy must define its relationship to migration lineage; the installed ADR-017 gate uses baseline and migration-file sets, not a SemVer stamp. **Conventional Commits + release-please**: a standing Release PR accumulates
  changes + computes the pending version (bookkeeping only, not feature code) and is the human gate +
  trigger; merging it → tag + GitHub Release + Release lane. Individual fixes only update the draft.
  Tag channels `:vX.Y.Z`/`:vX`/`:latest`/`:edge`; **`:vX` is the recommended self-hoster pinning
  channel** (auto minor/patch, no surprise MAJOR) [peer-review S-c]. First release `2.0.0`
  (`-alpha/-rc` during build-up).
- **Release evidence** on the GitHub Release: source/checks/migration/build-digest/smoke + **GitHub
  build-provenance attestation** (proportionate supply-chain hygiene when third parties run the
  image; cosign optional). Deploy/rollback = N/A (self-hoster owns).

### First-release scope

Release versioning policy, arbitrary historical upgrade compatibility and
`SKIP_MIGRATION` read-only mode are outside the first-release scope. Their designs
remain future requirements. This scope preserves pre-migration recovery snapshots,
fail-fast backup errors, storage ownership, request/job drain and recovery data.

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

### Seeds

Essential/system values are established through ordered data migrations. Public
and private synthetic seed profiles require an explicitly disposable target; they
must not run at container startup or overwrite active household data.

The public disposable demo profile activates all nine installed plugins through
the normal lifecycle after seeding domain content and before private overlays.
Rerunning the profile reactivates disabled demo plugins. Activation retains
configured settings and does not execute scheduled jobs or external work.

Production onboarding examples are not implemented and their release disposition
remains undecided. A future design must decide whether examples are useful and
define deterministic identity, idempotence, archival/deletion behavior and
reserved-namespace enforcement before enabling them. Synthetic fixtures do not
establish production onboarding acceptance.

### Generated artifacts & component reuse (Q17)

- **Generated (4), each generator + drift check:** Drizzle migrations · OpenAPI spec
  (`@fastify/swagger`) · i18n key parity (ADR-015) · `COMPONENTS.md` (TypeScript export inventory; prop and cva contracts linked to maintained source). **API contracts are maintained under `docs/api/` with the installed route/shape drift gates**; a live `/docs` serving surface is not part of the documented installed API. **NOT generated** (avoided by structure): API client types (shared via
  `src/shared`), route tree, ER diagram (YAGNI), design tokens (Tailwind config is source).
- **OpenAPI schema-coverage gate:** a Fastify `ready` hook asserts every route carries a schema
  (also serves ADR-028) [peer-review S-a].
- **Component-reuse (the agent-sprawl fear), three layers, NOT Storybook:** (1) one `@/ui` barrel;
  (2) **lint rejecting unsupported raw controls outside `src/client/components/ui/`** (`ui-policy` local rules; documented native recipes and exact domain exceptions) → inline
  re-invention fails CI; (3) the generated `COMPONENTS.md` catalog (agents read it before building
  UI). Storybook deferred (visual-only; weak for reuse — agents don't browse it).

### Contributor guardrails

Document runnable commands in [onboarding](../../development/onboarding.md) and verify them against `package.json`. Enforce module boundaries through lint and tests; keep generated artifacts under drift checks. A change to a shared contract requires consumer regression checks. Verify every documented command and gate against the current repository before relying on it.

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
[operations](../../operations.md#pre-migration-recovery-snapshots). Runtime `BASE_PATH` now uses portable relative build assets and server HTML base/meta injection, with prefixed API/gate routes and client URL/navigation helpers. Root `/health` is preserved. Built-browser/container acceptance and applicable storage safety checks remain required for the launch candidate. Versioning policy, `SKIP_MIGRATION` and arbitrary historical upgrade compatibility are explicitly deferred until after launch. The
container check is an explicit command; this ADR does not prove that every release
gate or publishing lane described above is implemented.

## Acceptance criteria

- A PR re-implementing a primitive inline (instead of `@/ui`) fails CI; a route without a schema fails
  CI; a stale generated artifact fails CI; a documented command absent from `package.json` is a documentation finding.
- A migration applied with a failed pre-backup aborts (no data-loss window); a migration failure
  surfaces a human-readable message and retains a verified recovery point. The
  `SKIP_MIGRATION` mode is deferred until after launch by the first-release scope above.
- Onboarding example content survives archive but cannot be hard-deleted (trigger) and cannot be
  blocked by a user-chosen reserved-namespace ID (CHECK).
- The app runs correctly behind a subpath reverse proxy via `BASE_PATH`.

## Open questions

- Decide whether production onboarding examples belong in the first release and,
  if so, define their identity, idempotence and data-safety policy before enabling them.
- The shared i18n dynamic-key and plugin-event requirements remain tracked in
  ADR-015/050/061; no new parallel runtime should be introduced.
