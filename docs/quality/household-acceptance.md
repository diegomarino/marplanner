# Household Flow Acceptance Evidence Contract

## Purpose

This document defines the evidence required for whole-household acceptance. Store each release record alongside its release evidence, bound to an exact revision.

## Run Header

Every acceptance record begins with:

```markdown
## Run <run-id>

- Revision: `<full-commit>`
- Runtime: `Node 24.21.0`
- Starting state: `<unconfigured|fresh-storage|public-demo|demo-rollover|ordinary-data-safety>`
- Household date: `<YYYY-MM-DD|not-applicable>`
- Household timezone: `<IANA-zone|not-applicable>`
- Data isolation: `<temporary isolated directory description>`
- Result: `<open|passed|failed>`
```

The record never contains an access token, bootstrap key, PIN, private URL, service UUID,
characteristic UUID, device identifier, IP address, MAC address, or private overlay value.

## Journey Matrix

Each approved scenario has one row:

| Journey | Scenario | Starting state | Member/date context             | Expected                        | Observed        | Evidence level | Status     | Finding        | Comparison        |
| ------- | -------- | -------------- | ------------------------------- | ------------------------------- | --------------- | -------------- | ---------- | -------------- | ----------------- |
| US4     | 1        | public-demo    | household date, selected member | Local event appears without PIN | `<observation>` | rendered-ui    | `<status>` | `<id or none>` | `<comparison-id>` |

### Allowed evidence levels

- `synthetic-local`: deterministic domain, persistence, seed, or boundary behavior without the full
  running journey;
- `running-stack`: real local frontend/backend exchange and persisted state;
- `rendered-ui`: visible interaction, transition, and readback in the running application;
- `unavailable-external-effect`: correct local configuration, queue, fixture, or unavailable behavior
  with an explicit statement that no live effect was proved;
- `later-hardware`: physical or live-service observation requiring separate operator validation.

### Allowed statuses

- `open`: not yet executed or awaiting evidence;
- `passed`: the approved observable result was directly observed at the required evidence level;
- `failed`: a required result did not occur and a Seam Finding is linked;
- `external-validation-pending`: only the explicitly excluded external or hardware effect remains unproved.

A required software row cannot pass acceptance as `failed` or `external-validation-pending`.

## Seam Finding Record

Each concrete failure uses this form:

```markdown
### <finding-id>: <observable symptom>

- Journey scenarios: `<US/scenario references>`
- Governing contract: `<existing contract or FR identifier>`
- Minimal reproduction: `<actions and starting state>`
- Owner: `<existing module or shell boundary>`
- Focused RED: `<command and observed failure>`
- Repair revision: `<commit or not-yet-repaired>`
- Focused GREEN: `<same proof and observed pass or not-yet-repaired>`
- Result: `<open|repaired|rejected>`
- Limitations: `<what the proof does not establish>`
```

Rules:

1. Do not open a finding from speculation or code inspection alone.
2. Do not assign `cross-domain` as the owner; trace the failed contract to an existing owner.
3. A repaired finding requires the same focused proof to show RED before and GREEN after the repair.
4. A rejected finding cites the intentional contract or explicit scope exclusion.
5. A finding involving external or hardware behavior does not authorize Slice 024 implementation.

## Comparison Record

Every visible surface requires a live current-Marplanner comparison. Open current Marplanner and v2
at the same route, household date, member, and state, then present both URLs for human review. The
URLs, credentials, and screenshots are not committed. Use:

```markdown
### <comparison-id>: <journey reference>

- v2 observation: `<observed behavior>`
- Current-Marplanner observation: `<observed behavior>`
- Classification: `<same|intentional-change|regression|external-validation-pending>`
- Approved-spec basis: `<requirement or decision id|not applicable>`
- Rationale: `<observable structural comparison and contract basis>`
- Follow-up: `<finding id|Slice 024|none>`
- Human gate: `<accepted|changes-requested>`
```

Approved specifications take precedence. `intentional-change` is valid only when the record cites
the approved requirement or decision that requires the difference. Otherwise current Marplanner is
the structural reference for composition, hierarchy, grouping, primary controls, navigation, and
user-visible states. An unapproved difference is a `regression`; its journey remains open until the
owning component is repaired within the task boundary and the human gate is `accepted`.

`not compared` is allowed only for a non-visible scenario where comparison is not applicable. A
visible surface that cannot be opened in current Marplanner remains open. Pixel-perfect reproduction
is not required, and the gate requires no committed screenshot: the human reviews the two live URLs
and the evidence record stores only the decision and concise rationale.

## Aggregate Closure

The final accepted revision appends:

```markdown
## Integrated-Tip Validation

- Revision: `<full-commit>`
- Command: `npm run check:full`
- Runtime: `Node 24.21.0`
- Result: `<exit status and concise observed summary>`
- Required software rows remaining open/failed/deferred: `0`
- Visible human gates remaining unaccepted: `0`
- External/hardware deferrals: `<explicit Slice 024 rows>`
```

An aggregate result from an earlier revision, a focused suite, or an unobserved command does not
satisfy closure.
