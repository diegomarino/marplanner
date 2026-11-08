# AGENTS.md

Marplanner is a self-hosted household planner for a shared kiosk display: one Fastify +
SQLite server that also serves a React (Vite) client, with optional features shipped as
plugins. [README](README.md) covers the product and deployment,
[CONTRIBUTING](CONTRIBUTING.md) the code rules and commit format; this file is the map
and the gotchas. `package.json` `scripts` is the source of truth for commands.

## Setup and run

Node `24.21.0` (`.nvmrc`) and npm `11.19.0`; `check:preflight` rejects other versions.

```sh
npm ci
cp .env.example .env.local   # local only; placeholders are the public demo credentials
npm run dev:fresh            # disposable .data-fresh store, seed public+private, start dev
npm run dev                  # or: long-lived per-worktree .data/ (seed with `npm run seed`)
```

`npm run dev` prints separate API and web URLs; the UI is on the web port. Seeds refuse a
database that already holds non-demo rows. Details:
[onboarding](docs/development/onboarding.md), [operations](docs/operations.md).

## Verify

Run the owning test first, then widen:

| Scope                    | Command                                                     |
| ------------------------ | ----------------------------------------------------------- |
| One client test          | `npm exec -- vitest run <file>`                             |
| One boundary/integration | `npm exec -- vitest run <file> --environment node`          |
| Tooling tests (`tools/`) | `npm test`                                                  |
| Tiers                    | `npm run test:unit`, `test:boundary`, `test:integration`    |
| Browser (Playwright)     | `npm run test:e2e` (specs in `tests/e2e/`)                  |
| Format / types / lint    | `npm run format:check`, `npm run typecheck`, `npm run lint` |
| Checkpoint               | `npm run check:fast`                                        |
| CI gate (`coverage.yml`) | `npm run check:standard`, then `check:aggregate-only`       |

Adding, renaming or removing a test or a `src/` file also means editing the
[cohort fixture](#cohort-fixture). `npm run format` fixes formatting; Prettier also covers
Markdown, so it is the doc lint.
Acceptance rules (candidate stamp, coverage floors, cohorts):
[verification](docs/quality/verification.md).

## Architecture map

- `src/server/`: `app.ts` builds the Fastify app, `index.ts` starts it. `routes/` (HTTP),
  `modules/<domain>/` (domain logic, persistence and side effects stay behind the owning
  module), `db/` (`schema.ts`, `migrate.ts`, `seeds/`), `plugins/`, `scheduler/`, `auth/`,
  `backups/`, `openapi/` (route schemas that generate `docs/api/openapi.json`).
- `src/client/`: one folder per feature (`home`, `calendar`, `chores`, `meals`,
  `daily-briefing`, `admin`, ...), shared UI in `components/`, strings in
  `i18n/messages.ts` (English and Spanish).
- `src/shared/`: pure types and helpers imported by both sides; no I/O.
- `drizzle/`: SQL migrations. `tests/`: `client/`, `boundary/`, `integration/`, `e2e/`,
  `fixtures/`. `tools/`: check, dev and deploy scripts with their own `*.test.mjs`.
- `docs/`: behavior in `features/`, interfaces in `architecture/contracts/`, rationale in
  `architecture/decisions/` (ADRs). Update the owning page with the behavior change.

## Conventions

- **Commits and PR titles**: Conventional Commits, header ≤100 chars, enforced by
  commitlint in CI ([CONTRIBUTING](CONTRIBUTING.md#commit-messages-and-pr-titles)). PRs are
  squash-merged, so the PR title becomes the `main` commit.
- **Branches**: work on a branch, never on `main`; parallel work goes in its own
  worktree under `.worktrees/` (ignored by lint and Prettier).
- **Migrations**: edit `src/server/db/schema.ts`, then add the next numbered forward file
  in `drizzle/` (`0003_<name>.sql`, ...). `0000_baseline.sql` is never edited.
  `tests/integration/database-baseline.test.ts` fails unless baseline plus every forward
  migration equals a fresh `drizzle-kit generate` of the schema. List the new file under
  "Forward migrations" in
  [database-lifecycle](docs/architecture/database-lifecycle.md#forward-migrations).
- **Plugin events**: build and lint run `npm run check:plugin-events` first (ADR-050);
  declare new events before calling them.

### Adding a daily-briefing block

A block is declared once and then implemented on each side. Pick a reference type of the
same kind (`wouldYouRather` if corpus-backed, `streakText` if not) and mirror it:

1. `src/shared/dailyBriefingBlocks.ts`: one `BRIEFING_BLOCKS` entry (`type`, `scope`, `kind`,
   `defaultEnabled`, corpus `languages`, `params`). The block-type unions, the server lists,
   the generation scope, the OpenAPI enums and the admin matrix rows and controls derive from
   it. Then `npm run generate:openapi`.
2. `npm run typecheck` now lists every remaining site, because each one is exhaustive over the
   catalogue:
   - generator `src/server/modules/daily-briefing/blocks/<name>.ts`, wired into a `switch` in
     `index.ts` (`generateLocalBlockData`, or `finishBlocks` for `kind: "external"`);
   - `render/blocks/<name>.ts` in `RENDER_BLOCKS` (`render/registry.ts`), its
     `render/adapter.ts` case, and its `render/labels.ts` title in `en` and `es`;
   - client: the `DailyBriefingView.tsx` case with its renderer in `blockRenderers.tsx`, and
     the `dailyBriefing.admin.blockType.<type>` key in `i18n/messages.ts` (en + es);
   - the `TYPE_FIXTURES` entry in `tests/integration/daily-briefing-render-defs.test.ts`.
3. Corpus-backed blocks: data in `corpora/` (English `.json`, optional `.es.json` sibling); a
   block without a corpus has no language override
   ([daily-briefing](docs/features/daily-briefing.md)).
4. Cohort fixture: the new `<name>.ts` files and every new test case go into
   `tests/fixtures/assembly-cohort.json` (see [Cohort fixture](#cohort-fixture)).

Done when `npm run typecheck` passes and the daily-briefing suites pass:
`npm exec -- vitest run tests/client/daily-briefing` and
`npm exec -- vitest run tests/integration/daily-briefing --environment node`.

## Cohort fixture

`tests/fixtures/assembly-cohort.json` is the reviewed inventory of the repo, and the most
often forgotten edit: local tests stay green while `check:standard` fails in CI. It has no
generator; every change that alters the inventory updates it by hand in the same commit.

| Change                                     | Fixture key                                                                                               | Enforced by                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Test case added, renamed or removed        | `testCohorts.runners.{node,vitest,playwright}.files` (file → titles; Playwright: test IDs)                | `check:test-cohorts:standard`, `check:test-cohorts`           |
| Production file under `src/` added/removed | `coveragePolicy.files` (`layer`, `minimumTotals`, `minimumRates`)                                         | `check:coverage`                                              |
| Route, scheduler job, plugin               | `coreRoutes`, `pluginRoutes`, `familyRouteIds`, `adminRouteIds`, `registeredJobIds`, `installedPluginIds` | `tests/integration/foundation-entrypoint.test.ts`             |
| OpenAPI contract, host API export          | `apiContracts`, `hostApiExportNames`                                                                      | `check:openapi`, `tests/boundary/foundation-host-api.test.ts` |

To resync test titles and coverage, from a clean worktree:

1. `npm run test:cohorts:stamp`, `npm run test:cohorts:node`,
   `npm run test:cohorts:vitest:list`, `npm run test:cohorts:vitest`.
2. Copy the new titles (`fullName`) from `.quality/vitest-results.json` and the new files'
   totals from `coverage/coverage-final.json` into the fixture; `normalizeVitest`
   (`tools/verify-test-cohorts.mjs`) and `fromV8Coverage` (`tools/verify-coverage.mjs`)
   produce the exact shapes. Then `npm run format`.
3. The fixture is part of the candidate hash: re-stamp (`npm run test:cohorts:stamp`), then run
   `npm run check:coverage && npm run check:test-cohorts:standard`.

Done when both checks in step 3 pass. A file below its reviewed `minimumRates` gets more
tests; the floors stay put.

## Gotchas

- **Candidate stamp**: `check:standard` stamps the tracked tree; stray untracked
  directories (for example `.playwright-mcp/`) or a nested worktree break it. Run it from a
  clean worktree.
- **OpenAPI drift**: a route or schema change needs `npm run generate:openapi`;
  `check:openapi` fails on a stale `docs/api/openapi.json`.
- **Generated files**: member colors, Noto emoji and the UI catalog have `generate:*`
  scripts with matching `check:*` freshness checks; regenerate, never hand-edit.
- **Pre-squash databases**: a `DATA_DIR` created before the 2026-10-16 migration squash
  fails with `Unsupported migration history.`; delete the database and reseed.
- **Auth layers**: the access gate (`MP_ACCESS_TOKEN`), device credential
  (`MP_BOOTSTRAP_KEY`) and UI PIN (`MP_ADMIN_PIN`) are separate; the PIN is advisory and
  never authorizes a backend request.
- **E2E**: Playwright builds and starts its own server on port `43173`; the real-clock
  `time-announcements.spec.ts` runs only via `npm run test:e2e:time-announcements`.
- **Install scripts**: `allowScripts` in `package.json` pins exact versions. A bump of a
  package with an install script (`argon2`, `better-sqlite3`, `esbuild`, ...) must update
  its entry; `npm install-scripts ls` lists the uncovered ones.
- **Private seeds**: `seeds/seed*-PRIVATE.*` are gitignored real household data. Copy them
  into a new worktree with `npm run seed:sync-private`; keep them out of commits and
  fixtures.
