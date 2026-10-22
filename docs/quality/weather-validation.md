# Live Weather Acceptance Evidence Contract

## Purpose

This contract defines the versioned, privacy-safe evidence record for . It is a development
artifact, not a runtime API, database schema, telemetry stream, provider monitor, or production
health report.

## Run Authorization Header

Every live run begins with this record before execution:

```markdown
## Live-read authorization <run-id>

- Revision: `<full-commit>`
- Runtime: `<output of node --version>` / npm `<output of npm --version>` (measured on the validating machine; the supported toolchain is `.nvmrc` and `package.json` `engines`)
- Operator role: `<role-only>`
- Approved window: `<start/end rounded to minute>`
- Isolated runtime: `<non-sensitive description>`
- Consumer windows: `Home first; Daily Briefing second; no overlap`
- Browser local effects: `<authorized|denied>`
- Briefing local effects: `<authorized generation/regeneration|inspect-only>`
- Disposal boundary: `<ephemeral browser, observer output, temporary datastore>`
- Prohibited mutations: `source deployment, provider, credentials, location, settings, runtime
configuration, product code, tests, deployment, and external state`
- Decision: `<authorized|denied>`
```

The record contains no personal identity, machine identity, URL, host, path, credential, coordinate,
payload, response identifier, or private operational provenance.

## Claim Matrix

Every approved scenario receives one row:

| Claim  | Requirement/scenario | Consumer     | Provenance        | Observation modes | Human decision    | Observed                  | Limitations         | Status     |
| ------ | -------------------- | ------------ | ----------------- | ----------------- | ----------------- | ------------------------- | ------------------- | ---------- |
| `<id>` | `<refs>`             | `<consumer>` | `<allowed value>` | `<one or more>`   | `<allowed value>` | `<sanitized observation>` | `<not established>` | `<status>` |

Allowed values:

- Provenance: `deterministic-fixture`, `live-provider-observed`, `cache`, `unknown`.
- Observation mode: `automated-assertion`, `api-readback`, `rendered-ui`,
  `provider-egress-observation`.
- Human decision: `accepted`, `changes-requested`, `no-claim`.
- Status: `open`, `passed`, `failed`, `no-claim`.

No dimension substitutes for another. A rendered result or an `accepted` visual gate does not prove
provider provenance.

## Consumer Correlation Record

Use one record for Home and one for Daily Briefing:

```markdown
### <consumer> correlation

- Window: `<bounded minute range>`
- Cache precondition: `<miss-demonstrated|existing-cache|unknown>`
- Cache proof retained: `<zero-or-nonzero-only>`
- Matching egress observations: `<0|1|more-than-1>`
- Egress outcome: `<success|failure|not-observed>`
- Sanitized status class: `<2xx|3xx|4xx|5xx|none>`
- Elapsed milliseconds: `<integer|not-observed>`
- API/readback result: `<sanitized normalized result|absence|not-observed>`
- Rendered result: `<sanitized surface result|not-observed>`
- Household date relation: `<same-date|date-absent-skip|not-applicable|unknown>`
- Freshness surface: `<exact visible wording|none-visible|not-observed>`
- Provenance result: `<allowed provenance>`
- Live-causation decision: `<accepted|no-claim>`
- Missing element or limitation: `<explicit>`
```

`live-provider-observed` is valid only when cache miss, exactly one matching egress observation, and
the consumer's required readback/render chain all correlate. Otherwise use `cache` or `unknown` and
`no-claim`.

## Egress Extract

The committed extract may contain only:

```json
{
  "kind": "weather-provider-egress",
  "ordinal": 1,
  "outcome": "success",
  "statusClass": "2xx",
  "failureClass": "none",
  "elapsedMs": 123
}
```

The values above illustrate the schema, not an observation. Forbidden fields include request input,
URL, host, path, query values, headers, body, response payload, response identifier, coordinates,
and process or machine identity.

## Deterministic Evidence Record

```markdown
## Deterministic evidence

- Revision: `<full-commit>`
- Runtime: `<output of node --version>` / npm `<output of npm --version>` (measured on the validating machine; the supported toolchain is `.nvmrc` and `package.json` `engines`)
- Commands: `<exact focused commands>`
- Result: `<observed exit statuses and concise totals>`
- Provenance: `deterministic-fixture`
- Covered behavior: `<failure/telemetry/cache/date/snapshot/non-blocking summary>`
- Limitations: `No live provider result, availability, freshness, or outage was proved.`
```

## Natural Outage Record

- If no natural provider failure occurs, record `Live outage: unobserved` and cite deterministic
  failure/telemetry evidence for degradation behavior.
- Never change endpoint, provider, network, credentials, location, settings, or runtime
  configuration to induce failure.
- A natural failure becomes live-outage evidence only with one correlated egress failure, sanitized
  Client Logging reason/status, and a non-blocking surface result.

## Finding Record

```markdown
### <finding-id>: <observable symptom>

- Requirement/scenario: `<references>`
- Governing authority: `<contract/ADR/FR>`
- Minimal safe reproduction: `<bounded privacy-safe steps>`
- Affected surface: `<existing owner>`
- Provenance: `<allowed value>`
- Observation modes: `<allowed values>`
- What is not established: `<explicit limitation>`
- Disposition: `separate-scope-required`
```

A finding does not authorize a source, test, provider, configuration, or workaround change.

## Human Visual Gate

```markdown
## Visual acceptance

- Revision: `<full-commit>`
- Home/Weather state reviewed: `<sanitized state>`
- Daily Briefing state reviewed: `<sanitized state>`
- Visible freshness wording: `<exact wording|none-visible>`
- Degraded presentation reviewed: `<deterministic|natural-live|not-observed>`
- Decision: `<accepted|changes-requested|no-claim>`
- Rationale: `<concise presentation-only rationale>`
```

No screenshot or URL is committed. This gate decides presentation only.

## Closure Record

```markdown
## Final integrated closure

- Revision: `<full-commit>`
- Deterministic evidence: `<complete|incomplete>`
- Home live causation: `<accepted|no-claim>`
- Daily Briefing live causation: `<accepted|no-claim>`
- Live outage: `<observed|unobserved>`
- Privacy audit: `<passed|failed>`
- Visual gate: `<accepted|changes-requested|no-claim>`
- Defect finding: `<none|finding-id>`
- Issue #719: `deferred` unless separately scoped
- Disposal: `<complete|incomplete>`
- Outcome: `<acceptance-only|separate-repair-required|incomplete-no-claim>`
```

Acceptance-only closure permits consumer-specific `no-claim` where the record names the missing
precondition or observation; it never permits an unsupported live-provider claim.

## Privacy Audit

The final record must contain zero credentials, keys, tokens, precise location labels, coordinates,
raw provider payloads, request or local URLs, private endpoint hosts, IP or MAC addresses, private
paths, machine/process identifiers, response identifiers, screenshots, or private provenance.
