# ADR-057 Admin Telemetry Read View

Status: accepted
Owner: product + architecture + security
Decision date: 2026-06-30
Peer-reviewed: yes (codex blind-debate, 2026-06-30 — re-grill of ADR-016; 1 Critical + 3 Important folded)
Grill: `domain-grills/client-logging-telemetry.md` (historical record, not preserved in this repository) (ADR-016 security re-grill)
Builds on / refines: `ADR-016` (telemetry contract), `ADR-013` (PIN UI gate), `ADR-030` (capabilities),
`ADR-035` (health), `ADR-042`/`ADR-017` (backups).

## Decision

Promote the **diagnostics read view** from "deferred" (ADR-016) to **in-scope for this system**: a
**read-only, in-app admin view of `client_log`, filterable by severity**.

**Premise-driven reversal.** ADR-016 deferred the read/export UI when v2 was the maintainer's
single box. The **distributable self-hostable premise** (ADR-055/056) removes the self-hoster's
out-of-band diagnostic surfaces — a non-technical operator running the image on a NAS/PaaS has **no
`fly logs`, no guaranteed SSH, no appetite to open SQLite by hand**. The in-app view is their **only
realistic way to read the diagnostics telemetry already collects**. Write-only telemetry is useless
to a self-hoster.

### Scope (tight, anti-creep)

- **Read-only**, under the `admin/` surface.
- **Filter by `severity`** (the asked-for axis) + **`component`** + **date range**; results ordered
  by `receivedAt` (the cross-device ordering anchor, ADR-016).
- Shows **`data` as stored** — i.e. deny-list-redacted + minimized per ADR-016; the view adds **no
  un-redaction**.

### Security invariants (peer-review, load-bearing)

1. **Escaped, text-only rendering (XSS — Critical).** `message` and `data` are **attacker-
   influenceable**: any kiosk device key holds `telemetry:write` (ADR-016) and can inject arbitrary
   rows. The view MUST render every telemetry field as **escaped text / a JSON literal, never HTML
   interpolation** (no `innerHTML`, no markdown/HTML renderer, no syntax-highlighter that emits raw
   markup). Without this, a kiosk-injected `message` like `<img src=x onerror=…>` executes **stored
   XSS in the viewing admin's session** (where `telemetry:admin`/`*` is present). This is an
   **implementation invariant**, not merely a lint rule — the attack chain is
   `telemetry:write` (low-priv kiosk) → `client_log` row → admin render → XSS in admin session.
2. **Server-enforced read bound (read-side DoS — Important).** The read endpoint MUST enforce a
   **hard-capped maximum page size** (server-side, e.g. ≤ a fixed constant) and **cursor-based
   pagination** — never an unbounded `limit`. `client_log` shares the single SQLite file with all
   product data (ADR-055); an unbounded `?limit=99999` full scan contends with every product
   read/write (SQLite serializes), reproducing from the read side the same product-DoS that ADR-016's
   ingest rate/volume bound prevents from the write side. "Ordered by `receivedAt`" is an ordering,
   not a bound.
3. **Authorization posture (honest, accepted).** The endpoint is gated by `telemetry:admin` **or
   `*`** (ADR-016). Because **every provisioned kiosk device key is a `*` key** (ADR-030), **any
   provisioned device satisfies this gate at the API layer** — the view is **not** server-side
   confined to "admins". The **PIN (ADR-013) gates only the UI affordance, client-side; the server
   never consults it.** This is **accepted under the family threat model** (the operator's household
   devices are all trusted-ish) and documented here rather than papered over. **Do not represent the
   PIN as a server-side access control.** (The broader "kiosk `*` defeats admin confinement" model
   wart — already hit ad-hoc by ADR-053 — is **resolved by `ADR-058`**: a deliberate single
   household trust tier; telemetry-read is intentionally household-tier.)

### Out of scope (deferred / YAGNI)

- **Export / `download-sql`** — a larger privacy surface (off-device sensitive export); deferred as
  its own decision, not bundled into the read view.
- Live tail, charts, alerting, retention configuration, per-row drill-downs beyond the stored fields.

## Rationale

The distributable premise turns a deferred nicety into the operator's primary diagnostic surface.
The view is cheap _as long as_ its two structural hazards are closed at decision time — escaped
rendering (because the data is attacker-influenceable) and a server-enforced read bound (because the
log table shares the product datastore). The authorization reality (kiosk `*` keys satisfy the gate;
PIN is client-side) is documented honestly so the threat model is not misread later.

## Affected Specs

- [client-logging-telemetry](../../features/client-logging-telemetry.md) (read view), `../domain-contracts/client-logging-telemetry.md`
- `target-dx-contract-v2.md` (the view is part of the admin UI; rendering-escape + page-cap are impl
  invariants)

## Data / Setup Implications

No new table; reads `client_log` (ADR-016). No new capability (`telemetry:admin`/`*` already named in
ADR-016). The read endpoint declares `telemetry:admin` (fail-closed, ADR-030); `*` satisfies it.

## Acceptance Criteria

- A `client_log` row whose `message` contains `<img src=x onerror=…>` renders as inert escaped text
  in the admin view — no script executes in the admin session.
- A read request with an oversized `limit` is clamped to the server's hard-capped page size; deep
  paging uses a cursor, never a full unbounded scan.
- The view filters by severity (and component / date range) and orders by `receivedAt`.
- The endpoint requires `telemetry:admin`/`*` and is fail-closed (no declared capability ⇒ 403).
- `data` is shown exactly as stored (redacted + minimized); the view performs no un-redaction.
- Export / `download-sql` is NOT part of this view.

## Open Questions

- Concrete page-cap constant and cursor encoding — implementation (joins ADR-016's "exact bound
  values" open question).
- Read/export ergonomics beyond severity filtering (saved filters, etc.) — later product/DX.

## Traceability

- Re-grill of `ADR-016` (telemetry security), 2026-06-30.
- Related: `ADR-013`, `ADR-016`, `ADR-030`, `ADR-035`, `ADR-042`, `ADR-053`, `ADR-055`.
