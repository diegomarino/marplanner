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

Run `npm run format:check`, `npm run typecheck`, `npm run lint`, and the relevant test tiers. `npm run check:standard` includes the client unit, boundary, integration, OpenAPI and accessibility checks; `npm run check:full` adds browser and built-render checks. Consult [verification](docs/quality/verification.md) for exact discovery, skip and instrumented coverage policy. Do not equate a boundary-guarantee reference with measured code coverage.

The canonical design references are [principles](docs/architecture/principles.md), [contracts](docs/architecture/contracts/README.md), [decisions](docs/architecture/decisions/README.md), and [security](SECURITY.md). Update the relevant page when behavior or an interface changes. Keep instructions executable in this repository without access to any development or import workspace.
