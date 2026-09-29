# HTTP contract audit

Validate synthetic HTTP observations against all 19 maintained OpenAPI contracts,
including the 82 component entries skipped by the same-name DTO checker. This
uses the installed Ajv 8 / ajv-formats dependencies, the existing contract cohort
and Vitest node project. No dependency installation or product edits are needed.

## Run

Use Node 24.21.0 and installed product dependencies. From the repository root:

```sh
npm run test:api-contract-audit
npm run check:openapi-bodies
```

Direct execution without arguments also works:

```sh
node tools/api-contract-audit/audit.mjs
```

By default the auditor copies only `productFiles` from
`tests/fixtures/assembly-cohort.json` into a fresh temporary directory, links the
installed dependencies, and runs synthetic tests there. Local environment files,
databases, logs and unlisted files are not copied. Tests create their own fixture
databases and local listeners. The output path is printed before execution and
retained for inspection. No server needs to be running.

Use `--product <directory>` to select another installed source checkout, or
`--out <new-directory>` to choose where the isolated copy and reports are kept.
Without `--observations`, running tests is the default; `--run-tests` remains an
optional explicit spelling. Replaying observations also uses an isolated copy.
When adding maintained files, update the inventory's `productFiles` list.

Fastify's `fastify.initialization` diagnostics channel adds observational
`preValidation` and `onSend` hooks. Tests keep their assertions and original
configuration. The generated config selects the existing `node` project, adds
the capture setup, and disables coverage for this audit.

To revalidate an existing synthetic capture without rerunning tests:

```sh
npm run check:openapi-bodies -- --observations /path/to/previous-run/observations.jsonl
```

A replay binds the current contracts and input bytes, but does not prove the
capture originated from that candidate. Use the original run's provenance for
that association; a replay has `testExit: null`.

## Output and exit codes

- `report.json`: contract errors, observed conflicts, all component schemas,
  operation/body reference mappings, coverage gaps and input/tool hashes.
- `observations.jsonl`: synthetic transactions, including test names; finding
  `observation` values refer to one-based line numbers. Cookies, authorization
  headers and raw URLs are excluded. Bodies can still contain synthetic secrets;
  retain captures locally and never feed real household traffic into this tool.
- `tests.json` / `tests.log`: unchanged test outcomes and runner diagnostics.
- Exit **1**: schema/behavior conflicts, test failure, or empty capture.
- Exit **2**: no observed conflicts, but bodies, operations or components lack
  evidence. Unreferenced component schemas remain incomplete.
- Exit **0**: observed bodies passed and the listed coverage gaps are empty.
  This still does not prove universal request/response equivalence.

## What the results mean

Ajv checks required fields, types, enum values, nesting, unions, nulls, formats,
ranges and additional properties without coercing or rewriting payloads. Invalid
requests are reported as conflicts only when accepted with a 2xx response.
Rejected requests are still checked against their response contracts. Compilation
errors remain findings; unknown keywords and broken references cannot silently
pass. External references are currently unsupported (the only one in BFULL points
to an absent historical file).

`previouslySkipped` reproduces the original checker's exact omission set.
`observedUses` means a schema is transitively referenced by an observed body; it
does **not** prove that an optional property, every union branch or each array
element type was exercised. `invalidUses` implicates a containing body, not
necessarily every referenced component. Counts of findings are grouped validation
signatures, not counts of independent product defects.

The audit pools isolated route tests and assembled-app tests. Review findings
against the relevant handler before changing behavior, particularly overlapping
contracts and intentionally mocked failure paths. Separate processes launched by
tests are not instrumented. Binary streams, query/path/header parameters and
response headers are outside this script's validation. Missing negative cases
are listed through coverage gaps rather than generated. Description-only responses
have no body schema to validate and are not counted as body coverage.

The initial BFULL audit used a separate macOS Seatbelt profile to restrict network
traffic to loopback. This script does not enforce that restriction itself. Run
only the synthetic test suite in a development checkout.

This is an opt-in diagnostic, separate from `check:full`: existing contract drift
currently produces exit 1. See [the initial findings](../../docs/quality/api-contract-audit.md).
