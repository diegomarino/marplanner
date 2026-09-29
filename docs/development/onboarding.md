# Developer onboarding

Use Node.js `>=24.21.0 <25` (development and CI use `24.21.0`) and npm `11.19.0`.

```sh
npm ci
npm run build
npm run check:fast
```

For local development, run `npm run dev:server` and `npm run dev` in separate terminals. Set a persistent, writable `DATA_DIR` and unique credentials before provisioning. [Operations](../operations.md) documents each setting and synthetic public seeding. Keep `.env.local` and household data out of commits.

Use `npm run check:standard` for the repository's full Node/client contract tier and `npm run check:full` for browser and built-render checks. Consult [verification](../quality/verification.md) for discovery, coverage and negative test requirements. A shared UI change also needs consumer checks described in the [style guide](style-guide.md).

Feature behavior belongs under [features](../features/), technical interfaces under [contracts](../architecture/contracts/README.md), and rationale under [decisions](../architecture/decisions/README.md). Update the owning page and tests together when changing behavior.
