# Verification policy

Boundary guarantees in [boundary-guarantees.yaml](boundary-guarantees.yaml) record stable requirement identities and ownership. They are traceability, not instrumented code coverage. A passing reference check cannot prove that a production line executed.

## Check tiers

`package.json` is the command authority. Use focused edit tests first, a broader checkpoint next, exact standard acceptance when the candidate is ready, and one full browser milestone when browser acceptance is required.

- `npm run check:fast` runs formatting, generated member-color and emoji freshness, types, lint, all `tools/*.test.mjs` Node tests and client unit tests. It is not static-only and does not produce standard acceptance evidence.
- `npm run check:standard` first runs `check:preflight`, then stamps the maintained candidate, checks formatting/generated artifacts/types/lint, builds it, executes the discovered Node and client/boundary/integration Vitest cohorts with coverage, and verifies OpenAPI, UI debt, exception lists, accessible names, coverage and runner evidence.
- `npm run check:full` runs standard followed by `check:aggregate-only`: browser preflight, build, built-render smoke, Playwright discovery/execution for the acceptance cohort, and aggregate cohort verification. The real-clock time-announcements browser spec is not in that cohort; run it with `npm run test:e2e:time-announcements`.

Apply the required tier to the same reviewed candidate bytes. Changes after a pass invalidate affected evidence. `npm run build` alone produces a distributable build; it does not accept the candidate.

`npm run check:preflight` checks that the checkout matches the git-tracked file list, that every coverage-policy file is present, and the pinned Node/npm/Vitest toolchain without running tests. Standard runs it before the destructive stamp. `npm run check:preflight:browser` also checks the retained candidate stamp and standard coverage/cohort artifacts, rejects inherited `SCHEDULER_DISABLED=1` and acceptance server reuse (`PW_REUSE_SERVER=1`), and checks local `BASE_URL`/`PORT` consistency before the aggregate build. These early checks do not establish browser execution or a complete environment/build fingerprint; the browser runner still owns browser availability, synthetic data and server startup.

CI calls the existing selector in `mac-mini-ci.yml`. Trusted repository changes use
`macmini` when the named runner is online, idle and has the required labels;
otherwise native jobs use `macos-15`. Fork PRs always use hosted macOS. The lookup
is an availability snapshot, not a reservation: a disconnect after selection does
not migrate a queued or running job. `force_hosted` on workflow dispatch (or the
repository variable `MP_FORCE_HOSTED=true` for reruns before this workflow reaches
main) forces hosted native acceptance.

`standard` runs the complete standard tier. `native` independently installs the
same candidate, restores the standard tar archive with its original timestamps,
verifies coverage and cohorts, then builds and runs the Playwright acceptance cohort. The real-clock time-announcements spec stays out of that cohort. Raw
Node/Vitest/V8 absolute paths use the producing checkout root recorded in the
candidate stamp. The consuming checkout recomputes candidate identity and accepts
the archive only when that identity matches the stamp. Artifact
names include run ID and attempt to prevent mixing retries. Each job has a fresh
checkout path, job-owned npm configuration/cache/prefix and browser installation;
no personal environment files, desktop session or existing browser cache is used.

`container` builds and accepts the Docker image on GitHub-hosted Ubuntu, including
its browser flow. The required `full` check always runs on Ubuntu and succeeds
only when `select`, `standard`, `native` and `container` all succeeded. Failure,
cancellation, missing constituents or unexpected skips fail the aggregate gate.
The required status names remain `standard` and `full`.

### Failure diagnosis and retries

Retain the failed command, candidate identity, log and raw artifacts before retrying. The stamp deletes `.quality`, and runners may overwrite coverage/browser results. Copy existing `.quality`, `coverage`, `test-results` and `playwright-report` directories that were produced to a new evidence directory **outside** the validation checkout before starting another acceptance run. Keep the failed attempt separate from subsequent attempts.

Rerun the specific failed test while diagnosing, then run the required complete tier after the fix. A targeted pass cannot replace missing discovery, coverage or browser evidence. `check:aggregate-only` consumes the standard artifacts for the same unchanged candidate; it is not a standalone full pass. Never splice successful subsets from different candidates or label a filtered Playwright retry as full acceptance.

A required suite must be discovered from its runner's actual list/results. Reject missing or extra expected files, zero executed cases, `only`, skipped or todo cases, failed suites, duplicate IDs, missing result artifacts and results bound to a different candidate. Parameterized cases count as runtime cases only when the runner reports them; an AST or source-text count is not execution evidence. Node, client Vitest, Node Vitest and Playwright have separate discovery expectations. Keep a negative test for each permanent gate, proving that it fails on a missing or altered input.

## Instrumented coverage

Measure the complete cumulative production cohort, including files never imported by a test and the seed CLI. Bind raw V8 output to the pinned runtime/toolchain and to the candidate identity computed from the maintained tree. The coverage policy records aggregate floors, per-file minimum rates and per-file minimum totals. Required line/statement/function/branch percentages are: overall `85/85/85/80`, client `87/85/83/78`, server `90/89/92/83`, shared `96/96/100/93`. An absent layer requires explicit cohort evidence; deleting files from a denominator does not satisfy a floor. Compare retained unchanged files against the approved original cohort; document the reason for any transformed-file denominator change. A focused green test or mapped historical percentage cannot accept the candidate.

## Change scope

Review exact changed paths against the trusted declaration and compare only corresponding source cohorts when making historical claims. Test negative authorization, invalid input, transaction/side-effect failure, lifecycle cleanup and restart recovery through the public seam. A shared component or contract change requires regression checks across its consumers. Include built-process checks for startup, health, authorized access, scheduler-disabled operation and shutdown. Browser and external-effect acceptance must be recorded at the exact stage where those features are actually present.

## Candidate identity and artifacts

The full gate hashes every git-tracked file and its mode. Git supplies that file
list, including this policy fixture. Only generated build/test directories and
TypeScript build caches are outside this tree. Unexpected untracked files are
rejected. The resulting identity is stamped into
`.quality/candidate.json`; the coverage and runner gates recompute it before
accepting results. Set `MP_CANDIDATE_ID` to require a particular reviewed identity,
or leave it unset for a local development run. Do not put live `.env.local` or data
files in a verification checkout: use the fresh validation worktree below.

### Fresh validation worktree

Normal development `.env.local`, `.data/` and household database files are incompatible with the strict maintained-file scanner, even when Git ignores them. Preserve the development checkout and its data. Create a fresh detached worktree at the exact reviewed **local** commit; install dependencies independently there:

```sh
candidate_commit=$(git rev-parse HEAD)
validation_parent=$(mktemp -d "${TMPDIR:-/tmp}/marplanner-validation.XXXXXX")
git worktree add --detach "$validation_parent/checkout" "$candidate_commit"
cd "$validation_parent/checkout"
npm ci
npm run check:standard
# At the browser milestone, retaining valid standard evidence for unchanged bytes:
npm run check:aggregate-only
```

If standard evidence is not already available, `npm run check:full` is the alternative fresh combined invocation; do not run it immediately after standard merely to add browser acceptance.

Use this only after confirming `HEAD` contains the reviewed changes. With a dirty source checkout, first commit the explicitly reviewed maintained candidate locally, or transfer an explicitly reviewed maintained-file diff to the fresh worktree and review its resulting bytes. A worktree at `HEAD` does not include uncommitted changes. Do not copy `.env.local`, secrets, household data or `node_modules`; do not delete user data to satisfy the scanner. Commit a new maintained path for it to join the candidate. Keep logs and evidence outside the candidate directory.

The fixture's own `candidate` field identifies the reviewed scope policy, not its
containing tree. This avoids a circular self-hash. The runner stamp and external
release manifest carry the full tree identity. Ambient TypeScript declarations
remain in the production inventory with zero executable metrics; `typecheck`
validates them. Vitest list checks file discovery; expanded parameterized case IDs
are verified against a reviewed runtime collection. No static source count is
reported as executed cases.

Concurrent isolated browser lanes may set `PORT` (matching `BASE_URL`), `MP_E2E_WEATHER_FIXTURE_PORT` and `MP_E2E_QUOTE_FIXTURE_PORT` to free loopback ports. The fixture providers and runner import the same values; defaults remain 41837/41839. Never reuse or terminate another lane’s listeners.

The exception-list command defaults to the reviewed main predecessor `f8db1b6fc51d6952d06e224dba03b8e62f22d56c` (empty terminal list), replacing the absent historical `B0` ref. `MP_ACCEPTED_PREDECESSOR` can name an explicitly reviewed alternative; no synthetic tag or enlarged exception baseline is created.

## Test concurrency

Vitest runs files in parallel with a maximum of four workers, capped by the host's available CPU count. Its default process pool and file isolation remain enabled. Tests within a file retain their normal serial order; database tests use their existing temporary directories and listener tests use their existing dynamic ports. For a serial reproduction, append `--fileParallelism=false` to the Vitest invocation.

The Node test runner already runs test files concurrently. Playwright retains one worker in CI: its browser cases share a server and database, and printer tests coordinate through their existing cross-process lock. Increasing browser concurrency requires a separate shared-state review.

Type-aware lint applies to real project sources. Architectural lint tests explicitly use typescript-eslint's `disableTypeChecked` configuration for their virtual syntax fixtures; they still exercise the production import, logging and UI rules. The normal lint command and the new typed-rule probes retain type checking.

This hardening adds six Node lint-policy cases and two invalid-date Calendar regressions and one recipe-search consumer case, and corrects the isolated density-control case name. The reviewed production changes are explicit dispatch of already-contained asynchronous operations, accurate async hook/subscriber types, removal of obsolete suppressions, documented density behavior, and moving Calendar date conversion into its existing error boundary. That review admitted `.editorconfig`, `tools/lint.mjs` and `tools/lint-policy.test.mjs`. Coverage floors and per-file minimums stay in place.

## Imported history reconciliation

The initial GitHub import includes changes after the previously reviewed runtime
candidate. Its product inventory is reconciled with those maintained bytes,
including shared gate tokens and local seed/browser tools.
The original production coverage cohort, file minimum totals, file minimum rates,
and aggregate floors remain unchanged. Keyboard and module-relative gate-token
regressions exercise new branches instead of lowering coverage requirements.

Runner expectations retain existing tests and include added local-tool and gate
cases. Renamed Vitest titles and Playwright IDs reflect the imported planning-label
cleanup; they do not remove tests. Fixed weather dates use a Date-only pinned clock
so calendar-window validation remains meaningful as wall time advances. ICS fixture
timestamps retain their UTC time component. The seed wrapper forwards operator
arguments to both existing profile entrypoints and preserves duplicate-mode
rejection before private effects.
