# Step 02 — functional journey matrix

Candidate: `525a954` (+ naming dirty tree).  
Evidence logs: `evidence/02-vitest.log` (170 passed), `evidence/02-playwright.log` (2 passed), `evidence/02-ui/*.png`.

| ID | Journey | Preconditions | Entry | Expected | Actual | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| J1 | Health unauthenticated | fresh app | `GET /health` | 200 ok, no credential | pass | fail-closed + access-gate tests; vitest log | PASS |
| J2 | Access gate closed | no `mp_gate` | `GET /` | HTML form, not shell, not 401 | pass | access-gate; screenshot `01-access-gate-*` | PASS |
| J3 | Gate unlock | valid `mpg-` token | `POST /gate` | 303 + Secure HttpOnly Lax cookie | pass | access-gate success case | PASS |
| J4 | Gate fail-closed | unset / non-mpg token | POST/GET gate paths | unpassable form | pass | access-gate fail-closed cases | PASS |
| J5 | Gate ≠ API auth | valid gate, no device key | `GET /api/settings` | 401 | pass | access-gate | PASS |
| J6 | Provision happy | bootstrap env + DB row | `POST /api/auth/provision` Bearer `*` | 200 `{provisioned:true}`, `mp_device_key`+marker, no raw key | pass | provision + integration tests; UI `02-provision-*` | PASS |
| J7 | Provision negatives | missing/invalid/no bootstrap row | provision | 401, no cookie leak | pass | provision.test.ts | PASS |
| J8 | API missing/malformed/unknown key | various cookies | `/api/*` | 401 fail-closed | pass | fail-closed, encoding-bypass | PASS |
| J9 | Wrong-scope / management | device `*` on management routes | network-devices (shared) + auth-boundary | 403 scope/management as designed | pass | auth-boundary + server inspection F2/F3 notes | PASS |
| J10 | Revoked/expired key | live then mutate row | next API call | 401/403 refuse | pass | key-lifecycle | PASS |
| J11 | PIN ≠ API authz | PIN header/body without key | API | reject; verify-pin needs key | pass | auth-boundary PIN case; verify-pin; no-session | PASS |
| J12 | verify-pin match/no-match | device cookie + admin_config | `POST /api/auth/verify-pin` | `{match}` only; no session | pass | verify-pin, no-session | PASS |
| J13 | No sessions | any verify-pin traffic | schema + headers | no sessions table; no session headers | pass | no-session | PASS |
| J14 | Failure-only throttle | repeated bad creds | API/bootstrap | 429 Retry-After; valid traffic survives | pass | auth-throttling | PASS |
| J15 | Bootstrap reconcile | env on/off, revoked, expired | boot reconcile | idempotent seed / re-establish | pass | bootstrap-reconcile (exact-now drift = F1 open) | PASS w/ F1 |
| J16 | Admin unlock UI | provisioned device | `/admin` PIN keypad | unlock → admin chrome; Lock + idle relock | pass | client admin-gate tests; screenshots `03`/`04`; leave-admin ADR claim = C1 open | PASS w/ C1 |
| J17 | Unlock resilience e2e | provisioned | long-press + PIN + destinations | hold survives layout shift; destinations after refresh | pass | playwright 2/2 | PASS |
| J18 | Credential loss client | 401 credential_invalid vs scope 403 | authFetch | clear marker only on credential loss | pass | credential.test.ts | PASS |
| J19 | Cookie transport posture | localhost HTTP | gate/provision Set-Cookie | Secure accepted on localhost; Path mount-aware | pass | cookies factory + provision BASE_PATH case; ADR-060 | PASS (localhost only) |
| J20 | SECURITY reporting | n/a | SECURITY.md | private channel present | **missing destination** | SECURITY.md:5 | OPEN D1 |
| J21 | Planned key-mgmt / set-pin / revoke API | n/a | routes | absent by design | confirmed absent | contract + server inspection | OPEN gap (accepted planned) |
| J22 | Leave-admin immediate re-lock | unlocked admin | navigate out of `/admin` | unlock cleared (ADR-013) | **not implemented / untested** | C1/T2 | OPEN |

## UI screenshots

| File | Viewport | Surface |
| --- | --- | --- |
| `evidence/02-ui/01-access-gate-1280x800.png` | desktop | access gate form |
| `evidence/02-ui/01-access-gate-1024x768.png` | touch-ish | access gate form |
| `evidence/02-ui/02-provision-1280x800.png` | desktop | provision device |
| `evidence/02-ui/02-provision-1024x768.png` | touch-ish | provision device |
| `evidence/02-ui/03-admin-pin-1280x800.png` | desktop | PIN keypad |
| `evidence/02-ui/03-admin-pin-1024x768.png` | touch-ish | PIN keypad |
| `evidence/02-ui/04-admin-unlocked-1280x800.png` | desktop | unlocked admin |
| `evidence/02-ui/04-admin-unlocked-1024x768.png` | touch-ish | unlocked admin |

Visual polish beyond smoke screenshots (spacing audit, es locale pre-unlock, true phone viewport) not exhaustively certified — screenshots + density tests on keypad are the evidence boundary for this pass.

## Commands

```
npm exec -- vitest run <owned 21 files>   # 170 passed, ~19s → evidence/02-vitest.log
npm exec -- playwright test tests/e2e/admin-unlock-resilience.spec.ts  # 2 passed → evidence/02-playwright.log
# throwaway screenshot spec run then deleted → evidence/02-ui-screenshots.log + pngs
```
