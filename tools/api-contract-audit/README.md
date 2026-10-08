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

By default the auditor copies the git-tracked files into a fresh temporary
directory, links the installed dependencies, builds the isolated product, and runs
synthetic tests there.
The build precedes the tests so built-entrypoint checks do not depend on test order.
Local environment files,
databases, logs and untracked files are not copied. Tests create their own fixture
databases and local listeners. The output path is printed before execution and
retained for inspection. No server needs to be running.

Use `--product <directory>` to select another installed source checkout, or
`--out <new-directory>` to choose where the isolated copy and reports are kept.
Without `--observations`, running tests is the default; `--run-tests` remains an
optional explicit spelling. Replaying observations also uses an isolated copy.
Commit a new maintained file for the isolated copy to include it.

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
pass. External references remain unsupported. The overlapping briefing-render contract
contains local envelope schemas; the regression check keeps both contracts aligned
with the complete registry and historical schemaVersion 1 vocabulary.

`previouslySkipped` reproduces the original checker's exact omission set.
`observedUses` means a schema is transitively referenced by an observed body; it
does **not** prove that an optional property, every union branch or each array
element type was exercised. `invalidUses` implicates a containing body, not
necessarily every referenced component. Counts of findings are grouped validation
signatures, not counts of independent product defects.

The audit pools isolated route tests and assembled-app tests. Review findings
against the relevant handler before changing behavior, particularly overlapping
contracts and intentionally mocked failure paths. Separate processes launched by
tests are not instrumented. Binary body schemas remain explicitly unobserved: a serialized Buffer is not a
wire-level string and cannot establish transport conformance. JSON responses to
binary uploads are still validated. Query/path/header parameters and response
headers are outside this script's validation. Missing negative cases
are listed through coverage gaps rather than generated. Description-only responses
have no body schema to validate and are not counted as body coverage.

The initial BFULL audit used a separate macOS Seatbelt profile to restrict network
traffic to loopback. This script does not enforce that restriction itself. Run
only the synthetic test suite in a development checkout.

This is an opt-in diagnostic, separate from `check:full`. See
[the initial findings](../../docs/quality/api-contract-audit.md) for the historical baseline.

## Prioritizing missing observations

An unobserved body is a contract/status/media variant without captured validation,
not an independent defect or a requirement for a new test. Overlapping contracts
can list the same HTTP variant twice. Prioritize successful writes, permission
boundaries, rejected writes that must preserve data, and binary transport checks.
Use route matrices for shared authorization behavior and existing failure tests
for shared error handling. A defensive branch unreachable behind assembled-app
middleware does not need an artificial route-only test just to reduce this count.

Record the exact test and its scope when accepting evidence outside the capture:
service assertions do not prove HTTP body shape, and successful JSON observations
do not prove binary bytes or headers. Such evidence does not change the auditor's
counts or exit code. Optional fields, union branches and operational failures still
require risk-based review even when every listed body has an observation.

## Attribution and repair checks

The capture attributes only the deliberate percent-encoded provisioning access
form to `(access-gate-form)`, a middleware boundary outside the provisioning JSON
operation. It requires the exact decoded path, POST, HTML 200 and the access-form
marker. Ordinary provisioning responses and unexpected HTML remain visible to the
auditor. No raw URL or credential is retained. The classifier hash is recorded in
capture provenance alongside the auditor and capture hashes.

`npm run test:api-contract-audit` also checks all maintained schemas compile,
versioned briefing vocabulary, icon nullability, reminder cross-field rules,
calendar create/edit separation, external-source configuration and telemetry's
per-entry drop semantics. State-dependent reminder edits/assignment replacement,
calendar date ordering and active-member checks still require product boundary
tests; a body schema alone cannot establish these invariants.
