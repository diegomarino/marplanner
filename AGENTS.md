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

`npm run format` fixes formatting; Prettier also covers Markdown, so it is the doc lint.
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

A block type is registered at every one of these sites. Pick a reference type of the same
kind (`wouldYouRather` if corpus-backed, `streakText` if not) and mirror it:

1. `src/shared/dailyBriefing.ts`: the block-type union.
2. `src/server/modules/daily-briefing/corpora/block-types.ts`: `ALL_BLOCK_TYPES`; a
   corpus-backed type also joins `CORPUS_BLOCK_TYPES` and `CORPUS_LANGUAGE_AVAILABILITY`.
3. `src/server/modules/daily-briefing/blocks/<name>.ts` (generator), wired in
   `index.ts`: import, scope map (`shared` or `member`), and the generation `switch`.
4. `render/blocks/<name>.ts`, registered in `render/registry.ts`; `render/adapter.ts`
   case; `render/labels.ts` title in `en` and `es`.
5. `src/server/openapi/daily-briefing.ts`: both enum lists, then
   `npm run generate:openapi`.
6. Client: `daily-briefing/admin/briefingBlocks.ts` (order, label key, corpus languages),
   `DailyBriefingView.tsx` and `blockRenderers.tsx`, keys in `i18n/messages.ts` (en + es).
7. Corpus-backed blocks: data in `corpora/` (English `.json`, optional `.es.json` sibling); a
   block without a corpus has no language override
   ([daily-briefing](docs/features/daily-briefing.md)).

Done when both of these hold:

- In each shared registration file of steps 1, 2 and 4–6 (the per-type `<name>.ts` files
  aside), `grep -c <newType>` matches `grep -c <referenceType>`, any gap explained by a
  type-specific key such as `wouldYouRatherOr`.
- The daily-briefing suites pass, including the admin mirror fence that compares the
  client language map with the server registry:
  `npm exec -- vitest run tests/client/daily-briefing` and
  `npm exec -- vitest run tests/integration/daily-briefing --environment node`.

## Gotchas

- **Cohort fixture**: a new test case or production file makes `check:standard` fail until
  `tests/fixtures/assembly-cohort.json` lists it (test titles under
  `testCohorts.runners.vitest.files`, coverage minimums under `coveragePolicy.files`).
  No generator exists; edit it by hand from `.quality/vitest-results.json` and
  `coverage/coverage-final.json`, then run `npm run format`. Meet a coverage floor with
  tests; the floors stay put.
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
