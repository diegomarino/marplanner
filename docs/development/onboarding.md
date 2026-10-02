# Developer onboarding

Use Node.js `>=24.21.0 <25` (development and CI use `24.21.0`) and npm `11.19.0`.

```sh
npm ci
cp .env.example .env.local
# Replace the synthetic credentials in .env.local before starting.
npm run dev
```

Copy `.env.example` to ignored `.env.local` and replace the synthetic credentials before starting development. `npm run dev` owns the watched API and Vite frontend, reports their distinct URLs, and defaults to persistent per-worktree `.data/`. Exported variables override `.env.local`. [Operations](../operations.md) documents credentials, storage and provisioning. Keep secrets and household data out of commits.

Stop the launcher before running `npm run dev:server` for API diagnostics. Use the same environment and `DATA_DIR`: for the launcher's default storage, run `DATA_DIR="$PWD/.data" npm run dev:server`; for custom storage, retain that exact `DATA_DIR`. The diagnostic command starts only the API. Stop it before restarting `npm run dev`. For occupied explicit ports, use automatic allocation (`PORT=0`, `WEB_PORT=0`) or free ports. For owned storage, stop its owner or use a separate disposable store; never remove the ownership sentinel.

## Development checks

Start with the test file covering the edit, then run a broader checkpoint:

```sh
node --test tools/local-runtime.test.mjs
npm run check:fast
```

The example targets launcher changes and starts real listeners/watchers; use it at a changed-runtime milestone. Select the owning test for an ordinary edit. For client or API tests, use `npm exec -- vitest run <test-file>` (add `--environment node` for boundary/integration tests). `check:fast` includes all `tools/*.test.mjs` Node tests and client unit tests, as well as formatting, generated member-color and emoji freshness, types and lint. It is a broader checkpoint, not a static-only command.

For cheap acceptance readiness feedback, use `npm run check:preflight`; it runs no tests. Before acceptance, prepare the reviewed candidate in a fresh validation worktree and run `npm run check:standard`. At the browser milestone, run `npm run check:aggregate-only` against that unchanged candidate and its valid retained standard artifacts. Alternatively, use one fresh `npm run check:full` invocation when standard evidence is not already available. A focused retry helps diagnose a failure; it does not establish a full pass. [Verification](../quality/verification.md) describes candidate isolation, artifact retention and exact acceptance. A shared UI change also needs consumer checks described in the [style guide](style-guide.md).

Feature behavior belongs under [features](../features/), technical interfaces under [contracts](../architecture/contracts/README.md), and rationale under [decisions](../architecture/decisions/README.md). Update the owning page and tests together when changing behavior.
