# Initial HTTP contract audit

The stronger body audit detected contract drift in BFULL commit
`7ba302ff0ef2f4ca3945ca44703db8fd8a578185` on 2026-09-29. The prior same-name DTO
check did not establish complete body equivalence.

## Recorded baseline

- 2,203 boundary/integration tests passed, with no failures or pending cases.
- 1,631 synthetic HTTP transactions were captured across 19 contracts.
- 103 grouped validation findings were detected; these are not independent defect counts.
- Of the 82 schema entries skipped by the old checker, 73 had references from
  observed validated bodies; nine remained without that evidence.
- 270 of 353 body contracts had observations. All documented operations had at
  least one observation, but that does not cover every status or payload branch.

These numbers describe the original BFULL audit, not a fresh run of this checkout.

## Confirmed examples

- `Chore` responses contain `icon`, which the strict chores contract omits.
- Scheduled `Reminder` responses contain `query` and `queryFields`, which the
  strict scheduled-reminders contract omits.
- The briefing-render contract references the absent historical file
  `../../010-daily-briefing-manual/contracts/openapi.yaml`.

The nine entries without evidence were `PrintedStatus` (blocked by that broken
reference), `WeatherConditionKey` and `WeatherBlockPayload` in daily-briefing
(unreferenced by operation bodies), plus six authorization/error component
entries across briefing-render, daily-briefing and plugin-lifecycle.

Other findings require triage against their recorded test. Some member UUID
violations come from seeded fixture identifiers; some statuses come from isolated
route mounts or deliberately mocked failures. Do not change API behavior merely
to silence the report.

## Run and investigate

Use the [auditor instructions](../../tools/api-contract-audit/README.md). Generated
reports belong under `.quality`, not in maintained source. Each finding records
its test name and observation line for reproduction. No original product behavior,
contract or BFULL tag was changed while adding this diagnostic.

## Maintained repair model

The repair preserves the original baseline above as historical evidence. Current
contracts describe the versioned briefing envelope (including retired v1 names),
nullable chore icons, kind-aware reminder targeting, strict calendar creation and
partial edits, asynchronous external-source configuration, and per-entry telemetry
drops. Routine edits continue to accept and ignore an immutable dayPeriodId.
Public member creation still generates UUIDs; the contract also recognizes the
stable `demo:member:` namespace used by maintained public seeds. Ordinary member
fixtures use UUIDs rather than relaxing the contract to arbitrary strings.

Authentication and availability responses are local component references on the
operations proven by boundary tests and middleware. Plugin unavailability,
quiescent restore and handler errors retain their distinct envelopes. Binary
transports remain coverage gaps; the deliberate encoded provisioning access form
is recorded as a middleware observation, not added to the JSON API contract.

Fresh captures, per-finding classification, RED/GREEN logs and validation receipts
remain ignored in the implementation worktree. A replay is useful for diagnosis
but cannot establish runtime provenance. Zero observed conflicts does not close
unobserved body variants, state-dependent invariants or transport exclusions.
The coverage-policy file inventory, per-file minima and layer floors are
reconciled separately against the current maintained files and real V8
measurements. Existing per-file minima and layer floors remain unchanged; newly
maintained modules receive explicit measured policies. Calendar edit regressions cover successful rescheduling and merged-state
rejection instead of lowering its retained minima. Historical baseline measurements
above remain historical evidence.

Unobserved variants require a risk-based disposition, not one bespoke test each.
Successful printing acknowledgement and transport bytes, authorization matrices,
and restore rejection safety have focused HTTP checks. Binary observations remain
auditor gaps even when external transport checks pass. Shared or defensive errors
can be justified with exact handler/test evidence; they are not silently excluded
from future reports. See the auditor's prioritization guidance.
