# Admin parity: Network devices page (design)

Date: 2026-10-15. Status: owner design review waived; decisions recorded below.
Scope: `/admin/network-devices` (`src/client/admin/NetworkDevicesManagement.tsx`), its tests, its e2e
spec, a dev fixture, and docs. Part of the "admin parity" series (shared brief:
`/private/tmp/claude-501/-Users-diego-Dev-marplanner-project/140acded-3a82-4af5-8da0-acd2052847f1/scratchpad/admin-parity-brief.md`).

## 1. Understanding

Port the reference app's Network devices page behaviour and layout patterns
(`/Users/diego/Dev/marplanner/apps/web/src/routes/admin/_layout/network-devices*`,
`features/network-devices/*`) into our page while keeping what ours does better, and explain and fix
the "Failed to load network devices" error seen in our landing screenshot.

Reference behaviour to port: two sub-tabs (Registered devices | Add device); status dot (green online,
red online and blocked, grey offline, warning glyph for not detected) plus chips; 30 s auto-refresh;
edit alias/member in a dialog; confirm dialog on delete; empty state linking to Add; Retry on load
error; discovery table sortable by name and MAC; already-registered MACs dimmed with an "Already
added" badge; registration in a dialog with the alias prefilled from the client name; after a
registration, return to the list.

Ours to keep: the five live-cache states (unconfigured, cold, stale, freshEmpty, fresh) with distinct
messages; the "confirming" badges for belief divergence (`beliefDiverged` + `attemptedBlockTarget`);
the controller error taxonomy (`controller_unavailable` / `controller_rejected` /
`controller_unreachable` plus neutral generic); inactive-member handling; the invariant that a MAC is
never rendered in the registry list or in the registration dialog (FR-015 / NETWORK-DEVICES-INV-07;
the discovery table is the one documented exception); the stronger delete warning when the device is
blocked or divergent.

Out of scope: any backend change. No endpoint, shared type, OpenAPI file or migration changes
(verified: every needed field already exists in `RegisteredDevice`, `LiveClient`,
`NetworkDevicesListResponse`, `LiveClientsResponse` in `src/shared/index.ts` and
`src/shared/networkDevices.ts`).

## 2. Diagnosis: "Failed to load network devices"

Cause (verified by reading code, not a runtime fault):

1. Every route of the domain is registered with `preHandler = [requireManagementKey(),
requireCapability("network:admin")]` (`src/server/routes/network-devices.ts:56-61`).
2. `requireManagementKey` (`src/server/auth/capability.ts`) answers 403
   `{error:"forbidden", code: AUTH_SCOPE_DENIED_CODE}` for any API key whose `kind === "device"`.
3. A browser that went through the normal provisioning screen (and the dev helper
   `tools/dev/browser-session.mjs`) holds a `kind='device'` key in the `mp_device_key` cookie
   (`src/server/auth/provision.ts:90-93`). So the list call returns 403 and the panel shows the
   generic `networkDevices.management.loadError`.
4. This is the specified behaviour, not a regression: docs/features/network-devices.md FR-009/FR-016,
   contract NETWORK-DEVICES-INV-09 / AC-06, ADR-053 section 6. The plugin being active is not the
   cause: `seeds/seed-090-plugins.ts` activates every plugin, and an inactive plugin would 503
   `plugin_unavailable` and the sidebar entry would be hidden. The sibling `/api/members` etc. are
   unaffected.
5. The e2e spec `tests/e2e/network-devices.spec.ts` only works because it swaps `mp_device_key` to the
   raw `MP_MANAGEMENT_KEY` after the SPA loaded (`requireFullAccess` on `/api/plugins` rejects a
   cookie+integration key, so a reload with the management cookie breaks the plugin catalog read).

Decision: do NOT loosen the security contract (it is a documented requirement and the owner did not
ask to change it). Fix the user-facing defect instead: a 403 with `code === AUTH_SCOPE_DENIED_CODE`
on either read must show a specific, actionable message ("This browser's credential can't manage
network devices. Network access rules need the household management key; see the operations guide.")
instead of the misleading generic failure. `authFetch` already passes a scope-403 through without
de-provisioning (`src/client/lib/credential.ts`), so no change there. Retry is still offered.

Open question for the owner (not blocking, see section 9): as shipped, the page is unusable from a
normally provisioned browser; making it reachable after PIN unlock needs an ADR change.

## 3. Decisions / Assumptions

D1. Tabs are local component state, not URL sub-routes. The brief says "(sub-routes)" but rule 1 says
port behaviour, not mechanism. Reason found while reading code: `Shell.tsx` computes
`AdminUnlockRouteReset active={route.kind === "admin"}` from `resolveHouseholdRoute`
(`src/client/shell/routes.ts`), which only knows exact paths; `/admin/network-devices/add` would be
`unknown-admin` and relock the admin on every tab switch. Supporting real sub-routes needs edits to
`shell/routes.ts`, `AdminRoutes.tsx`, `tests/client/shell-routes.test.tsx`,
`tests/client/admin-routes.test.tsx` (pins the ordered 14-path inventory) and the household contract,
all shared with parallel workers (the Printer page has the same need). Local state follows the
precedent in `DailyBriefingManagement.tsx` (`role="tablist"` of `Button role="tab"`, testids
`daily-briefing-tab-*`). Trade-off accepted: the active tab is not in the URL and is not kept on
refresh. Flag this to the orchestrator: if Printer wants sub-routes, `shell/routes.ts` must learn
prefix matching for admin sub-paths first.

D2. Component split (one responsibility each), all under `src/client/admin/network-devices/` except
the entry file which keeps its path and export name so `AdminRoutes.tsx` is untouched:

- `NetworkDevicesManagement.tsx` (entry): AdminPanel, tablist, "Add device" header button, owns data.
- `network-devices/data.ts`: the `useNetworkDevicesData` hook (devices, cacheState, members, errors,
  30 s refresh, `attemptedBlockTarget`) plus the pure helpers `parseErrorCode`,
  `controllerErrorMessageKey`, `loadFailureMessageKey` (kept in one file to limit new entries in the
  reviewed coverage inventory, see section 10).
- `network-devices/DeviceStatus.tsx`: status dot, chips, member label.
- `network-devices/RegisteredDevices.tsx`: list, row actions, edit Dialog, delete ConfirmDialog.
- `network-devices/DiscoverDevices.tsx`: discovery table + register Dialog.

D3. Dialog, not Sheet (brief rule 13). Edit and register use `Dialog*` from
`@/components/ui/dialog` exactly as `MembersManagement.tsx` does (`DialogContent` with `closeLabel`,
`DialogHeader`, `DialogTitle`, `DialogDescription`); `ConfirmDialog` from `@/components/ConfirmDialog`
for delete (replaces `window.confirm`). No new shared component.

D4. Member select stays a native `<select>` (`NATIVE_SELECT_CLASSES`): the existing logic preserving a
disabled option for an inactive or not-loaded current assignment depends on it, and Radix Select is
not reliably testable in jsdom. It is wrapped in `Field` for label/association. Not a new primitive.

D5. The registration dialog never shows the MAC (reference does). Kept from ours: FR-015/INV-07 and the
existing test "the picker's POST-selection form never renders the MAC". The discovery table does show
MACs (same documented exception as today's picker, and needed for MAC sorting).

D6. Alias prefill: the register dialog opens with `alias = client.displayName ?? ""`, trimmed and cut to
80 chars (the server limit `ALIAS_MAX_LENGTH`). Unnamed client: empty, placeholder text as today.

D7. Status presentation. Dot (decorative, `aria-hidden`; the text label stays the accessible carrier,
"colour is never the sole carrier"): `online` and not blocked = success colour; `online` and blocked =
destructive colour; `unknown` (cache not fresh, so neither online nor offline is knowable) = muted
colour; `notDetected` = a warning glyph (U+26A0, `text-foreground`, there is no warning token in
`src/client/styles/globals.css`) instead of a dot. Chips (pill spans) replace the
current " · " joined text: live-status chip, block chip (blocked / confirming variants), then muted
text for last seen and cache state. Semantic Tailwind tokens only (`bg-success`, `bg-destructive`,
`bg-muted-foreground`; `--color-success`, `--color-destructive`, `--color-muted-foreground` exist in
`globals.css`); no raw palette classes (`npm run check:ui-debt` counts them).
Reference "grey = offline" maps to our `unknown`; our `notDetected` is the reference "not detected".
`lastSeenAt` is still never shown next to "online".

D8. Auto-refresh every 30 s (`REFRESH_MS = 30_000`; the server poller runs every 60 s and the cache
stays fresh for 5 min, so 30 s is the reference cadence and costs nothing). Rules: only while
`document.visibilityState === "visible"`; silent (no loading flash, no spinner); a refresh that fails
keeps the last data and shows nothing new; a refresh result is discarded if any mutation (edit,
delete, block, unblock, register) started or finished while it was in flight (mutation counter ref),
so a stale GET cannot undo a fresh block. The discovery tab does not auto-refresh; it has a Refresh
button (the live cache only changes every 60 s).

D9. "Already added": registered MACs come from `devices[].mac` (the DTO already carries the canonical
lowercase MAC; `LiveClient.mac` is lowercase from `normalize.ts`). Compare with `.toLowerCase()` on
both sides. Rows are dimmed (`opacity-50`), the Add button is replaced by an "Already added" badge.

D10. Sorting: header buttons "Name" and "MAC address" toggle asc/desc, default name asc; `aria-sort`
on the `<th>`; name sort uses `localeCompare` with the household language, unnamed clients sort last
within name sort; stable.

D11. After a successful registration: append to shared `devices`, close the dialog, switch to the
Registered tab, and bump the mutation counter. A 409 `reselect_required` keeps the dialog open with
its dedicated message and re-fetches the live clients; `duplicate_mac` keeps its message.

D12. Empty state (no devices, no list error): text `networkDevices.management.empty` plus a button
styled as link (`Button variant="link"`) "Add a device" that switches to the Add tab
(`network-devices-empty-add`). Suppressed when `listError` is set (existing rule kept).

D13. Retry: list load error shows the `ErrorNotice` plus a "Retry" `Button`
(`network-devices-retry`) that reloads devices and members; discovery load error shows its notice plus
"Retry" (`network-devices-picker-retry`). A members-only failure keeps its own non-blocking notice
(existing behaviour).

D14. Heading equals the sidebar label (brief rule 2): `networkDevices.management.title` becomes
"Network devices" / "Dispositivos de red" (same strings as `admin.sidebar.networkDevices`). Test pins
equality with the sidebar key.

D15. The always-visible primary control `network-devices-open-picker` (now an "Add device" button in the
panel header that switches to the Add tab) is kept: `tests/e2e/admin-unlock-resilience.spec.ts:138`
uses it as the page's reachability probe, and it must still render when the list failed with 403
(that spec provisions a device key). Do not gate it behind data loading.

D16. No seed rows. `src/server/db/seeds/ownership.ts` treats any table outside `DEMO_OWNED_TABLES` as
a refusal on rerun, so seeding `network_devices` would need an ownership-inventory change, and
registration is deliberately picker-only. Instead the "exercise without UniFi" mechanism is a dev
fixture (section 6) that registers demo devices through the real API.

D17. Delete still fires no controller call (FR-014) and still treats a 404 as success. Block/unblock
stay naive re-sends (ADR-053 section 2). No behaviour of these changes.

## 4. UI design

Entry (`NetworkDevicesManagement`): `AdminPanel` (`data-testid="network-devices-management"`, title and
description keys, `actions` slot holds the "Add device" button `network-devices-open-picker`, shown on
the Registered tab only; on the Add tab it is hidden because the tab is the add flow). Under it a
`div role="tablist"` (`aria-label` = new key) with two `Button role="tab"` (variant default when
selected else ghost, `aria-selected`), testids `network-devices-tab-registered` and
`network-devices-tab-add`, copying the markup of `DailyBriefingManagement.tsx:793-816`. Loading state:
the existing `AdminPanel` with the loading text, shown only for the first load of the Registered tab.

Registered tab: `ErrorNotice` (`network-devices-error`), `Retry` button, members notice, then the
list or empty state. Row: dot/glyph, alias (`strong`), member label, status chips, and actions
Edit / Block|Unblock / Delete as text buttons (keep accessible names; e2e and tests rely on them).
Rows wrap on narrow widths (`flex-wrap`). Edit opens `network-devices-edit-dialog` with `Field` alias
(maxLength 80) and member select, Save/Cancel, an `ErrorNotice` inside the dialog for save failures,
Save disabled while saving or while alias is blank (blank trimmed shows the `aliasRequired` message on
submit as today). Delete opens `ConfirmDialog` (title `networkDevices.delete.title`, description
deleteConfirm or deleteConfirmBlocked, confirm label `networkDevices.action.delete`, cancel label
`networkDevices.action.cancel`, `confirmTestId="network-devices-delete-confirm"`).

Add tab: section `network-devices-picker` with description, a Refresh button
(`network-devices-discover-refresh`), then exactly one of: loading, load error + Retry, one of the four
non-fresh state messages in `network-devices-picker-state`, or the table
(`network-devices-picker-clients`). Table columns: Name, MAC address, action. Register dialog
`network-devices-register-dialog` as in D5/D6/D11, with the existing testids
`network-devices-picker-alias-input`, `network-devices-picker-member-select`,
`network-devices-picker-submit`, `network-devices-picker-error` and a Cancel
`network-devices-picker-cancel`.

All strings through `useTranslation()`; new keys in section 7.

## 5. Data flow and errors

`useNetworkDevicesData()` returns `{devices, cacheState, members, loading, listError, membersError,
reloadAll, applyDevice(updated), removeDevice(id), addDevice(device), markMutation(),
attemptedBlockTarget, setAttemptedBlockTarget}`. First load runs `GET /api/network-devices` and
`GET /api/members` independently (a members failure must not hide the registry; keep this existing
guarantee). `loadFailureMessageKey(status, code)` returns `networkDevices.error.managementRequired`
when `status === 403 && code === AUTH_SCOPE_DENIED_CODE` (import the constant from `../../shared`,
already used in `credential.ts`), else the generic `networkDevices.management.loadError`. The same
helper is used by the discovery load (its generic key stays `networkDevices.error.pickerLoadError`).
Network errors thrown by `authFetch` map to the generic key.

## 6. "Exercise without a UniFi controller"

Three layers:

1. Component tests (vitest, jsdom) with the existing `mockRouter` fetch fake cover every state.
2. E2E: `tests/e2e/unifi-fixture-server.ts` (a local self-signed HTTPS controller) already backs
   `tests/e2e/network-devices.spec.ts`, which spawns its own server (scheduler enabled). It is extended
   to support a per-client initial `isBlocked`, and the spec is rewritten for the new tabs and covers
   the management-required message and Retry.
3. Manual dev exercise: new `tools/dev/unifi-fixture.ts` (npm script `dev:unifi-fixture`) starts the
   same fixture server on a fixed port with a stable demo client list (names chosen to match the seeded
   Simpsons household), prints the exact environment to start `npm run dev` with
   (`UNIFI_API_KEY`, `UNIFI_SITE_ID=default`, `UNIFI_HOST`, `NODE_EXTRA_CA_CERTS`, `MP_MANAGEMENT_KEY`),
   and with `--api <origin>` waits for a `fresh` live cache then registers demo devices and blocks one
   through the real API, authenticating with the cookie transport the server accepts
   (`mp_device_key=<MP_MANAGEMENT_KEY>` plus `mp_gate=<sha256 hex of MP_ACCESS_TOKEN>`; docs/operations.md:
   Bearer is accepted only on `/api/plugins*`). `tools/dev/browser-session.mjs` gets an opt-in
   `--management` flag that, as its last step, swaps the CDP browser's `mp_device_key` to
   `MP_MANAGEMENT_KEY` (same trick as the e2e spec: after the SPA and plugin catalog loaded; do not
   reload afterwards). Documented in docs/features/network-devices.md.

The `UNIFI_TLS_INSECURE` toggle is NOT used (known Node 24 undici ABI mismatch recorded in
`tests/e2e/unifi-fixture-server.ts`); `NODE_EXTRA_CA_CERTS` is used instead.

## 7. i18n

All in `src/client/i18n/messages.ts`. Modify values of existing keys (same keys, so parity is kept):
`networkDevices.management.title` (D14), `networkDevices.management.description`
("Register family devices and control their internet access." / es), `networkDevices.action.register`
("Add device" / "Añadir dispositivo"), `networkDevices.picker.select` ("Add" / "Añadir").

New keys, one contiguous block per locale under a `// admin-network-devices` comment placed at the end
of the existing admin keys of that locale (immediately before the closing of the `en` and `es` objects'
admin section; other workers edit the same file):

```
networkDevices.tabs.label            "Network devices sections"        / "Secciones de dispositivos de red"
networkDevices.tabs.registered       "Registered devices"              / "Dispositivos registrados"
networkDevices.tabs.add              "Add device"                      / "Añadir dispositivo"
networkDevices.action.retry          "Retry"                           / "Reintentar"
networkDevices.action.refresh        "Refresh"                         / "Actualizar"
networkDevices.management.emptyAdd   "Add a device"                    / "Añadir un dispositivo"
networkDevices.error.managementRequired
  "This browser's credential can't manage network devices. Network access rules need the household management key; see the operations guide."
  / "La credencial de este navegador no puede gestionar dispositivos de red. Las reglas de acceso a la red requieren la clave de gestión del hogar; consulta la guía de operaciones."
networkDevices.edit.title            "Edit device"                     / "Editar dispositivo"
networkDevices.edit.description      "Change the device's name or the member it belongs to." / "Cambia el nombre del dispositivo o el miembro al que pertenece."
networkDevices.delete.title          "Delete this device?"             / "¿Eliminar este dispositivo?"
networkDevices.discover.columnName   "Name"                            / "Nombre"
networkDevices.discover.columnMac    "MAC address"                     / "Dirección MAC"
networkDevices.discover.sortBy       "Sort by {column}"                / "Ordenar por {column}"
networkDevices.discover.alreadyAdded "Already added"                   / "Ya añadido"
networkDevices.register.title        "Register a device"               / "Registrar un dispositivo"
networkDevices.register.description  "Give this device a friendly name and, optionally, a member." / "Dale a este dispositivo un nombre y, si quieres, un miembro."
```

Check how placeholders like `{seconds}` are interpolated elsewhere (`provisioning.gate.retryAfter`) and
follow that mechanism for `{column}`; if parameters are awkward, use two fixed keys
`networkDevices.discover.sortByName` / `sortByMac` instead. `networkDevices.picker.title` stays and is
used for the Add tab section heading. `tests/client/network-devices-i18n-parity.test.ts` must stay green.

## 8. Tests and docs

Vitest (tests/client): rewrite `network-devices-management.test.tsx` (983 lines; keep every existing
behavioural assertion, move picker flows to the Add tab and dialog, edit to the dialog, delete to
ConfirmDialog), update `network-weather-admin.test.tsx` (density census per phase, `window.confirm`
regression guard becomes ConfirmDialog, header comment) and check `admin-gate-panel-reset.test.tsx`
still passes. New focused tests live in a new `tests/client/network-devices-data.test.ts` (error mapping and the
data hook through `renderHook`, with fake timers: 30 s refresh, hidden-tab skip, stale-discard).
E2E: update `tests/e2e/network-devices.spec.ts`; `admin-unlock-resilience.spec.ts` should pass
unchanged. Docs: `docs/features/network-devices.md` (new "Admin console" requirements, local exercise
section), `docs/ui/household-contract.md` (line 11 entry mentions the two tabs). No OpenAPI change, so
`check:openapi*` stays green.

## 9. Open questions for the owner

1. (Complex, non-blocking) The page is only reachable with the management key as the browser cookie,
   which in turn breaks `/api/plugins*` on reload (cookie + integration kind is rejected by
   `requireFullAccess`). Should a PIN-unlocked admin session on a normal device key be allowed to
   manage network devices (needs an ADR-053 / FR-016 change), or is the management-key requirement
   permanent? This spec keeps the current contract and only fixes the message and the dev workflow.

## 10. Risks

- `messages.ts`, `tests/fixtures/assembly-cohort.json` and `docs/ui/household-contract.md` are shared;
  keep edits minimal and localized.
- `tests/fixtures/assembly-cohort.json` is a reviewed inventory: `coveragePolicy.files` has a per-file
  entry (`minimumTotals` / `minimumRates`) for every measured source file, including
  `src/client/admin/NetworkDevicesManagement.tsx`, and `testCohorts.runners.*.files` lists every test
  title as `"<describe> <title>"`. Splitting the component adds four source entries, shrinks the
  entry file below its recorded totals, and changes test titles. It must be resynced by hand from
  measured values, exactly as commit 844eed79 did ("drop the removed, add the new at their measured
  values, lower a reviewed minimum only where the measured value fell"). Keep existing test titles
  unchanged wherever the behaviour is unchanged to shrink the diff.
- `check:ui-debt` and `check:accessible-names` have baselines; new controls need accessible names and no
  raw palette classes.
- `check:ui-catalog` regenerates a catalog; if it flags new files, run its generator as the repo tooling
  states.
