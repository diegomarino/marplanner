# Step 02 — client inspection

Candidate: `525a954` (+ naming-only dirty tree). Inspection only.

## File ledger

| File | Result |
| --- | --- |
| `src/client/admin/AdminGate.tsx` | PIN keypad 4–6 digits; `authFetch` verify-pin; match → `setUnlocked(true)`; idle re-lock 5 min on panel-scoped capture listeners; bypass skips idle; English pre-unlock literals (ADR-061); cancel returns via history or household `/`. No leave-admin auto-lock on route exit beyond idle/manual Lock. |
| `src/client/lib/adminUnlock.tsx` | Ephemeral React context only. `isAdminPinBypassEnabled`: MODE≠test, not E2E hooks, `VITE_DEV_BYPASS_ADMIN_PIN=1`, localhost/127.0.0.1/::1 only. Default context no-op setUnlocked. |
| `src/client/lib/credential.ts` | `authFetch` remaps `/api/` via `appUrl`; 401/403 → `isCredentialLoss` (only `AUTH_CREDENTIAL_INVALID_CODE` or unparseable body); generation guard before report; clears `mp_provisioned` marker + event. Does not touch HttpOnly device cookie (browser-only clear of marker). |

## Behavior map

1. Unlock path: AdminGate → POST `/api/auth/verify-pin` with device cookie via `authFetch` → `{match}` only → client `unlocked`.
2. PIN never becomes a server session or extra cookie.
3. Credential loss: marker clear + `mp:credential-lost`; Shell (shared owner) must listen — not verified in this file set beyond client emit.
4. Dev bypass is host-restricted and env-gated; still client-only (no API auth change).

## Findings

### C1 — ADR-013 leave-admin re-lock not implemented

- **Claim:** ADR-013 rule 5: navigating out of the admin route subtree re-locks immediately.
- **Code:** `AdminGate.tsx` implements inactivity (5 min) + refresh (ephemeral state) + manual Lock via `AdminContent onLock`. No effect on admin-route exit / Shell navigation that clears unlock when leaving `/admin`.
- **Impact:** Parent leaves admin to family surface without idle timeout → admin stays unlocked until idle fires or refresh. Child can re-open admin without PIN if parent did not lock and idle window still open.
- **Severity:** medium (matches ADR threat model as casual child access, not API security).
- **Disposition:** finding; repair is client unlock lifecycle (possibly Shell-owned). Do not treat as API boundary defect.
- **Proof needed:** UI journey navigate admin→home without idle wait; observe whether PIN gate returns.

### C2 — PIN bypass is intentional local DX, not production path

- **Path:** `adminUnlock.tsx:17-23`
- **Disposition:** retain with note; verify production builds never set `VITE_DEV_BYPASS_ADMIN_PIN=1`. Out of band for this inspection unless build embeds it.

### C3 — Pre-unlock English-only chrome

- **Path:** `AdminGate.tsx:54-61`
- **Disposition:** documented ADR-061 deferral; not a security finding. UI polish/i18n owner may track later.

## Test hooks observed (client-owned)

- `admin-gate*.test.tsx`, `admin-pin-keypad`, `credential.test.ts`, `provisioning-gate` cover unlock, no boot probe, credential-loss polarity, generation races.
- Leave-admin relock (C1) appears untested if absent from those files (confirm in test review).
