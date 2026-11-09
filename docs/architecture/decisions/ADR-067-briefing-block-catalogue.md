# ADR-067 — Daily briefing block catalogue

- **Status**: accepted (2026-11-09)
- **Context**: issue #129. Registering one block type meant editing about fifteen
  hand-synced lists and switches across shared, server, render, OpenAPI and client code;
  only two were fenced by a test. Adding `phonics` touched 35 files.

## Decision

Each block type is declared once, as an entry in `BRIEFING_BLOCKS`
(`src/shared/dailyBriefingBlocks.ts`): `type`, `scope`, `kind` (`local` | `corpus` |
`external`), `defaultEnabled`, corpus `languages` and `params`. The entry is pure data.

- Everything that is metadata derives from the catalogue: the `BlockType` unions, the server
  lists, the generation scope and phase, the settings param checks, the OpenAPI enums and
  `BlockParams` bounds, and the admin matrix rows and controls.
- Implementations stay where their dependencies live: generators and pressedslip render
  definitions on the server, React renderers on the client. Every dispatch site is
  exhaustive over the catalogue type (`satisfies Record<BlockRegistryType, …>`, or a `never`
  check in the `switch` default), so `npm run typecheck` lists what a new block still lacks.
- The client reads the catalogue as a shared module, as it already does for
  `src/shared/plugins.ts`. There is no catalogue endpoint.
- The OpenAPI `BlockType` enum stays closed, generated from the catalogue.

## Consequences

- Adding a block is one catalogue entry plus the implementations the compiler asks for.
- Param keys are still accepted on any block type at the write boundary. Stored settings and
  the public seed carry keys a block does not read, so rejecting them is a separate change.
- Plugin-contributed blocks (ADR-039) are not covered yet. A first-party plugin would add
  catalogue entries the same way; `PluginContentSourceId` could then derive from them.
