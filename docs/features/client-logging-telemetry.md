# Feature: Client Logging / Telemetry (privacy-bounded browser diagnostics)

Behavior reference. The [owning contract](../architecture/contracts/client-logging-telemetry.md) defines invariants and extension limits.

Client Logging / Telemetry is a bounded, best-effort, privacy-bounded and
**operationally disposable** browser-side diagnostics pipeline: producers emit a
redacted envelope, a volatile client buffer flushes it at-most-once, and a server-ingest
redaction layer bounds and scrubs every entry before it crosses the server boundary into
the `client_log` DB sink or any operator-configured external sink. It is **support
evidence only** — a telemetry row is never product truth and never sits in any product
control flow, so a telemetry failure blocks nothing. The contract is privacy-heavy: most
guarantees are prohibitions (what an envelope must never contain, where redaction must
land, which fields an external sink must never receive) and their polarity is
load-bearing.

## Behavior

### User Story 1 — A kiosk producer emits a bounded, redacted diagnostic

A kiosk component logs `{level, component, message, data}` about a printer failure. The
call returns without throwing even if the sink is unreachable; the entry is buffered
in-memory and flushed best-effort. At server ingest the `data` is bounded and any
secret-named key, `mpk-`/`mpg-` value, or MAC/IP pattern is rewritten to `[redacted]`
before the row is written or any external sink is fanned out to. The product workflow the
producer was running is unaffected whether or not the telemetry ever lands.

### User Story 2 — The self-hoster reads diagnostics through the admin view

A self-hoster with no `fly logs`/SSH opens the read-only admin diagnostics view, filters
by severity/component/date, and pages through `client_log`. Attacker-influenceable
`message`/`data` (writable by any kiosk `telemetry:write` key) render as escaped text-only,
and pagination is server-capped with cursor paging so a read cannot DoS the shared SQLite
file. Ingest requires `telemetry:write`; read/export requires `telemetry:admin`/`*`.

### User Story 3 — A telemetry outage leaves the product untouched

The external sink is down and the client buffer is dropped on a failed flush. No product
state changes, no user action is blocked, and an aggregate flood against ingest is dropped
silently while bumping the health counter rather than writing an unbounded volume into the
product database.

### Edge Cases

- An over-limit `data` payload (size/depth/key-count) is truncated or rejected at ingest,
  never written whole.
- An aggregate flood per key+window is dropped silently and bumps the health counter — it
  is not allowed to flood the shared SQLite product file.
- `console.*` fires client-side before ingest, so it carries no redaction contract; a
  production build emits no `data` to console, and raw `console.*` outside the logger is
  lint-banned.
- An external sink with no explicit per-integration `data` allowlist receives only the
  five enumerated fields and never `data`.
- The scheduled prune runs and deletes aged rows even on a deployment with zero ingest.
- The i18n missing-translation-key signal arrives as a telemetry write, not a bus event.
- Legacy v1's 119 prod rows are never imported; `client_log` starts empty.

## Requirements

### Behavior requirements

- **FR-001**: Given a telemetry row, when any product workflow reads it, then that row MUST NOT be treated as proof of success, MUST NOT recover or drive state, and MUST NOT sit in any product control flow, so that a telemetry failure blocks no product action. _(Realizes: CLIENT-LOGGING-TELEMETRY-INV-01)_

- **FR-002**: Given a client producer, when it emits and flushes, then delivery MUST be best-effort at-most-once — an in-memory buffer with no durable retry — send failures MUST be swallowed, offline replay MUST NOT occur, and the unload flush MUST NOT be guaranteed, while a local failure counter MAY feed the global health indicator. _(Realizes: CLIENT-LOGGING-TELEMETRY-INV-02)_

- **FR-003**: Given an envelope, when it is materialized, then `level` MUST be one of `{debug,info,warn,error}`, `component`/`message`/`data` MUST follow the namespace/stable/bounded shape, `eventTime` MUST be treated as advisory and never trusted, `receivedAt` MUST be the retention clock and cross-device ordering anchor, and a single shared library MUST produce the envelope. _(Realizes: CLIENT-LOGGING-TELEMETRY-INV-03)_

- **FR-004**: Given an inbound entry, when it reaches server ingest, then privacy MUST be enforced at that choke point and not by producer convention — structural bounding (max `data` size/depth/key-count) plus an aggregate rate/volume bound per key+window MUST apply (over-limit truncated/rejected; on exceed dropped silently and the health counter bumped), and deny-list redaction of secret-suggesting key names and secret value patterns including `mpk-`/`mpg-` and MAC/IP patterns MUST rewrite matches to `[redacted]`. _(Realizes: CLIENT-LOGGING-TELEMETRY-INV-04)_

- **FR-005**: Given the DB sink, when a producer populates `data`, then `data` MUST carry structured diagnostic values only (codes/counts/durations/IDs/state-names) and MUST NOT carry user free-text content; enforcement is a convention plus a lint rule for obvious raw-user-string interpolation plus the deny-list as the structural net (NOT a hard gate, no taint analysis), and the residual risk MUST be explicitly accepted while `client_log` stays in backups. _(Realizes: CLIENT-LOGGING-TELEMETRY-INV-05)_

- **FR-006**: Given browser `console.*` output, when it fires client-side before ingest, then it MUST remain outside the redaction guarantee (the enforced guarantee covers only what crosses the server boundary); the shared logger MUST mirror to `console.*` only in dev builds, the production build MUST emit no `data` to console (at most `level`/`component`/`message`), and raw `console.*` outside the logger MUST be lint-banned. _(Realizes: CLIENT-LOGGING-TELEMETRY-INV-06)_

- **FR-007**: Given an external-sink egress, when the redacted envelope is forwarded, then it MUST forward only the enumerated fields `level`/`component`/`message`/`receivedAt`/`eventId`, and `data` MUST NOT be forwarded to an external sink absent an explicit per-integration allowlist reviewed as a privacy decision. _(Realizes: CLIENT-LOGGING-TELEMETRY-INV-07)_

- **FR-008**: Given external sinks, when they are enabled, then they MUST be operator/deploy-configured via a pluggable sink abstraction with provider config held in env/secret and MUST NOT be a household App Setting; the seam MUST be declared now with integrations later. _(Realizes: CLIENT-LOGGING-TELEMETRY-INV-08)_

- **FR-009**: Given rows in `client_log`, when they age past the window (default 30 days by `receivedAt`), then a scheduled background job (household-tz, catch-up) MUST prune them independently of ingest traffic, and pruning MUST be idempotent and separate from insert. _(Realizes: CLIENT-LOGGING-TELEMETRY-INV-09)_

- **FR-010**: Given a telemetry endpoint, when access is decided, then ingest MUST require `telemetry:write` (held by kiosk `*` keys), read/export MUST require `telemetry:admin` or `*`, every endpoint MUST declare a capability and MUST NOT exist without one (fail-closed, ADR-030), and the PIN MUST gate only the UI affordance client-side while the server MUST NOT check it. _(Realizes: CLIENT-LOGGING-TELEMETRY-INV-10)_

- **FR-011**: Given the admin read view, when `client_log` is displayed, then it MUST be a read-only severity/component/date-filterable view that renders `message`/`data` as escaped text-only (stored-XSS defense against attacker-influenceable kiosk `telemetry:write` writes) and MUST enforce a server-enforced hard-capped page size with cursor pagination (read-side product-DoS defense on the shared SQLite); export/`download-sql` MUST be deferred. _(Realizes: CLIENT-LOGGING-TELEMETRY-INV-11)_

- **FR-012**: Given the feature, when it is deployed, then telemetry MUST be always-on with no household setting to disable it, legacy `client_log` rows MUST NOT be migrated (the disposable v2 store starts empty), and the 119 prod rows MUST be treated as evidence only and never used to infer product truth. _(Realizes: CLIENT-LOGGING-TELEMETRY-INV-12)_

- **FR-013**: Given the i18n missing-translation-key signal, when a missing key is detected, then it MUST be delivered as a telemetry write (best-effort observability) and MUST NOT be modeled as a bus event, with Client Logging as the consumer. _(Realizes: CLIENT-LOGGING-TELEMETRY-INV-13)_

- **FR-014**: Given the domain event bus, when telemetry is modeled, then telemetry MUST be an ingest endpoint plus sinks and MUST NOT be a pub/sub participant; stable event-name registries MUST belong to the bus, not here, and `component`/`message` MUST remain free-text bounded values. _(Realizes: CLIENT-LOGGING-TELEMETRY-INV-14)_

- **FR-015**: Given a `data` payload at ingest, when it carries a secret-named key or `mpk-`/`mpg-` value, then it MUST be stored and forwarded as `[redacted]`, and when it is over-bound it MUST be truncated or rejected (the acceptance surface for the redaction+bounding invariant in FR-004/INV-04). _(Realizes: CLIENT-LOGGING-TELEMETRY-AC-01)_

- **FR-016**: Given the ingest pipeline, when an entry is processed, then redaction and bounding MUST be applied before the DB write and before any external send, and console output MUST NOT be covered by that guarantee. _(Realizes: CLIENT-LOGGING-TELEMETRY-AC-02)_

- **FR-017**: Given an external sink, when an envelope is forwarded to it, then it MUST receive only `level`/`component`/`message`/`receivedAt`/`eventId`, and `data` MUST NOT be forwarded absent an explicit allowlist (the acceptance surface for the external-egress invariant in FR-007/INV-07). _(Realizes: CLIENT-LOGGING-TELEMETRY-AC-03)_

- **FR-018**: Given a deployment with zero ingest traffic, when the retention window elapses, then the scheduled job MUST still prune rows past the window (the acceptance surface for the scheduled-prune invariant in FR-009/INV-09). _(Realizes: CLIENT-LOGGING-TELEMETRY-AC-04)_

- **FR-019**: Given a telemetry request, when it is authorized, then ingest MUST require `telemetry:write`, read/export MUST require `telemetry:admin`/`*`, and an undeclared-capability request MUST be rejected (the acceptance surface for the access invariant in FR-010/INV-10). _(Realizes: CLIENT-LOGGING-TELEMETRY-AC-05)_

- **FR-020**: Given a telemetry outage or failure, when it occurs, then it MUST change no product state and MUST block no user action (the acceptance surface for the never-in-control-flow invariant in FR-001/INV-01). _(Realizes: CLIENT-LOGGING-TELEMETRY-AC-06)_

- **FR-021**: Given the fresh v2 store, when the deployment initializes, then `client_log` rows MUST NOT be imported from legacy data (the acceptance surface for the no-migration invariant in FR-012/INV-12). _(Realizes: CLIENT-LOGGING-TELEMETRY-AC-07)_

- **FR-022**: Given a detected missing translation key, when the signal is emitted, then it MUST land as a telemetry write (the acceptance surface for the i18n-consumer invariant in FR-013/INV-13). _(Realizes: CLIENT-LOGGING-TELEMETRY-AC-08)_

### Key Entities

- **Client log entry**: one diagnostic row in `client_log` (id, eventTime, receivedAt,
  level, component, message, data; indexes on `receivedAt` + `component`). Disposable
  support evidence, never product truth.
- **Envelope**: the contract shape carried from producer to sink — `level`, `component`,
  `message`, `data`, `eventTime`, `receivedAt` (+ server `id`/`eventId`). Materialized by
  a single shared logger library so the format is always the same.
- **Sink**: a destination for the redacted envelope — the `client_log` DB sink (always
  on), operator-configured external observability sinks (field-restricted), and the
  client-side console (outside the redaction guarantee).
- **Redaction layer**: the server-ingest choke point that enforces structural bounding,
  aggregate rate/volume bounding, and deny-list secret/MAC/IP redaction before any
  server-side egress.

## Success Criteria

- **SC-001**: 100% of ingested `data` containing a secret-named key, `mpk-`/`mpg-` value,
  or MAC/IP pattern is stored and forwarded as `[redacted]`, and over-bound `data` is
  truncated or rejected before any write.
- **SC-002**: 100% of external-sink forwards carry only the five enumerated fields and 0
  carry `data` absent an explicit allowlist.
- **SC-003**: A telemetry outage produces 0 product-state changes and blocks 0 user
  actions; an aggregate flood writes 0 unbounded rows and bumps the health counter.
- **SC-004**: The scheduled prune deletes 100% of rows past the window on a zero-ingest
  deployment, and 0 legacy rows are present after initialization.

## Assumptions

- The concrete logger API/wire format and the redaction library are DX-contract +
  implementation details against this contract; exact bound values and the final deny-list
  are implementation-tuned to real producers.
- The admin diagnostics read/export UI ergonomics and per-external-integration `data`
  allowlists are deferred — each allowlist is a separate privacy decision when an
  integration is built.
- Auth & Sessions owns the `telemetry:write`/`telemetry:admin` capability gating and the
  kiosk-`*` trust model (ADR-030); Backups owns that `client_log` rides the single-file
  copy (ADR-042); the scheduled-job runner is provided per ADR-014.
- The kiosk-`*` model means any provisioned device satisfies the read gate at the API
  layer; this is accepted under the family threat model and never represented as a
  server-side PIN control.
