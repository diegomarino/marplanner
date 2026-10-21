# ADR-016 Client Telemetry: Privacy, Retention, Sinks, Best-Effort Contract

Status: accepted
Owner: architecture + DX
Decision date: 2026-06-29

## Decision

Client Logging / Telemetry is **bounded, best-effort, privacy-bounded, operationally
disposable** browser-side diagnostics. Support evidence only — never product truth, never
in any product control flow (a `delivery_success` log is not a print acknowledgement,
`ADR-019`). A telemetry failure must never block boot/nav/print/chores/meals/calendar/
auth/settings.

**Privacy: central redaction + bounding at the server ingest choke point (enforced, not
convention).** "Producers sanitize" is a convention, not a guarantee (same footgun as
i18n dynamic keys / Reminders gating). The single point all telemetry passes through —
**server ingest** — enforces:

1. **Structural bounding:** hard limits on `data` size, nesting depth, and key count
   (today only entry-count and `component`/`message` length are bounded); over-limit is
   truncated/rejected, never stored unbounded. **Plus an aggregate rate/volume bound per
   key + window** (re-grill 2026-06-30): per-entry caps do not stop a _flood_. Ingest is
   reachable by the most-exposed credential (kiosk `*` key, below) and writes to the
   **same SQLite file as all product data** (ADR-055) — an unbounded flood (malicious, or
   a buggy client retry loop) is a **DoS of the product**, not merely of telemetry. On
   exceed: **drop silently + increment the health counter** (ADR-035) — best-effort
   semantics already permit dropping telemetry, so shedding excess is coherent, not a
   regression. Exact rate/volume values join the implementation open question; the
   _invariant_ (ingest is aggregate-bounded server-side) is fixed here.
2. **Deny-list redaction:** keys whose name suggests a secret (`*token*`, `*key*`, `pin`,
   `secret`, `cookie`, `authorization`, `password`, `url`) and values matching known
   secret patterns (`mpk-`/`mpg-` credential prefixes, `ADR-037`; credential-shaped
   blobs) are replaced with `[redacted]`.
3. **Defense in depth:** producers still should not emit junk (client best-effort), but
   the _guarantee_ lives at ingest. This makes the Auth invariant ("logs must never
   contain raw PINs/API keys/cookies/access-gate tokens") actually **enforced**.

**Redaction is the SERVER-INGEST guarantee (covers the DB sink and external sinks).**
The redaction+bounding layer sits at server ingest, in front of the `client_log` DB sink
and any external sink. **Console is NOT covered by this guarantee** (peer-review B — a
false-invariant fix): browser `console.*` fires **client-side, synchronously, before** the
server ever sees the envelope, so the server choke point physically cannot redact it.
Console is **development/operator tooling, producer-side best-effort, no contract**;
producers still must not log secrets to console, but that is a best-effort rule, not the
enforced guarantee. The enforced guarantee holds cleanly for everything that crosses the
server boundary.

**Console build control (re-grill 2026-06-30) — refines the above, does not contradict it.**
Console stays outside the _server_ redaction guarantee; separately, two **client-build**
controls make the **production** console non-sensitive by construction (the kiosk runs in a
family kitchen — devtools, screenshots, screen-shares are real exposure): (1) the shared
logger **mirrors to `console.*` only in dev builds**; the **production build emits no `data`
to console** (at most `level`/`component`/`message`). (2) **Raw `console.*` is lint-banned**
outside the logger (`eslint-plugin-marplanner`) so there is no bypass — all diagnostics flow
through the logger, which in prod does not mirror sensitive fields. This is additive hardening
(a build-time property), not a new runtime contract on console.

**External-sink egress forwards ONLY enumerated envelope fields — never `data`**
(peer-review A — the highest-value privacy fix). A deny-list catches credential-shaped
values but **cannot** catch unstructured PII (a calendar description with a home address,
a Bluetooth label, a briefing fragment) — structurally indistinguishable from benign log
text. So to an external SaaS the system forwards **only** `level`, `component`, `message`,
`receivedAt`, `eventId` — **the `data` object is NOT forwarded.** An external integration
that needs richer context must add an **explicit per-integration allowlist, reviewed as
its own privacy decision.** (The deny-list + bounding remains a guard for the **local DB**
sink — but see DB-sink minimization below: its threat model is _not_ purely device-local.)

**DB-sink minimization at source (re-grill 2026-06-30).** The original "the local DB's
threat model is device-local" justification is **false**: (a) the admin read view (`ADR-057`)
renders stored `data` to a human, and (b) `client_log` lives in the single SQLite file, so it
**rides every backup off-device** (backups are downloadable sensitive exports, `ADR-042`). A
deny-list **cannot** catch unstructured PII (a calendar description with a home address, a
briefing fragment) in either place. The guard is **minimization at the source**: `data`
carries **structured diagnostic values** (codes, counts, durations, IDs, state-names),
**never user free-text content**. **Honest enforcement strength:** this is a **convention** —
a lint rule catches _obvious_ violations (raw string-literal/user-input interpolation into
`data`) but cannot perform taint analysis (`{ reason: plan.summary }` type-checks and lints
clean), so the deny-list remains the **structural net** and the minimization residual is
**explicitly accepted**, not claimed as a hard gate. (Network Devices `ADR-053` already
applies the same minimization-first ethos.) **Backups keep `client_log`** (rejected the
exclude-from-backups alternative): a backup is _already_ the highest-sensitivity artifact
(`ADR-042` — it contains auth/session rows regardless), so the backup threat model does not
change with telemetry content, and excluding one table would tax `ADR-042`'s dead-simple
single-file copy for no proportionate gain.

**Envelope contract now; library/wire format later (DX).** This decision fixes the
**envelope invariants** (load-bearing): `level` ∈ `{debug,info,warn,error}`; `component`
namespace; stable `message`; bounded `data`; `eventTime` (client `ts`) is **advisory,
never trusted** (clock drift); `receivedAt` (server) is the **retention clock and
cross-device ordering anchor**. The **concrete logger API, field names, and serialization
are an implementation/DX detail**, built later against this contract. A **single shared
logging library** materializes the envelope so the format is identical across producers
and environments ("same format always").

**DX split.** Two intersecting concerns are separated:

- **This domain (`ADR-016`)** owns the _persisted telemetry data contract_ — privacy,
  retention, access, best-effort semantics, and **redaction enforcement**.
- **The DX contract ([developer verification policy](../../quality/verification.md))** owns _developer logging ergonomics_ —
  the shared logger API, levels, format details, and **developer-facing English always**
  (`ADR-015`).
- They meet at the **envelope + redaction layer**.

**External observability sinks (New Relic / Datadog / Sentry): pluggable, operator-
configured.** A **pluggable sink abstraction** fans the same redacted envelope out to N
destinations. External sinks are **deploy/operator-level configuration** (env/secret,
`ADR-032`-style) — **not** a household App Setting (chosen option A): observability is the
deployer's concern, keeps third-party credentials out of the household UI and the kiosk
simple. The seam is declared now; concrete provider integrations are built later
("declare-now, enforce-later", as with plugins). A future household-level toggle can ride
the same seam if ever needed.

**Retention: scheduled prune job (canonical), not ingest-only.** Pruning rows older than
the window (default **30 days**, by `receivedAt`) runs as a **scheduled background job**
(`ADR-014`, household-tz, with its catch-up) instead of only-during-ingest. This closes a
real silent hole: today, if clients stop logging, rows (with possibly accidental PII)
survive indefinitely past 30 days. Pruning is idempotent; insertion is a separate op (no
prune-before-insert atomicity hazard).

**Access asymmetry (named capabilities, peer-review C).** Auth is capability-declared and
fail-closed (`ADR-030`: every endpoint declares one `domain:verb` capability; undeclared =
rejected). So telemetry endpoints name their capabilities explicitly rather than relying
on "any API-authorized client": **ingest requires `telemetry:write`** (held by kiosk `*`
device keys, so any provisioned kiosk can submit — the intent, since failures happen
before/outside admin); **read/export requires `telemetry:admin` (or `*`)**, because rows
may contain member IDs, dates, messages. The **read view is now in scope** (`ADR-057`,
re-grill 2026-06-30, promoted by the distributable premise — a self-hoster has no
`fly logs`/SSH); **export/`download-sql` stays deferred**. **Honest authz caveat
(`ADR-057`):** because kiosk device keys are `*` (`ADR-030`), the `or *` branch means **any
provisioned device satisfies the read gate at the API layer** — the view is not server-side
admin-confined. The PIN (`ADR-013`) gates the **UI affordance client-side only**; the server
never consults it. Accepted under the family threat model, documented — **not** represented as
a server-side PIN control. (Root cause is the cross-cutting kiosk-`*` model wart, `ADR-030`/
`ADR-053`; **closed by `ADR-058`** — ratified as a deliberate single household trust tier.)

**Always-on, no product setting.** Telemetry is always-on for connected kiosks; no
household App Setting controls it (spec §3; don't invent a product control).

**No migration.** `client_log` is disposable; not imported (`ADR-026`). The 119 prod rows
are evidence only. Telemetry never infers product truth.

**Best-effort semantics.** At-most-once; **no durable retry**; send failures swallowed;
never inspect-and-block product behavior. A **local failure counter may feed the global
health indicator** (`ADR-035`). Best-effort flush on `unload` (cheap, no guarantee). No
offline replay.

**Event-name vocabulary is NOT here.** A stable component/message registry is YAGNI for
logging (free-text bounded values suffice). The stable-name _registry_ requirement
belongs to the **domain event bus** (`ADR-040`), not telemetry — moved out of scope (see
the ADR-040 event-name registry refinement).

## Rationale

Telemetry's value is explaining failures without ever becoming load-bearing. The one real
risk is privacy: an open `data` field + 30-day retention + (now) third-party forwarding
turns a producer mistake into a PII leak. Enforcing redaction+bounding at the single
ingest choke point (and before any egress) converts the Auth no-secrets invariant from
aspiration into guarantee, cheaply. Moving retention to the scheduler removes a
traffic-dependent survival hole. Operator-only external sinks add the requested
observability without bloating the household surface or leaking third-party credentials
into the UI.

## Affected Specs

- [client-logging-telemetry](../../features/client-logging-telemetry.md), [auth-sessions](../../features/auth-sessions.md) (redaction
  enforcement), [developer verification policy](../../quality/verification.md) (logger ergonomics)

## Data / Setup Implications

Owned: `client_log` (id, eventTime, receivedAt, level, component, message, data). Fresh
v2 (`ADR-026`); no import. Scheduled prune registered with `ADR-014`. External-sink config
is deploy-level (env/secret), absent by default. No household settings object.

## Acceptance Criteria

- A submitted `data` containing a key like `apiKey`/`pin`/`cookie` or a value with an
  `mpk-`/`mpg-` prefix is stored/forwarded as `[redacted]`.
- A telemetry flood (rate/volume past the ingest bound) is dropped at ingest with a health
  counter increment, never filling the shared product datastore.
- `data` is a structured-value object; obvious user-free-text interpolation is lint-flagged
  (minimization is convention + deny-list net, not a hard gate — accepted residual).
- In a production build, no `data` is mirrored to the browser console; raw `console.*`
  outside the logger fails lint.
- `data` exceeding size/depth/key bounds is truncated/rejected, never stored unbounded.
- Redaction+bounding is applied at server ingest before the row is written to the DB sink
  or sent to any external sink (console is explicitly out of this guarantee).
- An external sink receives only `level`, `component`, `message`, `receivedAt`, `eventId`;
  the `data` object is never forwarded to an external sink absent an explicit
  per-integration allowlist.
- Rows older than the retention window are removed by the scheduled job even with zero
  ingest traffic.
- Telemetry ingest requires the `telemetry:write` capability (held by kiosk `*` keys);
  read/export requires `telemetry:admin` or `*`. An endpoint with no declared capability
  is rejected (`ADR-030` fail-closed).
- A telemetry outage/failure changes no product state and blocks no user action.
- External sinks are configured only via deploy config; no household settings object
  exists for them.
- No `client_log` rows are imported from legacy data.

## Open Questions

- Concrete logger API/wire format and the redaction implementation library — DX contract
  - implementation (against this envelope).
- Exact bound values (size/depth/keys **+ ingest rate/volume per key+window**) and the
  final deny-list — implementation, tuned to real producers.
- Diagnostics read is governed by ADR-057; a separate telemetry-export privacy decision remains open.

## Peer Review

codex-peer-review blind-debate (2026-06-29), reviewed with `ADR-050`. **1 Critical + 2
Important, all incorporated** (no restructuring). **B (Critical):** "redaction before
egress to ANY sink" was a false invariant — browser console fires client-side before
ingest, so the server cannot redact it → console reclassified as producer-side best-effort
dev tooling, outside the enforced guarantee (which now cleanly covers DB + external
sinks). **A (Important, highest-value privacy fix):** a deny-list cannot catch unstructured
PII headed to a third party → external-sink egress restricted to enumerated envelope
fields (`level`/`component`/`message`/`receivedAt`/`eventId`), **`data` never forwarded**
without an explicit per-integration allowlist privacy review; deny-list+bounding stays the
right guard for the device-local DB sink. **C (Important):** ingest had no named capability
vs `ADR-030` fail-closed → named `telemetry:write` (ingest) / `telemetry:admin`|`*`
(read-export). Confirmed sound: retention catch-up (`ADR-014`), 30-day window, best-effort
semantics, and the i18n-signal-to-telemetry seam.

**Security re-grill (2026-06-30, codex blind-debate).** Surfaced by Codex during the ADR-055/056
platform review; re-examined whether ADR-016's original treatment was _sufficient_. Four fronts,
peer-reviewed (1 Critical + 3 Important folded): **(Q1)** added the **aggregate ingest rate/volume
invariant** (per-entry caps don't stop a flood; telemetry shares the product datastore → flood =
product DoS). **(Gap 3)** **DB-sink minimization at source** — overturned the false "device-local"
justification (admin view + backups carry `data` off-device); honest framing = convention + lint
for-obvious + deny-list net (NOT a hard gate; the TS-branded-type alternative was considered and
declined for simplicity); backups keep `client_log` (already max-sensitivity per ADR-042). **(Gap 2)**
**console build control** — prod build mirrors no `data` to console + lint-ban raw `console.*`;
refines (does not contradict) finding B. **(New)** **read view promoted to `ADR-057`** (distributable
premise) with its own Critical fix (escaped rendering vs stored-XSS from kiosk-injected rows) +
read-side DoS bound + the honest kiosk-`*`/PIN-is-client-side authz caveat.

## Traceability

- Related prior: `ADR-016`.
- Related: `ADR-014`, `ADR-015`, `ADR-019`, `ADR-026`, `ADR-030`, `ADR-032`, `ADR-035`,
  `ADR-037`, `ADR-040`
