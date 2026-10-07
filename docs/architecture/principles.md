# Marplanner Constitution

Marplanner is a self-hosted household kiosk and planner. It runs as a single instance per household
(N users × 1 instance each), with no high-availability.

The principles below are NON-NEGOTIABLE and are enforced as MUST rules. Treat a violation as a high-severity review finding that requires a correction or an explicit, versioned decision.

## Core Principles

### I. Fresh Store, No Legacy Migration (NON-NEGOTIABLE)

v2 is a new product with a fresh data store (ADR-026). The system MUST NOT import or
migrate any legacy production database rows. Legacy behavior is evidence only — it informs
design but is never data to carry forward. Any proposal to seed v2 from legacy data is a
CRITICAL violation.

### II. Fail-Closed Security (NON-NEGOTIABLE)

Authorization MUST always fail closed (ADR-033, ADR-007, ADR-031, ADR-016). There is NO
environment-conditional auth bypass — no "skip auth in dev" path may exist in any
environment. The API key is the backend authorization boundary; the PIN is a client-side UI
gate ONLY and MUST NEVER be used as a backend authorization mechanism. The only
unauthenticated surface is health-check endpoints. Secrets and PII — API keys with `mpk-`/
`mpg-` prefixes, MAC addresses, and IPs — MUST be redacted at ingest in logs and telemetry.
Redaction is mandatory, not best-effort.

### III. Single-Instance Runtime (NON-NEGOTIABLE)

The app runs as exactly one instance with no HA (ADR-014, ADR-035). Background jobs and the
scheduler MUST use in-process concurrency guards; a deployment-wide lease MUST NOT be
introduced. Runtime services are placed by capability claim with a decision/execution split.
Domains own their own "what happened" status; the scheduler does not.

### IV. Time and Date Discipline (NON-NEGOTIABLE)

All scheduling, expiry, and date logic MUST anchor to the configured household timezone
(ADR-005, ADR-006, ADR-020). Dates MUST be strictly calendar-valid. Weekdays MUST use the
canonical `mon..sun` string model. An NTP-disciplined host clock is an operating
precondition; boot MAY sanity-check it.

### V. Write Atomicity and Derive-on-Read (NON-NEGOTIABLE)

Multi-step writes MUST follow explicit atomicity classes (ADR-043): atomic primary writes in
a single DB transaction; derived state computed on read (not stored); idempotent mirrors for
external reflections. SQLite MUST run with `PRAGMA foreign_keys=ON`. Correctness MUST be
guaranteed by authoritative read-time checks, NOT by event delivery.

### VI. Member Referential Integrity (NON-NEGOTIABLE)

Members are archive-only: hard delete is forbidden, ever (ADR-054, ADR-001, ADR-002).
References MUST be strict-on-write (a write may only point at an active member) and
tolerant-on-read (an existing reference to a now-archived member renders read-only and MUST
NEVER break). `admin` is NEVER a member role.

### VII. Typed, Non-Load-Bearing Event Bus (NON-NEGOTIABLE)

Cross-module decoupling MUST use an in-memory, typed, at-most-once, post-commit event bus
with immutable payloads (ADR-040, ADR-050). Events are notifications, NOT state. Dropping an
event MUST NEVER corrupt state, because the authoritative check is at read time. No state
correctness may depend on event delivery.

### VIII. Core/Plugin Architecture (NON-NEGOTIABLE)

Features beyond the core are plugins, first-party only (the third-party seam is preserved
but unused) (ADR-029, ADR-039, ADR-038). Plugins MUST access the system ONLY through the
host API (Rule B), enforced by a named build-time import-boundary lint check. Plugin data
MUST live in id-namespaced tables with NO cross-namespace foreign keys. Plugins MUST read
operator secrets only via `host.getOperatorConfig()`; direct `process.env` reads in plugins
are lint-banned.

### IX. Testing Standard (NON-NEGOTIABLE)

Modules MUST be tested through the same public seam their callers use (ADR-056,
[verification policy](../quality/verification.md)). Any API, schema, or auth boundary MUST get real boundary tests,
not only unit tests. E2E MUST cover critical user flows and deploy/runtime integration. Three
check levels exist: `check:fast` (hooks/local), `check:standard` (PR gate), `check:full`
(release/deploy/migration gate). Test runners are Vitest (unit/integration) + Playwright
(e2e). Typecheck and lint are MANDATORY for merge.

### X. Language Policy (NON-NEGOTIABLE)

Developer- and operator-facing text — logs, errors, diagnostics, status, stack traces — MUST
ALWAYS be English and MUST NEVER be localized, so diagnostics stay stable across languages
(ADR-015). Family-facing UI text is localized; the base locale is `en` (reference +
fallback), household-wide, with a strict locale enum at the settings boundary and a
build-time translation parity gate. Translation parity is a MUST: the parity gate MUST fail
the build on missing keys.

### XI. Generated-Artifact Freshness (NON-NEGOTIABLE)

Every generated artifact — OpenAPI/API docs, DB docs, design tokens, route trees — MUST have
a documented generator and a drift check that fails CI. Generated files MUST NOT be
hand-edited.

### XII. Forward-Only Migrations with Data-Safety Gates (NON-NEGOTIABLE)

Database migrations MUST be append-only/forward-only by default (ADR-056). Any reset or
consolidation requires an explicit baseline decision. Any deploy, migration, or restore that
can change active data MUST produce a pre-snapshot and read-boundary smoke evidence against
realistic data before being declared healthy. Declaring such an operation "healthy" without
that evidence is a CRITICAL violation.

### XIII. Aggregate Validity (NON-NEGOTIABLE)

A feature change MUST be validated as an integrated, runnable whole — not only as independently-green
units. Every feature MUST include a runnable skeleton early (boots as a real process, serves the
shell, one end-to-end smoke path through the stack) so assembly is proven continuously, never
deferred to the last task (ADR-059). The full aggregate gate (`check:full`, including the
critical-flow e2e) MUST re-run against the _resulting tip_ of any merge into an integration branch:
per-PR green does NOT imply the integrated tip is green (two green PRs can combine red). Declaring a
feature complete without a green aggregate gate on its merged tip is a CRITICAL violation.

### XIV. Empirical Evidence for Behavioral Claims (NON-NEGOTIABLE)

Any claim about how a dependency behaves at runtime — framework routing, browser/cookie semantics,
DB behavior, a tool's exit code — MUST be substantiated by an executed probe (command + observed
output, or a test), NEVER by reasoning or peer review alone. Design decisions (ADRs) and
verification findings that rest on an unproven behavioral claim are unaccepted until probed; an ADR
making a runtime-behavior claim MUST record its empirical evidence (ADR-060 `__Host-` precedent — a
peer-reviewed but unprobed claim that shipped wrong).

## Technology Stack Stance

The following stance governs technical decisions. The package manifest and lockfile hold concrete dependency versions (ADR-055, ADR-056).

- **Language/Runtime**: TypeScript on Node.js `>=24.21.0 <25`; development and CI use `24.21.0`.
- **Repository**: single package — no monorepo. Package manager: npm.
- **Persistence**: SQLite in WAL + STRICT mode via Drizzle.
- **Backend**: Fastify serving a React + Vite SPA.
- **UI**: shadcn/ui.
- **Build**: Vite, the server build script, and TypeScript project typechecks.
- **CI**: GitHub Actions checks as defined in this repository.
- **Versioning**: SemVer + Conventional Commits + release-please.
- **Distribution**: built client and server with environment configuration and persistent `DATA_DIR`; startup checks directory writability.

## Quality Gates and Workflow

- **Check levels** (Principle IX): `check:fast` runs on hooks/local; `check:standard` is the
  PR merge gate; `check:full` is the release/deploy/migration gate. Typecheck and lint are
  mandatory for merge.
- **Aggregate gate** (Principle XIII): `check:full` (incl. the critical-flow e2e) MUST run on
  every PR AND re-run against the tip of any merge into an integration branch; a slice is not
  complete until its merged tip is green.
- **Empirical evidence** (Principle XIV): any ADR or verification finding resting on a
  runtime-behavior claim MUST cite an executed probe; an unprobed behavioral claim is unaccepted.
- **Drift gates** (Principle XI): generated-artifact drift checks MUST fail CI; generated
  files are never hand-edited.
- **Translation parity gate** (Principle X): the build-time parity gate MUST fail on missing
  locale keys.
- **Import-boundary lint** (Principle VIII): a named build-time lint check enforces the
  plugin host-API boundary and bans direct `process.env` reads in plugins.
- **Data-safety gate** (Principle XII): pre-snapshot + read-boundary smoke evidence is
  required before any data-changing deploy/migration/restore is declared healthy.

## Governance

This constitution supersedes individual feature decisions. A product change that
conflicts with a MUST principle is a CRITICAL finding requiring a remediation task — never a
reinterpretation or a silent downgrade of a MUST to a SHOULD.

Amendments to this constitution are a separate, explicit, versioned process. Each amendment
MUST document the change, its rationale, and a version bump following SemVer semantics
(MAJOR for principle removal or redefinition, MINOR for new principles or materially expanded
guidance, PATCH for clarifications). The non-negotiable principles above MUST NOT be weakened
(MUST → SHOULD) without a MAJOR version bump and explicit ratification.

All PRs and reviews MUST verify compliance with these principles. The principles trace to
accepted ADR decisions (see the rationale/source map in
the [architecture decisions](decisions/README.md)); ADR references in each principle
are normative and MUST be kept intact.

**Version**: 1.1.0 | **Ratified**: 2026-06-30 | **Last Amended**: 2026-07-07
