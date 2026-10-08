# Client Logging / Telemetry Domain Contract

Status: maintained contract
Depends on decisions: `ADR-014`, `ADR-015`, `ADR-016`, `ADR-019`, `ADR-026`, `ADR-030`,
`ADR-032`, `ADR-035`, `ADR-037`, `ADR-040`, `ADR-050`, `ADR-053`, `ADR-057`

## Purpose

Bounded, best-effort, privacy-bounded, **operationally disposable** browser-side
diagnostics so an operator can understand kiosk/printer failures outside the server
request lifecycle. **Support evidence only** — never product truth, never in any product
control flow.

## Vocabulary

- **Client log entry** — one diagnostic row in `client_log`.
- **Envelope** — the contract shape: `level`, `component`, `message`, `data`, `eventTime`,
  `receivedAt` (+ server `id`/`eventId`).
- **Sink** — a destination for the redacted envelope: the `client_log` DB, an external
  observability service, (and client-side console, which is _not_ under the redaction
  guarantee).
- **Redaction layer** — the server-ingest choke point enforcing bounding + secret
  redaction before any server-side egress.

## Invariants

1. **CLIENT-LOGGING-TELEMETRY-INV-01** **Never product truth / never in control flow** (`ADR-016`): a telemetry row never
   proves success, recovers state, or drives a workflow (e.g. a `delivery_success` log is
   not a print acknowledgement, `ADR-019`). A telemetry failure blocks nothing.
2. **CLIENT-LOGGING-TELEMETRY-INV-02** **Best-effort, at-most-once:** in-memory client buffer, no durable retry, send failures
   swallowed, no offline replay. A local failure counter may feed the global health
   indicator (`ADR-035`). Best-effort flush on `unload` (no guarantee).
3. **CLIENT-LOGGING-TELEMETRY-INV-03** **Envelope contract** (`ADR-016`): `level ∈ {debug,info,warn,error}`; `component`
   namespace; stable `message`; bounded `data`; **`eventTime` (client) advisory, never
   trusted**; **`receivedAt` (server) is the retention clock + cross-device ordering
   anchor**. A single shared library materializes the envelope ("same format always"); the
   concrete API/serialization is a DX/impl detail.
4. **CLIENT-LOGGING-TELEMETRY-INV-04** **Privacy is enforced at server ingest, not by producer convention** (`ADR-016`):
   (a) structural bounding (max `data` size/depth/key-count; over-limit truncated/
   rejected) **+ an aggregate rate/volume bound per key+window** (re-grill 2026-06-30):
   per-entry caps don't stop a flood, and ingest writes to the same SQLite file as all
   product data (`ADR-055`), so an unbounded flood is a **product DoS** → on exceed, drop
   silently + bump the health counter (`ADR-035`); exact values are impl-tuned, the
   invariant is fixed; (b) deny-list redaction (secret-suggesting key names + secret value
   patterns incl. `mpk-`/`mpg-`, `ADR-037`, **and MAC/IP value patterns, `ADR-053`**) →
   `[redacted]`. This makes the Auth no-secrets + Network Devices no-raw-identifier
   invariants actually enforced. (Network Devices also drops IPs at ingest and never paints
   raw MACs, so the deny-list is a defensive net, not the primary control — minimization
   comes first.)
   4b. **CLIENT-LOGGING-TELEMETRY-INV-05** **DB-sink minimization at source** (re-grill 2026-06-30): the DB sink's threat model is
   **not** device-local — `data` is rendered to a human by the admin view (`ADR-057`) and
   rides every backup off-device (`ADR-042`), where a deny-list can't catch unstructured PII.
   So `data` carries **structured diagnostic values only** (codes/counts/durations/IDs/
   state-names), **never user free-text content**. **Enforcement is honest:** a convention +
   a lint rule for _obvious_ violations (raw user-string interpolation) + the deny-list as
   the **structural net** — NOT a hard gate (no taint analysis; `{reason: plan.summary}`
   lints clean). The residual is **explicitly accepted**. `client_log` stays in backups
   (backups are already max-sensitivity, `ADR-042`; excluding one table would tax the
   single-file copy for no proportionate gain).
5. **CLIENT-LOGGING-TELEMETRY-INV-06** **Console is out of the redaction guarantee** (`ADR-016` peer-review B): browser
   `console.*` fires client-side before ingest; it is producer-side best-effort dev tooling
   with no contract. The enforced guarantee covers only what crosses the server boundary.
   **Console build control** (re-grill 2026-06-30, refines not contradicts): the shared
   logger mirrors to `console.*` **only in dev builds** — the **production build emits no
   `data` to console** (at most `level`/`component`/`message`) — and **raw `console.*` is
   lint-banned** outside the logger. Prod console is non-sensitive by construction; still no
   runtime contract on console.
6. **CLIENT-LOGGING-TELEMETRY-INV-07** **External-sink egress forwards only enumerated fields** (`ADR-016` peer-review A):
   `level`, `component`, `message`, `receivedAt`, `eventId` — **`data` is never forwarded**
   to an external sink without an explicit per-integration allowlist reviewed as a privacy
   decision. (Deny-list+bounding remains the guard for the device-local DB sink.)
7. **CLIENT-LOGGING-TELEMETRY-INV-08** **External sinks are operator/deploy-configured** (`ADR-016`/`ADR-032`): a pluggable
   sink abstraction fans the redacted envelope out; provider config is env/secret, **not**
   a household App Setting. Seam declared now, integrations later.
8. **CLIENT-LOGGING-TELEMETRY-INV-09** **Retention via scheduled job** (`ADR-016`/`ADR-014`): rows older than the window
   (default 30 days, by `receivedAt`) are pruned by a scheduled background job
   (household-tz, catch-up), independent of ingest traffic. Pruning idempotent; insert
   separate.
9. **CLIENT-LOGGING-TELEMETRY-INV-10** **Access (named capabilities, fail-closed `ADR-030`):** ingest requires
   `telemetry:write` (held by kiosk `*` keys); read/export requires `telemetry:admin` or
   `*`. No undeclared-capability endpoint. **Honest authz caveat** (`ADR-057`, re-grill):
   kiosk device keys ARE `*` (`ADR-030`), so the `or *` branch means **any provisioned
   device satisfies the read gate at the API layer** — the admin view is not server-side
   admin-confined. The PIN (`ADR-013`) gates the **UI affordance client-side only**; the
   server never checks it. Accepted under the family threat model; documented, never
   represented as a server-side PIN control. (Cross-cutting kiosk-`*` model wart, `ADR-030`/
   `ADR-053` — acknowledged, unresolved.)
   9b. **CLIENT-LOGGING-TELEMETRY-INV-11** **Admin read view** (`ADR-057`): a read-only, severity/component/date-filterable view of
   `client_log` (the self-hoster's only diagnostic surface — no `fly logs`/SSH). Two load-
   bearing impl invariants: **escaped text-only rendering** (`message`/`data` are attacker-
   influenceable via kiosk `telemetry:write` → stored-XSS into the admin session otherwise)
   and a **server-enforced hard-capped page size + cursor pagination** (read-side product-DoS
   on the shared SQLite otherwise). Shows `data` as stored; export/`download-sql` deferred.
10. **CLIENT-LOGGING-TELEMETRY-INV-12** **Always-on; no household setting** (`ADR-016`, spec §3). **No migration** (`ADR-026`):
    `client_log` disposable; 119 prod rows are evidence only; never infer product truth.
11. **CLIENT-LOGGING-TELEMETRY-INV-13** **i18n missing-key signal consumer** (`ADR-015`): the missing-translation-key signal is
    a telemetry write (best-effort observability), not a bus event — Client Logging is the
    consumer.
12. **CLIENT-LOGGING-TELEMETRY-INV-14** **Not a domain-event-bus participant** (`ADR-040`): telemetry is an ingest endpoint +
    sinks, not pub/sub. Stable event-name registries belong to the bus (`ADR-050`), not
    here — `component`/`message` are free-text bounded values.

## Behaviors

- **Emit (browser):** a producer logs `{level, component, message, data?}`; immediate
  console (best-effort), deferred buffered submission. Sink errors never throw into the
  caller.
- **Buffer + submit:** volatile device-local buffer; periodic flush posts a bounded batch;
  at-most-once (batch removed before send). Failures swallowed.
- **Ingest (server):** validate the batch; **apply bounding + redaction**; write rows to
  the DB sink; fan the redacted, field-restricted envelope to any configured external sink.
- **Prune (scheduled):** delete rows older than the window by `receivedAt` (`ADR-014`).
- **Read (admin):** `telemetry:admin`/`*`; severity/component/date filter; escaped render +
  capped pagination (`ADR-057`). **Export/`download-sql`:** deferred.

## Interfaces

- Inbound: telemetry ingest (`telemetry:write`); read/export (`telemetry:admin`/`*`,
  deferred UI). The shared logger API (producer-facing) is a DX-contract surface.
- Outbound: pluggable sinks (DB always; external sinks operator-configured, field-
  restricted). Not on the domain event bus.

## Events

(`ADR-040`.) **Emits: none. Subscribes: none.** Telemetry is an ingest+sink pipeline, not
a bus participant. It **consumes the i18n missing-key signal as a telemetry write**
(`ADR-015`), not as a subscribed bus event.

## Data / Setup Contract

Owned: `client_log` (id, eventTime, receivedAt, level, component, message, data; indexes
on `receivedAt` + `component`). Fresh deployment (`ADR-026`), no import. Scheduled prune registered
with `ADR-014`. External-sink config is deploy-level (env/secret), absent by default; no
settings object. The redaction layer + shared logger library are build/impl artifacts
against this contract.

## Acceptance Criteria

- **CLIENT-LOGGING-TELEMETRY-AC-01** `data` with a secret-named key or `mpk-`/`mpg-` value is stored/forwarded as
  `[redacted]`; over-bound `data` is truncated/rejected.
- **CLIENT-LOGGING-TELEMETRY-AC-02** Redaction+bounding applies at ingest before the DB write and any external send; console
  is not covered.
- **CLIENT-LOGGING-TELEMETRY-AC-03** An external sink receives only `level`/`component`/`message`/`receivedAt`/`eventId`;
  `data` is not forwarded absent an explicit allowlist.
- **CLIENT-LOGGING-TELEMETRY-AC-04** Rows past the window are pruned by the scheduled job even with zero ingest traffic.
- **CLIENT-LOGGING-TELEMETRY-AC-05** Ingest needs `telemetry:write`; read/export needs `telemetry:admin`/`*`; undeclared =
  rejected.
- **CLIENT-LOGGING-TELEMETRY-AC-06** A telemetry outage/failure changes no product state and blocks no user action.
- **CLIENT-LOGGING-TELEMETRY-AC-07** No `client_log` rows are imported from legacy data.
- **CLIENT-LOGGING-TELEMETRY-AC-08** The i18n missing-key signal lands as a telemetry write.

## Open Decisions

- Concrete logger API/wire format + redaction library — DX contract + implementation.
- Exact bound values + final deny-list — implementation, tuned to real producers.
- Diagnostics read/export UI (filtering, access ergonomics) — deferred.
- Per-external-integration `data` allowlists — each a separate privacy decision when an
  integration is built.

## Peer Review

`ADR-016` peer-reviewed (blind-debate 2026-06-29, with `ADR-050`): 1 Critical + 2 Important
incorporated — console removed from the redaction guarantee (client-side, pre-ingest);
external-sink egress restricted to enumerated envelope fields (`data` never forwarded
without an allowlist); named `telemetry:write`/`telemetry:admin` capabilities for the
fail-closed model. `ADR-050` (typed event catalog) reviewed sound (separate; governs the
bus, not telemetry).

### Internal subscriber diagnostics

Server event-handler failures use the same redacted store and admin read surface.
The `event-bus` component is reserved for trusted server writes; browser entries
using it are dropped. Internal writes retain validation, bounding, redaction,
retention and sink projection, but bypass browser flood admission. Administration
provides a Subscriber failures filter shortcut (`error`, `event-bus`). A stable
`event-bus.subscriber-failed` message and unique `failureId` identify each failure;
diagnostic data names the event and subscriber without including event payloads.
If persistence fails, redacted stderr is the fallback and the failed insert is
unavailable in the admin database query. Subscriber actions are never retried.
