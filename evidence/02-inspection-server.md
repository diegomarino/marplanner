# Step 02 — Server access/credentials inspection

Inspection only. No product code edits. Worktree: `review-access-credentials`.

Sources: owned server auth/route files (complete), `src/server/app.ts` / `src/server/index.ts` wiring, `docs/architecture/contracts/auth-sessions.md`, `docs/features/auth-sessions.md`, boundary tests under `tests/boundary/`.

---

## 1. Per-file inspection ledger

| File | One-liner |
|------|-----------|
| `src/server/auth/boundary.ts` | App-wide `/api/*` onRequest: cookie (all API) or bearer (only `/api/plugins*`); live DB row required; fail-closed 401/403 + failure-only API backoff; skips only `POST /api/auth/provision`. |
| `src/server/auth/capability.ts` | Second-layer preHandlers: `requireCapability`, `requireFullAccess` (kind×transport matrix), `requireManagementKey` (deny `kind=device`); registration helper throws if capability missing. |
| `src/server/auth/cookies.ts` | Single factory: `mp_device_key` / `mp_gate` → `HttpOnly; Secure; SameSite=Lax; Path={basePath}/`; rejects `__Host-` by ADR-060. |
| `src/server/auth/credentials.ts` | `mpk-` diceware (EFF pool minus separator words), SHA-256 hex hash, `timingSafeEqual` verify. |
| `src/server/auth/eff-wordlist.ts` | Vendored EFF large list (7776 words); no runtime auth logic. |
| `src/server/auth/gate.ts` | Frontend access gate: `mpg-` env token, cookie = SHA-256(token); exempts `/api/*`, `/health`, `/gate`; misconfig fail-closed. |
| `src/server/auth/pin.ts` | Argon2 verify; malformed hash → false (no throw). |
| `src/server/auth/provision.ts` | Bootstrap Bearer → mint `kind=device` `scope=*` cookie key (raw never in body); always upserts `admin_config` PIN from `ADMIN_PIN`/`0000`; bootstrap failure backoff. |
| `src/server/auth/reconcile.ts` | Boot seed: `MP_BOOTSTRAP_KEY` → `kind=bootstrap` (reactivates inactive); `MP_MANAGEMENT_KEY` → `kind=integration` (never reactivates); both require `mpk-` or throw. |
| `src/server/auth/throttle.ts` | Process-local failure-only backoff (api 20/1m, bootstrap 5/10m); success never touches buckets; IPv4-mapped/IPv6 normalize; 429 + `Retry-After` + `no-store`. |
| `src/server/routes/provision.ts` | Thin wrapper → `provisionDevice`. |
| `src/server/routes/verify-pin.ts` | Key-gated `POST /api/auth/verify-pin` → `{ match }`; no session, no writes, no authority. |

---

## 2. Auth order / public surface map

### Boot (`src/server/index.ts`)

1. Data dir + storage ownership + migrations  
2. **`reconcileBootstrap()`** then **`reconcileManagement()`** (before listen)  
3. `buildApp()` → listen → scheduler  

### `buildApp` registration order (`src/server/app.ts`)

1. Base-path 404 / bare-base redirect  
2. `GET /health` (root, unauthenticated)  
3. Quiesce/in-flight hooks (API only; restore exempt)  
4. **`authBoundary(app, basePath)`** — API credential boundary  
5. **`accessGate(app, basePath)`** — page gate + `POST {basePath}/gate`  
6. Prefixed plugin (`{ prefix: basePath }`):  
   - `provisionRoutes` → `POST /api/auth/provision`  
   - domain routes (`settings`, `verify-pin`, members, …)  
   - plugin HTTP + `pluginRoutes` (`requireFullAccess`)  
   - optional SPA static + not-found shell (re-checks gate cookie)

### Public / credential surface

| Surface | Auth | Notes |
|---------|------|--------|
| `GET /health` | None | Sole liveness surface; gate + boundary skip |
| `POST {base}/gate` | Shared `MP_ACCESS_TOKEN` (`mpg-`) | Sets `mp_gate` (hash); not API auth |
| Frontend HTML routes | Gate cookie | Missing/invalid → HTML form (200), not 401 |
| `POST /api/auth/provision` | Raw bootstrap Bearer; boundary skipped | Validates env + active DB bootstrap row; sets `mp_device_key` + `mp_provisioned` |
| All other `/api/*` | Device cookie **or** (plugins only) Bearer | Live `api_keys` row; then optional capability preHandlers |
| `POST /api/auth/verify-pin` | API key (cookie) | Match only; PIN ≠ backend auth |

### Kind × transport matrix (shipped)

| Kind | Cookie on general `/api/*` | Bearer on `/api/plugins*` | `requireFullAccess` | `requireManagementKey` |
|------|----------------------------|---------------------------|---------------------|-------------------------|
| `device` | Yes (intended) | No (boundary ignores bearer off plugins; on plugins denied by full-access) | Cookie only | **Denied** |
| `integration` | Yes at boundary (e.g. settings/network-devices cookie) | Yes on plugins | Bearer only | Allowed (not device) |
| `bootstrap` | Yes at boundary (settings etc.) | N/A typical | **Denied** (cookie) | Allowed (deny-list is device-only) |

---

## 3. Findings

### F1 — Exact-instant expiry predicate drift (reconcile vs boundary/provision)

- **Severity:** Low (edge)  
- **Path:line:**  
  - `src/server/auth/boundary.ts:124` — inactive when `expiresAt <= now`  
  - `src/server/auth/provision.ts:81` — same `<= now`  
  - `src/server/auth/reconcile.ts:43-45` / `:111` — treats `expires_at >= now` as **active**  
  - Comment at `reconcile.ts:43-44` incorrectly claims boundary rejects only `expires_at < now`  
- **Impact:** At `expires_at === now`, boundary/provision treat the key as expired; bootstrap/management reconcile treat it as still active and **will not** re-establish bootstrap. Contract backoff section: “Expiry at the current instant is inactive.”  
- **Reproduction idea:** Seed bootstrap row with `expires_at = frozenNow`, call `reconcileBootstrap()` (no UPDATE), then `POST /api/auth/provision` with that key → 401 expired; restart reconcile still no-ops.  
- **Disposition:** Record; align reconcile `isActive` to `expires_at === null || expires_at > now` (and fix comment) in a follow-up. Not patched here (non-critical, ms-wide).

### F2 — Management/integration “header credential” not admitted on non-plugin API paths

- **Severity:** Low (design/ship gap)  
- **Path:line:** `src/server/auth/boundary.ts:69-74` — bearer only when `pathname` is `/api/plugins` or under it  
- **Impact:** Vocabulary/contract call integration keys header credentials; network-devices management surface is reached in practice by putting `MP_MANAGEMENT_KEY` in the **device cookie** (see e2e/tests). Bearer management key on `/api/network-devices/*` → 401 missing cookie. Plugins correctly allow integration bearer via `requireFullAccess`.  
- **Reproduction idea:** Seed integration key; `Authorization: Bearer …` on `/api/network-devices/...` vs cookie on same path.  
- **Disposition:** Documented tension / product follow-up; not a bypass. Either extend bearer allow-list for management routes or document cookie-as-management-transport as intentional.

### F3 — `requireManagementKey` is a device deny-list (bootstrap passes)

- **Severity:** Info (documented)  
- **Path:line:** `src/server/auth/capability.ts:126-161`  
- **Impact:** A bootstrap `*` presented as `mp_device_key` satisfies management routes (with `requireCapability`), same as integration. Deliberate per module comments / ADR-053 carve-out framing; operators should treat bootstrap like a break-glass management secret if left in a browser cookie.  
- **Reproduction idea:** Cookie = bootstrap raw key → network-devices admin route with both preHandlers.  
- **Disposition:** Accept as designed; ops hygiene only.

### F4 — Every successful provision rewrites the household PIN hash

- **Severity:** Info (documented behavior, operational footgun)  
- **Path:line:** `src/server/auth/provision.ts:97-103` — `ON CONFLICT DO UPDATE` pin_hash from `ADMIN_PIN ?? "0000"`  
- **Impact:** Provisioning a second device resets PIN to env/default, undoing any out-of-band DB PIN change until next provision. Contract describes this as initialize/replace from configuration; no `set-pin` route exists.  
- **Reproduction idea:** Change `admin_config.pin_hash`, provision again with bootstrap → verify-pin matches `ADMIN_PIN`/`0000` only.  
- **Disposition:** Planned gap (`set-pin`); no defect vs current contract text.

### F5 — Access-gate POST has no failure backoff

- **Severity:** Info  
- **Path:line:** `src/server/auth/gate.ts:232-241`  
- **Impact:** Wrong-token gate posts re-serve the form with no 429/throttle. Token is deployment-grade (`mpg-`); API/bootstrap flows are throttled separately. Brute-force is online against a single shared secret without ADR-037 backoff.  
- **Reproduction idea:** Rapid `POST /gate` with wrong body → always 200 form, never 429.  
- **Disposition:** Optional hardening; outside current API throttle design.

### Cookie flags (check result — no defect)

- Device + gate: `HttpOnly; Secure; SameSite=Lax; Path={base}/` via `serializeAuthCookie` (`cookies.ts:21-22`).  
- `mp_provisioned`: `Secure; SameSite=Lax; Path=…` **not** HttpOnly (intentional presence marker).  
- No `Max-Age`/`Expires` (session cookies); DB device keys remain until revoked (no revoke API yet).

### PIN does not grant API auth (check result — OK)

- Boundary never reads PIN (`boundary.ts`).  
- Capability module documents PIN never consulted (`capability.ts:19-20,67`).  
- `verify-pin` returns `{ match }` only (`routes/verify-pin.ts:27-28`).  
- Covered by `auth-boundary.test.ts` (“does not accept an Admin PIN…”) and no-session/verify-pin tests.

### Fail-closed paths (check result — OK)

- Missing env bootstrap/management → no seed; deployment/feature locked.  
- Non-`mpk-` bootstrap/management at reconcile → **throw** (refuse boot seed).  
- Non-`mpg-` or unset access token → gate unpassable (`gate.ts:183-186,204-206`).  
- No env bypass of `authBoundary`.  
- Unauthenticated API (except provision) → 401.

### Throttle failure-only (check result — OK)

- `failure()` only from reject paths in boundary/provision.  
- Success path does not call backoff; valid traffic proceeds during others’ cooldown (`throttle.ts`; tests assert valid cookie survives).  
- Excludes unknown routes, transport conflicts, scope denials, missing bootstrap config / unreconciled row (provision).

### Critical security defects

**None found that warranted an in-pass product patch.** F1 is the only correctness drift in auth predicates; remaining items are design gaps or documented behavior.

---

## 4. Gaps: planned-not-implemented vs code

From `docs/architecture/contracts/auth-sessions.md` / feature status:

| Planned (contract) | Shipped code |
|--------------------|--------------|
| Key create / list / revoke HTTP APIs | **Absent** — only provision mint + env reconcile |
| Last-key anti-lockout (INV-07 / AC-05) | **Absent** — no revoke mutation path |
| `set-pin` / in-kiosk PIN reset | **Absent** — PIN only via provision + `ADMIN_PIN` |
| Server-side cookie / key revocation endpoint | **Absent** — revoke column enforced if set out-of-band |
| Bootstrap retirement endpoint | **Absent** — remove env stops *new* reconcile seed; row remains |
| Integration key issued once via API | **Absent** — only `MP_MANAGEMENT_KEY` reconcile |
| INV-05 universal “undeclared capability → reject” | **Partial** — `registerRoutesWithCapabilities` / domain helpers enforce where used; most household routes (`settings`, `members`, `calendar`, …) rely on **boundary-only** live `*` key with **no** per-route `requireCapability` |
| INV-06 key-mgmt raw-header-only | **N/A until key-mgmt ships** |
| Integration as header-only transport | **Partial** — bearer limited to `/api/plugins*`; management often cookie (F2) |

Shipped and aligned with contract “implemented” list: provision, authorize (boundary + selective capability), verify-pin, access gate, failure-only backoff, bootstrap + management reconcile, PIN init on provision.

---

## 5. What existing boundary tests prove vs holes

### Already proven (high confidence)

| Area | Tests |
|------|--------|
| Fail-closed no cookie on API; health open | `boot.test.ts`, `access-gate`, calendar assembly auth probes, backups envelope, etc. |
| Provision mint, cookie flags/path, no raw key in body, invalid/missing bootstrap | `provision.test.ts`, integration provision-then-settings |
| Bootstrap reconcile idempotent, mpk- reject, revoke/expire re-establish | `bootstrap-reconcile.test.ts` |
| Management reconcile no-op unset, idempotent, **no** revoke resurrection + boundary 403 | `network-devices-auth.test.ts` |
| `requireManagementKey` rejects real provisioned device `*`; composes with capability | `network-devices-auth.test.ts` |
| Full-access kind×transport; dual cred conflict; PIN header useless; bearer not widened to settings | `auth-boundary.test.ts` |
| Gate form vs shell; wrong/unset/non-mpg token; gate ≠ API auth | `access-gate.test.ts` |
| verify-pin match/false; no session table | `verify-pin.test.ts`, `no-session.test.ts` |
| Failure-only backoff thresholds, cooldown double/cap, exclusions, IP normalize, bootstrap bucket isolation | `auth-throttling.test.ts` |
| Telemetry capability registration fail-closed | `telemetry-capability.test.ts` |

### Holes / weak coverage

1. **Exact `expires_at === now`** across boundary + **reconcile** together (F1) — throttle tests cover exact expiry on API/bootstrap *auth* paths, not reconcile active predicate.  
2. **Bearer management key on network-devices** (expected fail today) — no explicit boundary test locking the allow-list policy.  
3. **Universal capability declaration** — no app-wide audit test that every `/api/*` route registers a capability (INV-05 aspirational).  
4. **Gate brute-force / backoff** — untested by design (no feature).  
5. **Multi-device provision PIN overwrite** — behavior unasserted.  
6. **Cookie attribute unit assertions** beyond provision/gate happy paths (e.g. gate Set-Cookie must include HttpOnly/Secure/SameSite together) — partially in access-gate success test; worth confirming if not fully pinned.  
7. **`verify-pin` non-string `pin` body** — type coercion / 400 vs `{match:false}` unspecified.  
8. **Key-management / anti-lockout / set-pin** — correctly absent (planned).

---

## Wiring summary (quick reference)

```
main: migrate → reconcileBootstrap → reconcileManagement → buildApp → listen
buildApp: health → quiesce hooks → authBoundary → accessGate → prefix(routes)
boundary: /api/* except POST provision; cookie | plugins-bearer; DB active row
gate: pages only; /api + /health + /gate exempt
capability: opt-in per route (plugins full-access; network-devices management+capability; telemetry batch helper)
```
