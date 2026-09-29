# Verification policy

Boundary guarantees in [boundary-guarantees.yaml](boundary-guarantees.yaml) record stable requirement identities and ownership. They are traceability, not instrumented code coverage. A passing reference check cannot prove that a production line executed.

## Check tiers

`package.json` is the command authority. `npm run check:fast` runs formatting, generated member-color freshness, types, lint and client unit tests. `npm run check:standard` adds Node boundary and integration tests, OpenAPI route/shape checks, exception-list and accessible-name checks. `npm run check:full` adds Playwright browser tests and a built-render smoke check. Run `npm run build` for a distributable candidate. Apply the exact required tier to the same candidate bytes; changes after a pass invalidate affected evidence.

A required suite must be discovered from its runner's actual list/results. Reject missing or extra expected files, zero executed cases, `only`, skipped or todo cases, failed suites, duplicate IDs, missing result artifacts and results bound to a different candidate. Parameterized cases count as runtime cases only when the runner reports them; an AST or source-text count is not execution evidence. Node, client Vitest, Node Vitest and Playwright have separate discovery expectations. Keep a negative test for each permanent gate, proving that it fails on a missing or altered input.

## Instrumented coverage

Measure the complete cumulative production cohort, including files never imported by a test and the seed CLI. Bind raw V8 output, exact source hashes, runtime/toolchain and candidate identity. Required line/statement/function/branch percentages are: overall `85/85/85/80`, client `87/85/83/78`, server `90/89/92/83`, shared `96/96/100/93`. An absent layer requires explicit cohort evidence; deleting files from a denominator does not satisfy a floor. Compare retained unchanged files against the approved original cohort; document the reason for any transformed-file denominator change. A focused green test or mapped historical percentage cannot accept the candidate.

## Change scope

Review exact changed paths against the trusted declaration and compare only corresponding source cohorts when making historical claims. Test negative authorization, invalid input, transaction/side-effect failure, lifecycle cleanup and restart recovery through the public seam. A shared component or contract change requires regression checks across its consumers. Include built-process checks for startup, health, authorized access, scheduler-disabled operation and shutdown. Browser and external-effect acceptance must be recorded at the exact stage where those features are actually present.

## Candidate identity and artifacts

The full gate hashes every maintained file and mode listed in
`tests/fixtures/assembly-cohort.json`, including the fixture itself. Only generated
build/test directories and TypeScript build caches are outside this tree.
Unexpected maintained files are rejected. The resulting identity is stamped into
`.quality/candidate.json`; the coverage and runner gates recompute it before
accepting results. Set `MP_CANDIDATE_ID` to require a particular reviewed identity,
or leave it unset for a local development run. Do not put live `.env.local` or data
files in a verification checkout: run the gate in an isolated copy.

The fixture's own `candidate` field identifies the reviewed scope policy, not its
containing tree. This avoids a circular self-hash. The runner stamp and external
release manifest carry the full tree identity. Ambient TypeScript declarations
remain in the production inventory with zero executable metrics; `typecheck`
validates them. Vitest list checks file discovery; expanded parameterized case IDs
are verified against a reviewed runtime collection. No static source count is
reported as executed cases.
