# Admin parity: Printer page (design)

Date: 2026-10-15. Scope: port the reference app's Printer admin
(`<marplanner-v1>/apps/web/src/routes/admin/_layout/printer*.tsx`,
`apps/web/src/features/printer/{PrinterSettings,PrinterSettingsPanel,PrinterDevicesPanel,PrinterDiagnosticsPanel,PrintLogTable}.tsx`)
into our `src/client/admin/PrintingManagement.tsx`, plus one small backend addition
("reset today's print") and the wiring of the existing `printer` / `printerTransport` settings
objects to the browser transport. Owner waived design review; every question was answered from the
brief (`admin-parity-brief.md`), the reference code and our code, and recorded under Decisions.

## Intent

An admin opening **Printer** should find, as in the reference, two tabs:

- **Settings**: what printing is (plugin state, auto-print state), the paper width, and the
  Bluetooth printer this household uses (connection status, Pair / Re-pair, friendly name, device
  id, UUIDs under "Advanced"), saved with one Save button into the server settings that already
  exist.
- **Diagnostics**: send a test print (our server queue, kept), reset today's print so it can print
  again, and a table of recent prints (when, member, source, status, attempts, failure reason) with
  Refresh.

Success: the page reaches functional parity with the reference without any fake option, everything
except physical pairing/printing works without a real printer, the printing module's public API is
unchanged (only additions), and the existing printing guarantees (server is the only authority on
"did this print", dead-letter/retrying shown distinctly, ErrorNotice announcements) still hold.

## Current state (verified by reading the code)

- `src/client/admin/PrintingManagement.tsx` (200 lines): one `AdminPanel` titled
  `printing.management.title` ("Printing"), a Pair button (`printing-management-pair`, only while
  `printerSession.canPair`), the test-print trigger (`printing-trigger-test-print`) with result
  text (`printing-trigger-result`), and a `<ul>` jobs list (`printing-jobs-list`,
  `printing-job-<id>`, `printing-job-state-<id>`, `printing-jobs-empty`, `printing-list-error`).
  No retry, no settings, no member names.
- Route: `/admin/printing` in `src/client/admin/AdminRoutes.tsx` (plugin `printing`, contribution
  `printing`); sidebar label key `admin.sidebar.printer` = "Printer" / "Impresora".
- Server settings (`src/server/modules/settings/index.ts:42-136`): `printer` `{ paperWidthDots }`
  (default 576, integer > 0) and `printerTransport` `{ deviceId, name, serviceUuid,
characteristicUuid }` (all empty, or deviceId+name non-empty and both UUIDs valid RFC-4122
  versions 1-5). Both owned by the `printing` plugin, read through `GET /api/settings`, written
  through `PUT /api/settings` `{ object, settings }`. Nothing in the client reads or writes them
  today. The render pipeline is fixed at 576 dots (`src/server/modules/printing/escpos.ts:28`
  `PRINT_WIDTH_DOTS`, `daily-briefing/render/raster.ts:25`), so `paperWidthDots` is stored only.
- Client transport (`src/client/printing/transport.ts`): `PrintTransport.pair(): Promise<void>`;
  the Bluetooth implementation tries three candidate services and keeps the first writable
  characteristic, discarding device id/name/UUIDs; the fake (`createFakePrintTransport`) is
  exposed at `window.__mpPrintTransport` in DEV/e2e builds.
- Session (`src/client/printing/PrintExecutor.tsx`): `PrinterSession { active, displayState,
stateLabelKey, canPair, pair: () => void }`; pairing registers the printer capability and starts
  polling. `canPair` is true only while unpaired or disconnected.
- Printing server module (`src/server/modules/printing/index.ts`): `listJobs(now)` returns every job
  newest first with `memberId`, `attempts`, `failureReason`, `derivedState`;
  `supersedePrintRecordTxn(recordKey, targetDate, now)` cancels pending and claimed-not-fetched jobs
  and makes the record re-printable (generation + 1). Routes in `src/server/routes/printing.ts`.
  Contract `docs/api/printing/openapi.yaml`; feature doc `docs/features/printing.md` (FR-001..FR-015).
- Auto-print is owned by Daily Briefing (`GET/PUT /api/daily-briefing/settings`,
  `autoPrintTrigger: "morning_complete" | null`); Printing FR-006 forbids a printing master switch
  or `autoPrint` flag. The Daily Briefing auto-print trigger
  (`src/server/modules/daily-briefing/trigger.ts`) re-enqueues a member's briefing when its record
  is not printed, has no in-flight job of the current generation, and the latest current-generation
  job is not dead-lettered.
- Tests pinning the current UI: `tests/client/printing-management.test.tsx`,
  `tests/client/printing-surfaces.test.tsx` (AdminPanel adoption, shared pair action, kiosk density
  census, ErrorNotice announcements), `tests/client/printing-executor.test.tsx`
  (`onClick={session.pair}`), `tests/client/printer-attention.test.tsx`,
  `tests/e2e/printing.spec.ts`, `tests/e2e/daily-briefing.spec.ts` (lines 943-946, 1031-1034 read
  `printing-job-state-<id>`), `tests/e2e/admin-unlock-resilience.spec.ts:141-143` (primary action
  `printing-trigger-test-print`), `tests/boundary/printing-routes.test.ts` (401 matrix `ROUTES`).
  `tests/fixtures/assembly-cohort.json` lists plugin routes, vitest case ids and per-file coverage
  policy.

## Target behaviour

### Page shell (`PrintingManagement.tsx`)

- `AdminPanel` (`data-testid="printing-management"`), title `t("admin.sidebar.printer")`
  ("Printer"/"Impresora", equal to the sidebar label), description `admin.printer.description`.
- In-page tablist (DailyBriefingManagement pattern: `role="tablist"` + `Button role="tab"`
  `aria-selected`): **Settings** (`printing-tab-settings`, default) and **Diagnostics**
  (`printing-tab-diagnostics`). Only the active tab is mounted, so each tab loads fresh data when
  opened.

### Settings tab (`src/client/admin/printer/PrinterSettingsTab.tsx`, testid `printer-settings`)

Loads `GET /api/settings` on mount. Load failure: `ErrorNotice` (`printer-settings-error`) + Retry
button (`printer-settings-retry`), no form.

1. **Printing plugin** line: label + state text from the printer session
   (`plugins.state.active`/`plugins.state.inactive`; session absent counts as active because the page
   is only routed while the plugin is active) + link "Manage plugins"
   (`printer-plugin-link`) built like `src/client/plugins/PluginUnavailable.tsx`'s link
   (`Button asChild` + `<a href={appUrl(path)}>` whose click calls `navigateHousehold(path)` from
   `@/shell/routes`; importing `navigateAdmin` from `AdminRoutes.tsx` would create an import cycle).
2. **Auto-print after morning chores** (only when `usePluginActive("daily-briefing")`): read-only
   On/Off from `GET /api/daily-briefing/settings` (`autoPrintTrigger === "morning_complete"`), with a
   link "Change in Daily Briefing" (`printer-autoprint-link`, same link pattern, path
   `/admin/daily-briefing`).
   Its own load failure shows a small `ErrorNotice` (`printer-autoprint-error`) and a Retry button
   (`printer-autoprint-retry`); it never blocks the rest of the tab. testid of the value:
   `printer-autoprint-state`.
3. **Paper width (dots)**: `Field` + `Input type="number"` (`printer-paper-width`), hint "Printouts
   are currently rendered at 576 dots (80 mm paper)." Client validation: integer > 0, else field
   error.
4. **Bluetooth** section (heading "Bluetooth", one-line description; no transport radios):
   - Connection status (`printer-connection-status`): when `displayState` is `paired`/`printing`/
     `error` and a paired device is known, "Connected to <name>"; otherwise
     `t(session.stateLabelKey)`; "Not paired" when there is no session.
   - Pair button (`printing-management-pair`, testid kept) while `session.canPair`, labelled Pair /
     Re-pair exactly as today. It calls `session.pair({ serviceUuid, characteristicUuid })` with the
     form's current UUIDs (blank -> omitted).
   - Friendly name `Input` (`printer-name`), Device ID read-only `Input` (`printer-device-id`),
     `<details>` "Advanced (UUIDs)" (`printer-advanced`) with Service UUID (`printer-service-uuid`)
     and Characteristic UUID (`printer-characteristic-uuid`) inputs.
   - When the session reports a newly paired device (identity changes after mount), the form takes
     its `deviceId`, `serviceUuid`, `characteristicUuid`; `name` is kept when the form already had a
     name for the same device id, else the device's own name, else "Thermal printer". A polite note
     "Printer paired. Save to remember it." (`printer-paired-unsaved`) shows until saved.
   - Client validation of the transport block mirrors the server: all four empty, or name and device
     id non-empty and both UUIDs valid. Otherwise one field-level error on the section:
     "Pair a printer, or fill in the name, device ID and both UUIDs." (`printer-transport-error`).
5. **Save** (`printer-settings-save`, disabled while saving, while invalid, or when nothing
   changed). Sends `PUT /api/settings` for `printer` if it changed, then for `printerTransport` if it
   changed (two sequential requests; the server API is per object). On success: form and baseline
   replaced from the last response, "Saved." (`printer-settings-saved`) shown until the next edit.
   On failure: `ErrorNotice` (`printer-settings-save-error`) using `responseMessage`; the form keeps
   the user's edits.

### Diagnostics tab (`src/client/admin/printer/PrinterDiagnosticsTab.tsx`, testid `printer-diagnostics`)

- Actions row: **Send test print** (`printing-trigger-test-print`, behaviour and messages unchanged,
  including `notifyPrintIntentEnqueued()`, 409 -> plugin-inactive message via ErrorNotice) and
  **Reset today's print** (`printing-reset-today`, outline). Reset opens `ConfirmDialog`
  (destructive, confirm testid `printing-reset-today-confirm`, cancel
  `printing-reset-today-cancel`). Confirm -> `POST /api/printing/reset-today` -> result text
  (`printing-reset-today-result`): "Today's print was reset: N record(s) can print again, M queued
  job(s) cancelled." or "Nothing was printed or queued today." 409 -> plugin-inactive message,
  other failure -> "Could not reset today's print." (both via ErrorNotice). Then the table reloads.
  Each action clears the other action's result message.
- **Recent prints** heading + Refresh button (`printing-jobs-refresh`). Loads
  `GET /api/printing/jobs` and `GET /api/members?lifecycle=all` in parallel; the members read is
  optional (on failure, or for an unknown id, the member cell shows "—").
  Jobs failure: `ErrorNotice` (`printing-list-error`, existing text) + Retry
  (`printing-jobs-retry`). Loading text unchanged. Empty: existing `printing-jobs-empty` text.
- Table (`printing-jobs-table`, inside an `overflow-x-auto` wrapper), newest first, at most 50 rows
  (`listJobs` already orders by `created_at DESC`); a caption-like note "Showing the latest 50." only
  when more exist. Row `printing-job-<id>`. Columns:
  - When: `createdAt` formatted with `Intl.DateTimeFormat(language === "es" ? "es-ES" : "en-GB",
{ dateStyle: "short", timeStyle: "short", timeZone: household timezone })`.
  - For: `targetDate` (YYYY-MM-DD as stored).
  - Member: display name from the members map, else "—".
  - Source: `recordKey === "test-print"` -> "Test print"; `recordKey` starting `daily-briefing:` ->
    "Daily briefing"; otherwise the record key verbatim.
  - Status: the existing `STATE_LABEL_KEYS` label in `printing-job-state-<id>`; dead-letter and
    failed through `ErrorNotice` (polite), others plain text (unchanged SC-003/SC-011 behaviour).
  - Attempts: number.
  - Failure reason: `failureReason ?? ""`.

### Backend: reset today's print

- New core function in `src/server/modules/printing/index.ts`:
  `resetTodaysPrints(now: number): ResetTodayPrintsResponse`. Throws
  `PrintingPluginInactiveError` when the plugin is inactive. In one transaction: computes
  `targetDate = todayInHouseholdTz(now)`, selects every `print_records` row for that date, counts
  the jobs that will be cancelled (`pending`, or `claimed` with `payload_served_at IS NULL`), and
  calls the existing `supersedePrintRecordTxn` for each record. After commit it calls
  `notifyPrintingClaimSettled()` when anything changed. Returns `{ targetDate, resetRecords,
cancelledJobs }`. Jobs already fetched in flight continue (same H2 rule as supersede); printed job
  rows keep their history.
- Effect: the record is re-printable; the test print can be enqueued again; Daily Briefing's
  auto-print trigger sees an unprinted record with a new generation and no dead-letter in that
  generation, so it re-enqueues on its next evaluation (wakeup event or periodic sweep), exactly
  like the reference's "Reset today's print flags".
- Route `POST /api/printing/reset-today` in `src/server/routes/printing.ts`: no body (a non-empty
  body object with unknown keys -> 400 `validation_error`, same pattern as test-print); 200 with the
  DTO; errors through `handlePrintingError` (409 `plugin_inactive`).
- Shared DTO `ResetTodayPrintsResponse { targetDate: string; resetRecords: number; cancelledJobs:
number; }` in `src/shared/index.ts` next to `PrintingStatusResponse`; same-named schema in
  `docs/api/printing/openapi.yaml` with the new path (200, 400, 401, 409, 429, 503 like the
  neighbours). `tests/fixtures/assembly-cohort.json` `pluginRoutes` gains
  `{ "method": "POST", "path": "/api/printing/reset-today" }`.
- Not exported through `src/server/host-api/index.ts` (admin-only HTTP surface; producers keep using
  `supersedePrintRecord`). Existing exports and signatures are untouched.

### Transport wiring (client)

- `transport.ts`: `pair(preference?: PrinterEndpointPreference): Promise<PrinterTransportSettings>`
  where `PrinterEndpointPreference = Partial<Pick<PrinterTransportSettings, "serviceUuid" |
"characteristicUuid">>` and `PrinterTransportSettings` is the existing shared settings type.
  - Bluetooth: with no preference, `requestDevice` arguments are byte-identical to today. With a
    preferred service UUID it is tried first and added to `optionalServices` (deduplicated, first).
    Within a service, a writable characteristic whose `uuid` equals the preferred characteristic
    UUID wins, else the first writable one. Resolves `{ deviceId: device.id, name: device.name ??
"", serviceUuid: service.uuid, characteristicUuid: characteristic.uuid }`.
  - Fake: resolves `{ deviceId: "fake-printer", name: "Fake printer", serviceUuid:
preference?.serviceUuid ?? "e7810a71-73ae-499d-8c15-faa9aef0c3f2", characteristicUuid:
preference?.characteristicUuid ?? "bef8d6c9-9c21-4c9e-b632-bd58c1009f9f" }` (both valid for the
    server validator).
- `PrintExecutor.tsx`: `PrinterSession` gains `pairedDevice: PrinterTransportSettings | null` and
  `pair: (preference?: PrinterEndpointPreference) => void`. A successful pair stores the resolved
  identity (kept across disconnects so the page can still name the last printer). Capability
  registration, polling and failure handling are unchanged. Call sites that passed the click event
  (`PrinterAttention.tsx`, the executor test probe) become `() => session.pair()`.
- Persistence stays explicit (reference behaviour): only the Printer page's Save writes
  `printerTransport`. Pairing from the kiosk attention dialog never writes settings.

## Kept (explicit)

Server print queue and test print (instead of the reference's direct browser print); `alreadyPrinted`
dedup message; distinct dead-letter/retrying labels; ErrorNotice announcements; shared printer
session and its `canPair` semantics; capability registration; i18n en/es; AdminPanel landmark.

## Decisions / Assumptions

1. Tabs are local state inside the single `/admin/printing` page (DailyBriefing pattern), never URL
   sub-routes: `resolveHouseholdRoute` (`src/client/shell/routes.ts`) only matches exact admin
   paths, so a sub-path would make Shell's admin-unlock route reset relock admin on every tab switch
   and would break the pinned admin-route inventory test (orchestrator note). No `AdminRoutes.tsx`
   change. Default tab Settings, as in the reference.
2. Heading uses the existing `admin.sidebar.printer` key, so it always equals the sidebar label.
   `printing.management.title`/`description` and `admin.nav.printing` stay (used elsewhere/pinned);
   `printing.management.title` simply becomes unused by this page.
3. The reference's "Enable printer feature" switch is replaced by the plugin state line + link to
   Plugins (brief decision; Printing FR-006: availability = plugin active).
4. Auto-print is shown read-only with a link to Daily Briefing instead of being mirrored as an
   editable toggle: it is Daily Briefing's setting, FR-006 forbids a printing `autoPrint` flag, and
   the Briefing page is reworked in parallel. One source of truth, no write races.
5. Paper width is editable and persisted (brief), with an honest hint that rendering is fixed at 576
   dots. Wiring it into rendering is out of scope (see open question in the report).
6. No transport radios: Bluetooth is the only transport (brief decision), shown as a section title.
7. Pair/Re-pair keeps today's `canPair` rule (shown while unpaired or disconnected, hidden while
   paired) to avoid tearing down a live session mid-print; the reference always showed it.
8. Pairing fills the form; Save persists (reference behaviour). The kiosk attention dialog pairs
   without persisting.
9. Stored UUIDs are a preference for the next pairing, not a hard requirement: if the preferred
   service/characteristic is absent the transport falls back to the candidate list.
10. "Reset today's print" = supersede every print record of the household's today (all sources), so
    both test prints and daily briefings become printable again; queued jobs for today are
    cancelled. Confirmed through `ConfirmDialog` because it can cause a re-print.
11. Recent prints shows at most 50 rows client-side; the API is unchanged (no paging parameter).
    The reference showed bytes sent; our server does not record bytes, so that column is dropped
    and attempts + failure reason (which we do record) are shown instead.
12. Source column cannot distinguish an automatic briefing print from a manual one (same record
    key); both read "Daily briefing".
13. Member names come from `GET /api/members?lifecycle=all` so archived members still resolve.
14. New i18n keys live in one contiguous `// admin-printer` block per locale, right after
    `admin.notFound.description` (end of the admin keys), prefix `admin.printer.*`.
15. New UI files under `src/client/admin/printer/` keep `PrintingManagement.tsx` small; each new
    production file gets a coverage-policy entry in `tests/fixtures/assembly-cohort.json`.
16. No new shared component; reuses AdminPanel, ErrorNotice, Field, ConfirmDialog, Button, Input,
    Label. No seed change: the page works on an empty queue.
17. Docs: `docs/features/printing.md` gains FR-016 (reset today) and FR-017 (admin settings wiring);
    `docs/ui/household-contract.md` item 12 is updated.

## Risks

- `tests/e2e/printing.spec.ts` and `tests/e2e/daily-briefing.spec.ts` share one server; reset
  supersedes every record of today. The printer-session mutex already serialises the two specs and
  daily-briefing records are keyed by freshly created members, so superseding them later is
  harmless, but the e2e reset step is placed at the end of the printing spec.
- Rewritten client tests change vitest case ids and coverage totals; the cohort fixture must be
  resynced from a real run, not guessed.
- `messages.ts`, `assembly-cohort.json`, `src/shared/index.ts`, `docs/ui/household-contract.md` are
  edited by parallel workers: keep edits contiguous and minimal.
- `tests/e2e/daily-briefing.spec.ts` is also touched by the Daily Briefing worker; our change there
  is two inserted tab clicks.
