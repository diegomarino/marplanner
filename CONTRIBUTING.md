# Contributing to Marplanner

Contributions are offered under the project's [MIT license](LICENSE). Use Node.js `>=24.21.0 <25`; development and CI pin `24.21.0` and npm `11.19.0`.

## Start locally

```sh
npm ci
npm run build
npm run check:fast
```

For a running local server, use a writable persistent `DATA_DIR` and unique credentials as described in [operations](docs/operations.md). Copy `.env.example` to ignored `.env.local` only for local development, replace its placeholders, and never commit secrets. The public-only seed command is `npm run seed:public` and uses synthetic data. `npm run seed` and `npm run seed:all` run public then private profiles. The private seed command is for local overlays and must not be used for public fixtures or committed data.

## Change and verify

Keep server authorization, persistence and side effects behind their owning modules. Preserve the distinction between the frontend access gate, backend device credential and advisory UI PIN. Add a focused regression test for changed behavior, including failure and recovery when relevant. Changes to a shared primitive or contract need checks for all affected consumers.

Build and lint first validate plugin event declarations, source calls and namespace ownership with `npm run check:plugin-events` (ADR-050).

Run `npm run format:check`, `npm run typecheck`, `npm run lint`, and the relevant test tiers. `npm run check:standard` includes the client unit, boundary, integration, OpenAPI and accessibility checks; `npm run check:full` adds browser and built-render checks. Consult [verification](docs/quality/verification.md) for exact discovery, skip and instrumented coverage policy. Do not equate a boundary-guarantee reference with measured code coverage.

## Formatting, lint and comments

Prettier owns formatting; `.editorconfig` supplies matching editor defaults. Run `npm run format` before submitting changes. Lint rejects warnings and unused suppression directives. Local storage, worktrees and generated reports are outside lint's source scope; this does not change the stricter maintained-file inventory used for acceptance.

TypeScript uses its own unused-binding rule. Type-aware rules check production code and the client, boundary, integration and helper test files included in the two TSConfigs: promises must be awaited or have rejection handling, and asynchronous callbacks must match their caller's contract. A `void` expression marks deliberate dispatch only when the operation already handles failures; it does not catch a rejection. Tool/config TypeScript and browser tests retain syntax-based lint because they are outside those TSConfigs.

Write code, comments and documentation in English. Comments explain a constraint, decision or non-obvious reason; avoid narrating the code or keeping obsolete implementation history. Document public contracts where callers need them, without requiring JSDoc on every function. A TODO must explain what remains and the condition for resolving it, with an issue or maintained document reference when the work crosses files.

Lint exceptions must name the specific rule and explain the reason after `--`, preferably on the affected line. Remove an exception when it is no longer needed. `@ts-ignore` and `@ts-nocheck` are forbidden; `@ts-expect-error` requires a meaningful explanation of at least ten characters and is appropriate for deliberate invalid-type tests.

The published density behavior and its coordinated re-enable conditions are recorded in the [style guide](docs/development/style-guide.md#release-density-behavior).

The canonical design references are [principles](docs/architecture/principles.md), [contracts](docs/architecture/contracts/README.md), [decisions](docs/architecture/decisions/README.md), and [security](SECURITY.md). Update the relevant page when behavior or an interface changes. Keep instructions executable in this repository without access to any development or import workspace.

## Commit messages and PR titles

Write commit subjects and PR titles as [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, for example `feat(auth): add an admin Access keys page` or `fix(deploy): skip inactive plugins`. Types are `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style` and `test`; the scope is optional and open. Keep the header within 100 characters.

Pull requests are squash-merged, so the PR title becomes the commit subject on `main`. The `Conventional Commits` workflow lints every commit of a pull request against `commitlint.config.mjs`, skipping merge, revert and `fixup!` commits. It lints the title against `commitlint.title.config.mjs`, which allows no such exemption, so retitle a GitHub revert PR as `revert: <original subject>`. Check your branch locally with `npx commitlint --from origin/main --to HEAD`, or a title with `echo "feat(ui): ..." | npx commitlint --config commitlint.title.config.mjs`.
