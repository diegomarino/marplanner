# Step 02 naming ledger

Candidate: 525a954

## Hits (owned)

- `docs/architecture/decisions/ADR-007-api-key-backend-boundary.md:9:The API key boundary is the sole backend authorization boundary for all settings reads, settings writes, and all other feature operations in v2. The PIN is a UI-layer gate only â its purpose is to prevent casual or accidental access to admin UI screens. PIN state must never be evaluated by the backend as a required condition for any API endpoint.`
- `docs/architecture/decisions/ADR-007-api-key-backend-boundary.md:11:> **Narrowed by `ADR-030` (2026-06-28):** "a valid API key authorizes everything" was true under the original single-key model. v2 now uses multiple scoped keys: a `*` key authorizes everything, but a scoped key authorizes only its granted `domain:verb` capabilities. The boundary is still "the API key" â what changed is that a key's authority is bounded by its scopes. PIN-is-UI-only is unaffected.`
- `docs/architecture/decisions/ADR-007-api-key-backend-boundary.md:39:Fresh v2 setup defines one API key for the household deployment. No PIN rows, no PIN session rows, and no session-token tables are required by the backend API layer. The PIN and any frontend session token it produces are opaque to the backend.`
- `docs/architecture/decisions/ADR-007-api-key-backend-boundary.md:56:- Pre-v2: `ADR-007`, `ADR-013``
- `docs/architecture/decisions/ADR-013-pin-client-side-ui-gate.md:9:The PIN in v2 is a **client-side admin-UI gate**, not a security boundary. Its only purpose is to prevent a child standing at the kiosk from wandering into admin screens (settings, member management). The real security boundary is the API key (`ADR-007`).`
- `docs/architecture/decisions/ADR-013-pin-client-side-ui-gate.md:45:- Fresh v2 setup creates no session rows. There is no `sessions` table.`
- `docs/architecture/decisions/ADR-013-pin-client-side-ui-gate.md:56:- There is no `sessions` table, no `x-session-id` header, and no `/auth/session` or `/auth/logout` server session lifecycle in v2.`
- `docs/architecture/decisions/ADR-013-pin-client-side-ui-gate.md:65:- Pre-v2: `ADR-013`, `ADR-007``
- `docs/architecture/decisions/ADR-030-multi-key-scoped-api-keys.md:9:v2 replaces the single deployment API key with **multiple named API keys**, each with capability scopes and a managed lifecycle. This narrows `ADR-007`: a valid API key no longer implies full access â it authorizes exactly its granted capabilities.`
- `docs/architecture/decisions/ADR-030-multi-key-scoped-api-keys.md:79:- Fresh v2 setup creates one bootstrap `*` key (the deployment secret). The first kiosk connect provisions a device key from it.`
- `docs/architecture/decisions/ADR-030-multi-key-scoped-api-keys.md:101:- Pre-v2: `ADR-007` (narrowed), `ADR-013``
- `docs/architecture/decisions/ADR-031-frontend-access-gate-and-unauthenticated-surface.md:11:v2 keeps the frontend access gate as a **separate deployment-level token**, distinct from the API key model. It gates whether a browser is served the application pages at all. It is a defense-in-depth outer layer.`
- `docs/architecture/decisions/ADR-031-frontend-access-gate-and-unauthenticated-surface.md:28:The legacy system had an inconsistent unauthenticated surface (some settings were readable before credentials in some paths). v2 closes this: the only thing reachable without any credential is health.`
- `docs/architecture/decisions/ADR-031-frontend-access-gate-and-unauthenticated-surface.md:40:- Fresh v2 setup configures a frontend access-gate token alongside the bootstrap `*` API key. These are two distinct deployment secrets.`
- `docs/architecture/decisions/ADR-031-frontend-access-gate-and-unauthenticated-surface.md:58:- Pre-v2: `ADR-007`, `ADR-013`, `ADR-021``
- `docs/architecture/decisions/ADR-032-bootstrap-key-establishment.md:9:The first `*` (full-access) API key on a fresh v2 deployment â the bootstrap key â is established from a **deployment-provided configuration value**, expressed deployment-agnostically. The portable mechanism is an environment variable; v2 must not couple this to any specific hosting platform (Fly, Docker, Kubernetes, bare metal, systemd, `.env`, etc. are all valid).`
- `docs/architecture/decisions/ADR-032-bootstrap-key-establishment.md:53:- Pre-v2: `ADR-007`, `ADR-013``
- `docs/architecture/decisions/ADR-033-fail-closed-no-environment-auth-bypass.md:9:API authorization enforcement in v2 is **fail-closed in every environment**. There is **no code path that disables or relaxes API-key validation based on the runtime environment** (`NODE_ENV`, a "dev mode" flag, the presence/absence of a configured key, or any equivalent).`
- `docs/architecture/decisions/ADR-033-fail-closed-no-environment-auth-bypass.md:47:- Pre-v2: `ADR-007`, `ADR-013``
- `docs/architecture/decisions/ADR-034-admin-entry-long-press-affordance.md:38:- Pre-v2: `ADR-023``
- `docs/architecture/decisions/ADR-036-connection-setup-provisioning-placement.md:40:- Pre-v2: `ADR-013`, `ADR-023``
- `docs/architecture/decisions/ADR-037-credential-format-and-generation.md:72:- Pre-v2: `ADR-007`, `ADR-013``
- `docs/features/auth-sessions.md:115:- Fresh v2 data store; no legacy keys, sessions, or PINs are migrated (ADR-026). Fresh`
- `tests/boundary/bootstrap-reconcile.test.ts:8:describe("bootstrap-reconcile â T020 / ADR-032 (idempotent seed)", () => {`
- `tests/boundary/member-admin-gate.test.ts:7:describe("member-admin-gate (T018 â negative tests for US4)", () => {`
- `tests/boundary/member-admin-gate.test.ts:34:  describe("legacy v1 /members route is absent", () => {`
- `tests/boundary/member-admin-gate.test.ts:35:    it("legacy v1 /members management routes are NOT registered (specs/002-members-referential-root/spec.md FR-012/FR-013)", async () => {`
- `tests/boundary/member-admin-gate.test.ts:39:        // The bare (non-/api) v1 management surface must not exist as a Fastify route.`
- `tests/boundary/no-session.test.ts:20:describe("no-server-session / PIN-agnostic-authz (T026 â FR-014/015/017/018)", () => {`
- `tests/boundary/no-session.test.ts:106:  it("verify-pin creates no session row (FR-014/FR-015/FR-016) â RED until T027", async () => {`
- `tests/boundary/no-session.test.ts:229:  it("verifying an incorrect PIN creates no session row and reports no-match (FR-014/FR-015/FR-026) â RED until T027", async () => {`
- `tests/boundary/provision.test.ts:12:describe("provision â FR-007 (T017)", () => {`
- `tests/boundary/verify-pin.test.ts:19:describe("verify-pin: match/no-match no-session (T025 â red-by-design, T028 turns green)", () => {`
- `tests/client/credential.test.ts:221:      "(slice-018 T007 review fold P2-1 â printing's printer_capability_missing, real body shape)",`
- `tests/integration/provision-then-settings.test.ts:19:describe("provisionâsettings integration (T024 â FR-007âFR-011)", () => {`

## Cohort pins (titles that include owned test markers)
942:            "bootstrap-reconcile \u2014 T020 / ADR-032 (idempotent seed) with MP_BOOTSTRAP_KEY set, inserts exactly one active '*' bootstrap row whose key_hash matches hashKey(MP_BOOTSTRAP_KEY)",
943:            "bootstrap-reconcile \u2014 T020 / ADR-032 (idempotent seed) calling reconcileBootstrap() twice yields exactly ONE bootstrap row (idempotency)",
944:            "bootstrap-reconcile \u2014 T020 / ADR-032 (idempotent seed) with MP_BOOTSTRAP_KEY unset, no bootstrap row is created",
945:            "bootstrap-reconcile \u2014 T020 / ADR-032 (idempotent seed) rejects non-mpk bootstrap key (throws, no row inserted)",
946:            "bootstrap-reconcile \u2014 T020 / ADR-032 (idempotent seed) re-establishes (un-revokes) a revoked bootstrap row and warns",
947:            "bootstrap-reconcile \u2014 T020 / ADR-032 (idempotent seed) re-establishes an EXPIRED (past expires_at, unrevoked) bootstrap row and warns (issue #110)",
948:            "bootstrap-reconcile \u2014 T020 / ADR-032 (idempotent seed) leaves an already-ACTIVE bootstrap row untouched and does not warn (no spurious re-establish)"
1675:            "member-admin-gate (T018 \u2014 negative tests for US4) legacy v1 /members route is absent legacy v1 /members management routes are NOT registered (specs/002-members-referential-root/spec.md FR-012/FR-013)",
1676:            "member-admin-gate (T018 \u2014 negative tests for US4) legacy v1 /members route is absent POST /api/members with valid device key succeeds, PIN not consulted",
1677:            "member-admin-gate (T018 \u2014 negative tests for US4) legacy v1 /members route is absent PATCH /api/members/:id requires device key, 401 without",
1678:            "member-admin-gate (T018 \u2014 negative tests for US4) legacy v1 /members route is absent PATCH /api/members/:id with valid device key succeeds, regardless of member role",
1679:            "member-admin-gate (T018 \u2014 negative tests for US4) legacy v1 /members route is absent POST /api/members/:id/archive requires device key, 401 without",
1680:            "member-admin-gate (T018 \u2014 negative tests for US4) legacy v1 /members route is absent POST /api/members/:id/archive with valid device key succeeds, PIN not consulted",
1681:            "member-admin-gate (T018 \u2014 negative tests for US4) legacy v1 /members route is absent POST /api/members/:id/restore requires device key, 401 without",
1682:            "member-admin-gate (T018 \u2014 negative tests for US4) legacy v1 /members route is absent POST /api/members/:id/restore with valid device key succeeds, PIN not consulted",
2226:            "provision \u2014 FR-007 (T017) POST /api/auth/provision with valid raw * bootstrap key \u2192 200, Set-Cookie sets mp_device_key, body has no raw key",
2227:            "provision \u2014 FR-007 (T017) POST /api/auth/provision with invalid raw key \u2192 401, body is { error, message }, no raw key leaked",
2228:            "provision \u2014 FR-007 (T017) POST /api/auth/provision without Authorization header \u2192 401, no cookie set, no raw key in body",
2229:            "provision \u2014 FR-007 (T017) POST /api/auth/provision with valid key but NO active bootstrap row in DB \u2192 401",
2230:            "provision \u2014 FR-007 (T017) scopes mounted device credentials and provisioning marker consistently"
2577:            "telemetry negative proofs (T008) 3. CLIENT-LOGGING-TELEMETRY-AC-07: no legacy (v1) client-log import path exists under src/ no source file under src/ imports a legacy v1 telemetry/client-log module or path",
2708:            "time-announcements negative proofs (T011) 3. TIME-ANNOUNCEMENTS-INV-10/AC-08: zero rows at fresh boot (no legacy v1 import) zero time_announcements rows exist in a freshly-migrated database",
2709:            "time-announcements negative proofs (T011) 3. TIME-ANNOUNCEMENTS-INV-10/AC-08: zero rows at fresh boot (no legacy v1 import) no source file under src/ imports a legacy v1 announcement-import path",
3095:            "authFetch \u2014 scope-403 vs credential-invalid (#682) does NOT clear the marker on a domain-specific 403 code OTHER than AUTH_SCOPE_DENIED_CODE (slice-018 T007 review fold P2-1 \u2014 printing's printer_capability_missing, real body shape)",
3403:            "MembersManagement / MemberCreateForm \u2014 adopt the AdminPanel L2 frame (F2, independent review on T017) MembersManagement wraps the surface in a landmark region labelled by its own title",
3404:            "MembersManagement / MemberCreateForm \u2014 adopt the AdminPanel L2 frame (F2, independent review on T017) MemberCreateForm wraps the surface in a landmark region labelled by its own title",
4497:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge type \"message\" renders: raster produced, absent from unrendered AND failed lists",
4498:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge type \"quoteOfDay\" renders: raster produced, absent from unrendered AND failed lists",
4499:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge type \"dadJoke\" renders: raster produced, absent from unrendered AND failed lists",
4500:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge type \"wordOfDay\" renders: raster produced, absent from unrendered AND failed lists",
4501:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge type \"wouldYouRather\" renders: raster produced, absent from unrendered AND failed lists",
4502:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge type \"riddle\" renders: raster produced, absent from unrendered AND failed lists",
4503:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge type \"animalFact\" renders: raster produced, absent from unrendered AND failed lists",
4504:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge type \"numberFact\" renders: raster produced, absent from unrendered AND failed lists",
4505:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge type \"trivia\" renders: raster produced, absent from unrendered AND failed lists",
4506:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge type \"onThisDay\" renders: raster produced, absent from unrendered AND failed lists",
4507:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge type \"drawingPrompt\" renders: raster produced, absent from unrendered AND failed lists",
4508:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge type \"birthday\" renders: raster produced, absent from unrendered AND failed lists",
4509:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge type \"today\" renders: raster produced, absent from unrendered AND failed lists",
4510:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge type \"reminders\" renders: raster produced, absent from unrendered AND failed lists",
4511:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge type \"meals\" renders: raster produced, absent from unrendered AND failed lists",
4512:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge type \"streak\" renders: raster produced, absent from unrendered AND failed lists",
4513:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge type \"streakText\" renders: raster produced, absent from unrendered AND failed lists",
4514:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge type \"weather\" renders: raster produced, absent from unrendered AND failed lists",
4515:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge type \"weatherText\" renders: raster produced, absent from unrendered AND failed lists",
4516:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge type \"shotgun\" renders: raster produced, absent from unrendered AND failed lists",
4517:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge type \"wordSearch\" renders: raster produced, absent from unrendered AND failed lists",
4518:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge word-search renders its grid: the subclass is registered under the wordSearch type key",
4519:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge word-search wrapper (render/blocks/word-search.ts subclasses pressedslip's builtin) overrides wordSearchBorderColor AND separatorColor to #000000 on the ctx it forwards to the builtin's render",
4520:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge riddle answer rotation (render/theme.ts's `answer` text style, rotate: 180) renders without failure through the real bridge",
4521:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge riddle answer rotation (render/theme.ts's `answer` text style, rotate: 180) the def's element tree carries the rotate(180deg) structural marker on the answer line",
4522:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge single-block height floors (measured baseline, ~10% margin for font-hinting jitter) type \"message\" renders at least its measured height floor (229px)",
4523:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge single-block height floors (measured baseline, ~10% margin for font-hinting jitter) type \"drawingPrompt\" renders at least its measured height floor (508px)",
4524:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge single-block height floors (measured baseline, ~10% margin for font-hinting jitter) type \"wordSearch\" renders at least its measured height floor (432px)",
4525:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge single-block height floors (measured baseline, ~10% margin for font-hinting jitter) type \"wordOfDay\" renders at least its measured height floor (420px)",
4526:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge structural labels \u2014 household language (DAILY-BRIEFING-INV-06, Codex #709 P1 fold) meals renders Lunch/Snack/Dinner in en, Comida/Merienda/Cena in es",
4527:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge structural labels \u2014 household language (DAILY-BRIEFING-INV-06, Codex #709 P1 fold) onThisDay renders Events/Births/Deaths in en, Sucesos/Nacimientos/Fallecimientos in es",
4528:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge structural labels \u2014 household language (DAILY-BRIEFING-INV-06, Codex #709 P1 fold) birthday's empty-payload fallback renders in household language",
4529:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge structural labels \u2014 household language (DAILY-BRIEFING-INV-06, Codex #709 P1 fold) weatherText renders Min/Max/Rain in en, M\u00edn/M\u00e1x/Lluvia in es",
4530:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge structural labels \u2014 household language (DAILY-BRIEFING-INV-06, Codex #709 P1 fold) weather renders the condition label in household language (RAIN / LLUVIA)",
4531:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge structural labels \u2014 household language (DAILY-BRIEFING-INV-06, Codex #709 P1 fold) streak's day-of-week strip renders in household language (W for Wednesday vs X for mi\u00e9rcoles)",
4532:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge structural labels \u2014 household language (DAILY-BRIEFING-INV-06, Codex #709 P1 fold) an es envelope threads through the real bridge into a label-consuming def's ctx.composition.meta.language",
4533:            "daily-briefing render-defs (T017) \u2014 per-type render through the real bridge T017 DoD: a full generation across all registered types drains unrendered_blocks to [] all 21 types in one envelope render with zero unrendered and zero failed, raster at least as tall as its tallest constituent"
