# Step 02 — docs / SECURITY / OpenAPI inspection

Candidate: `525a954` (+ naming cleanup on owned ADRs/feature). Inspection only.

## File ledger

| File | Result |
| --- | --- |
| `SECURITY.md` | Trust boundaries correct (gate vs bootstrap vs management vs PIN advisory). **Private vulnerability reporting destination unresolved** — publication gate. |
| `docs/api/bootstrap/openapi.yaml` | Product API `version: 1.0.0` retained (real contract version, not planning label). Documents device cookie, provision without raw key, verify-pin, backoff 429 shape, credential_invalid/scope_denied codes. |
| `docs/architecture/contracts/auth-sessions.md` | Clear delivered vs planned. INV-06/07 and AC-05 planned. Behaviors match intended model: fail-closed, PIN UI-only, no sessions, backoff policy detailed. |
| `docs/features/auth-sessions.md` | Implementation status section honest. FR-006/007/017 planned. Assumptions post-naming: “Fresh data store”. |
| `ADR-007`…`037` (owned) | Naming cleaned. Decisions coherent with contract. |
| `ADR-058` | Single household trust tier; key-management as sole catastrophic boundary; device-block carve-out named. No obsolete planning tokens. |
| `ADR-060` | TLS required non-localhost; unconditional Secure; `__Host-` reversed; cookie factory; mount-scoped Path amendment 2026-10-03. Acceptance still mentions superseded `__Host-` follow-up in places — historical residue inside superseded decision text. |

## Naming dispositions (this step)

| Match class | Disposition |
| --- | --- |
| Former `v2` / `Fresh v2` / `Pre-v2` in owned ADRs/feature | **Replaced** with product/deploy language / `Related prior` |
| OpenAPI `version: 1.0.0` | **Retained** — API document version |
| ADR-060 historical `__Host-` / issue #100 narrative | **Retained** — decision history + correction |
| UniFi/other-step `v1` API paths | **Out of scope** (not owned) |

## Findings

### D1 — SECURITY.md private reporting unresolved

- **Path:** `SECURITY.md:5`
- **Impact:** blocks publication acceptance (PLAN final acceptance item).
- **Disposition:** open; maintainer must supply private channel + response deadline. Not inventable by review agent.

### D2 — Planned interfaces correctly labeled but operationally sharp edges

Contract/feature state clearly:

- No key create/list/revoke routes
- No last-key anti-lockout enforcement via API
- No `set-pin` route; PIN reset = change `ADMIN_PIN` + re-provision
- No server-side cookie revocation endpoint; clearing browser cookie leaves DB key live
- Env value change does not revoke persisted keys (`SECURITY.md:13`, contract)

**Impact:** operator can accumulate orphan device keys; stolen browser profile + live DB key remains valid until manual DB/ops action.
**Disposition:** accepted product gap for this phase if operations.md documents recovery; still a **review finding** for publication honesty. Verify operations.md cross-link (shared context) during journeys/close.

### D3 — ADR-013 vs implementation drift (docs side)

ADR-013 still claims:

1. `set-pin` endpoint exists (rules §2) — **not implemented** (contract correctly says planned/absent).
2. bcrypt PIN hash — implementation uses Argon2 (provision/verify path); feature text says Argon2.
3. Leave-admin immediate re-lock — client implements idle only (see C1).

**Disposition:** ADR prose drift; prefer contract+feature as shipped truth. Repair = ADR-013 amend in a docs fix batch (in-scope naming already done; this is accuracy repair).

### D4 — ADR-060 acceptance still references `__Host-` follow-up as if pending

- Lines 115–118 acceptance criteria still describe `__Host-` landing.
- Correction says do NOT adopt `__Host-`; factory without prefix is the live design (Path mount amendment supersedes root-only story partially).

**Disposition:** docs accuracy finding; update AC to match Correction + Path amendment.

### D5 — OpenAPI scope is bootstrap slice of API

Bootstrap openapi covers health/gate/provision/verify-pin/settings foundation. Full surface capability matrix lives elsewhere. Not a defect; journeys must not assume this file enumerates every authz path.

## Consistency notes (non-findings)

- Contract INV-08 + ADR-058 + SECURITY PIN advisory align.
- Fail-closed story consistent across SECURITY, ADR-033, contract, feature.
- Cookie attribute story: factory + Secure + HttpOnly + SameSite=Lax + basePath Path — openapi description matches intent.
