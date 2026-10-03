# Step 02 — findings pack

Candidate base: `525a95458a9b8cbaab187717a4a66fd3f9002ea6`  
Branch: `review/access-credentials`

## Product model (recorded)

Family household kiosk: **access to a feature means full use of that feature**. Device keys are scope `*` (ADR-058). Not a multi-tenant least-privilege product.

## Product dispositions

| Topic | Decision |
| --- | --- |
| **`set-pin`** | **Not planned.** `ADMIN_PIN` + restart + re-provision. |
| **F2 Bearer** | **Intentional.** Bearer only `/api/plugins*`; general API = cookie. Documented contract/ops/feature. |
| **Key CRUD / anti-lockout / server revoke** | **Out of scope this household release.** Ops recovery only; clearing cookies ≠ DB revoke. |
| **INV-05** | **Household calibration.** Capability helpers where registered; device `*` = full feature access; app-wide route audit deferred quality work. |

## Findings status

| ID | Disposition |
| --- | --- |
| **D1** SECURITY reporting | **Closed** — GH private vulnerability reporting; ack 7d / status 90d; enable on published repo |
| **D3** ADR-013 drift | **Closed** |
| **D4** ADR-060 `__Host-` AC | **Closed** |
| **F1** exact-instant expiry | **Closed** + test |
| **F2** Bearer transport | **Accepted** (documented) |
| **F3** management deny device | **Accepted** |
| **F4** provision rewrites PIN | **Accepted** |
| **F5** gate no backoff | **Accepted** |
| **planned** key-mgmt API | **Accepted out of scope** |
| **INV-05** capability-per-route | **Accepted household calibration** |
| **T1** RED comments | **Closed** |
| **C1** leave-admin | **Closed** |
| **C2** dev PIN bypass | **Accepted** |
| **C3** pre-unlock English | **Accepted** (ADR-061) |

## Critical security defects

**None.** PIN ≠ API authz; fail-closed; cookies Secure/HttpOnly/SameSite=Lax; no raw device key in bodies.

## Verification

| Check | Result |
| --- | --- |
| Owned vitest (21 files) | 170/170 pass |
| Bootstrap-reconcile after F1 | 8/8 pass |
| Playwright admin-unlock-resilience | 2/2 pass |
| UI screenshots | 8 pngs in `evidence/02-ui/` |
| Naming residual owned | clean |

## Verdict

**Pass with accepted dispositions.** Operator follow-up: enable GitHub Private vulnerability reporting on the published repository.
