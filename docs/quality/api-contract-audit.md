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
