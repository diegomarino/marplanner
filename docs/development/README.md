# Development guide

Start with [onboarding](onboarding.md). The [UI foundation](ui-foundation.md) describes shared primitives and recipes; the [style guide](style-guide.md) describes their use. [Architecture principles](../architecture/principles.md), [contracts](../architecture/contracts/README.md), [decisions](../architecture/decisions/README.md), and [verification](../quality/verification.md) are the canonical technical references.

The repository is one TypeScript package. `src/server` owns API authorization, persistence, scheduler and integrations; `src/client` owns the browser; `src/shared` contains contracts used by both. `docs/api` contains the retained OpenAPI contracts. Follow dependency direction and test through public seams.
