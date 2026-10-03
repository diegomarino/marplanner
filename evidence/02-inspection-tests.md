# Step 02 — owned tests harness inspection

Candidate: `525a954` (+ naming title cleanup). Inspection after rename smoke (170/170 green).

## Coverage map (owned suites)

| Area | Files | Proves |
| --- | --- | --- |
| Access gate | `access-gate.test.ts` | form-not-shell, wrong token, fail-closed unset/non-mpg, cookie set, gate≠API auth, health |
| API boundary | `auth-boundary.test.ts`, `fail-closed.test.ts`, `encoding-bypass.test.ts` | device/integration auth shapes, PIN not authz, conflict fail-closed, encoded `/api` bypass blocked |
| Throttle | `auth-throttling.test.ts` | failure-only backoff, isolation, bounds, bootstrap bucket |
| Credentials crypto | `credentials.test.ts` | mpk- diceware, hash verify |
| Bootstrap | `bootstrap-reconcile.test.ts`, `bootstrap-provision.test.ts` | seed/idempotent/revoke/expire re-establish |
| Provision | `provision.test.ts`, `provision-then-settings.test.ts` | mint cookie, no raw key, BASE_PATH cookie path, cold settings |
| PIN / sessions | `verify-pin.test.ts`, `no-session.test.ts` | match/no-match, no session table/headers |
| Key lifecycle | `key-lifecycle.test.ts` | revoke/expire next-request refuse |
| Members authz | `member-admin-gate.test.ts` | legacy `/members` absent; device key authorizes; role irrelevant |
| Client gate | `admin-gate*.tsx`, `admin-pin-keypad`, `credential`, `provisioning-gate` | unlock, idle lock, lock button, no boot probe, authFetch loss polarity |
| E2E | `admin-unlock-resilience.spec.ts` + helper | unlock resilience across navigation/reload patterns |

## Findings

### T1 — Stale “RED until route” comments

- `no-session.test.ts:144`, `:262` still say assertions are RED until verify-pin route exists.
- Route ships; tests green.
- **Disposition:** comment cleanup (docs/hygiene), non-blocking.

### T2 — Leave-admin immediate re-lock untested (ties C1)

- `admin-gate.test.tsx` covers explicit Lock + 5-minute idle.
- No test that leaving `/admin` without Lock clears unlock (ADR-013 claim).
- **Disposition:** open with C1; add regression if repair lands.

### T3 — `as any` in member-admin-gate DB helpers

- Convenience typing only; does not weaken HTTP assertions.
- **Disposition:** retain / low-priority cleanup.

### T4 — Env mutation patterns

- Most files restore `MP_*` / `BASE_PATH` in finally or after hooks (`access-gate`, `provision`).
- Residual risk if a test throws before restore outside finally — spot-check showed generally careful.
- **Disposition:** no defect found; keep pattern in new tests.

### T5 — Gaps already named by server review

- exact-instant expiry reconcile vs boundary
- management bearer policy on network-devices
- multi-device provision PIN overwrite
- verify-pin non-string body
- app-wide capability declaration audit (beyond owned routes)

These are **missing proofs**, not failing tests.

## Naming

Owned describe/it titles cleaned; `assembly-cohort.json` titles updated atomically. Residual planning labels in owned test sources: **none**.
