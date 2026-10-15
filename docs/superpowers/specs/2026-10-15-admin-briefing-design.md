# Admin parity: Daily Briefing page — design

Date: 2026-10-15. Status: design approved by waiver (the owner waived design review; decisions
below were taken autonomously from the shared brief, the reference app and our code).

## 1. Goal

Bring `/admin/daily-briefing` (ours: `src/client/admin/DailyBriefingManagement.tsx`) to parity
with the reference admin (`/Users/diego/Dev/marplanner/apps/web/src/features/daily-briefing-admin/`
`BlockMatrix.tsx`, `BriefingHistory.tsx`, `BriefingImage.tsx`; API
`apps/api/src/routes/admin-daily-briefing.ts`), including the backend gaps, while keeping every
extra we already have: global generation time, auto-print binding, opt-in per member (parents
included), Generate all, block-order editor, per-block language/level/difficulty, preview of any
date.

Success means an admin can, from this one page:

1. Pause a member's briefing on chosen weekdays (master switch per weekday column); a paused
   weekday's cells are disabled; generation skips that member on that weekday, and a manual
   regenerate on a paused day reports "paused on <date>" instead of generating.
2. Pick a member (coloured pills, children plus any opted-in adult), see their last 30 briefings
   with a status badge, select one (or any date), and see its JSON payload and its image with
   honest states (loading / still rendering / no briefing / no printable image / render failed).
3. Regenerate the selected date, open the PNG in a new tab, and print it on demand through our
   server print queue (disabled when the Printing plugin is inactive).
4. See an amber-style "Settings changed — regenerate to apply" notice after editing block
   settings, block order or the pause schedule.
5. Retry any failed load.

## 2. What exists today (verified)

- Server module `src/server/modules/daily-briefing/index.ts`: `generateBriefing(memberId, date?, cache?)`
  (synchronous gather → async external/render → one write transaction; the `pending` reservation
  is never externally observable), `readBriefing`, `readBriefingPng` (`{found, png}`),
  `setOptIn`, `listOptIns`, `generateAllBriefings`, printable provider registered under prefix
  `daily-briefing` (outputRef `daily-briefing:<memberId>:<date>`, record key
  `daily-briefing:<memberId>`).
- `job.ts`: main pass + retry passes (`regenerateFailedBriefings`) + `isMissed` catch-up predicate.
- `trigger.ts`: auto-print sweep, enqueues via host-api `enqueuePrintJob`.
- `settings.ts`: `readAllSettings()` → `DailyBriefingSettingsView {generationTime, autoPrintTrigger, blockOrder, memberBlockSettings}`.
- Routes `src/server/routes/daily-briefing.ts`: `POST /generate`, `POST /generate-all`,
  `GET /opt-in`, `PUT /opt-in/:memberId`, `GET /:memberId/:date`, `GET /:memberId/:date/preview.png`
  (200 / 404 not_found / 409 printable_raster_missing), `GET|PUT /settings`, `PUT /block-order`,
  `PUT /block-settings/:memberId/:blockType`.
- Printing (`src/server/modules/printing/index.ts`, reached only via `src/server/host-api`):
  `enqueuePrintJob({recordKey, targetDate, outputRef, memberId}, now)` dedups per
  (recordKey, targetDate) and returns `{enqueued, jobId, alreadyPrinted}`;
  `supersedePrintRecord(recordKey, targetDate, now)` re-arms a printed record;
  `claimJob` only claims jobs whose `target_date` is the household today.
- Storage: `daily_briefing_optin(member_id PK, enabled, created_at, updated_at)` (absent row = off).
- Client: one 1493-line component with two tabs (Blocks, Preview / Generate), `WeekdayPicker`
  per block row, sr-only selects used by tests, an `<img>` preview that cannot tell 404 from 409.

## 3. Decisions / assumptions

| # | Decision | Why |
|---|----------|-----|
| D1 | Pause schedule is stored as a nullable `weekdays` TEXT (JSON weekday array, canonical order) column on `daily_briefing_optin`, added by migration `drizzle/0005_daily_briefing_schedule.sql` (`ALTER TABLE ... ADD`). `NULL` = every day. A PUT for a member with no opt-in row inserts one with `enabled = 0`. | The opt-in row already is "this member's participation in the briefing"; a column avoids a new plugin table (ownership lists, data-ownership tests, backups). `ALTER ... ADD` follows `0003_calendar_event_details.sql` and keeps the catalog comparison test green (SQLite inserts the column before the table constraints, as Drizzle does). |
| D2 | Weekdays are the canonical `mon..sun` codes (not the reference's 7-bit mask / boolean array). The API always returns an explicit array (`NULL` → all seven). `[]` (paused every day) is allowed. | Same representation as every other weekday field in our app (`shared/weekdays.ts`). |
| D3 | Read: the schedule is returned in the existing aggregate `GET /api/daily-briefing/settings` as `memberSchedules: BriefingSchedule[]` (only members with a stored schedule). Write: new `PUT /api/daily-briefing/schedule/:memberId` body `{weekdays}` → `{memberId, weekdays}`. No per-member GET. | Mirrors how block settings already work (aggregate GET, per-member PUT); no extra fetch for the client. Port behaviour, not mechanism. |
| D4 | Pause semantics: a paused (member, weekday) is skipped by `generateAllBriefings` (scheduled, catch-up, manual Generate all), by the retry passes, by `isMissed`, and by the auto-print trigger. `generateBriefing` itself throws a new `DailyBriefingPausedError` (no write, nothing rolled forward) and `POST /generate` maps it to `200 {skipped: true, reason: "paused", memberId, date}`. No `force` flag. | Reference parity (`regenerateOne` without force). Without the trigger gate a paused member with a completed morning would log `raster-missing` every sweep. |
| D5 | History: `GET /api/daily-briefing/history/:memberId` → `{today, entries}`; `entries` = up to 30 rows `{id, date, status, updatedAt}` ordered by date descending; `today` = household-timezone business date. Unknown member → empty list (pure read). | Reference `GET /history/:memberId` (limit 30). Returning `today` lets the client default to the household date without timezone code. |
| D6 | Manual print: `POST /api/daily-briefing/:memberId/:date/print` (no body). Uses only host-api printing functions (`enqueuePrintJob`, `supersedePrintRecord`, `isPrintingPluginActive`, `todayInHouseholdTz`) — **no change to `src/server/modules/printing/**`**. Record key `daily-briefing:<memberId>:manual:<date>`, `targetDate` = household today (the claim is day-scoped), `outputRef` = `daily-briefing:<memberId>:<date>` (the existing provider serves that briefing's stored raster). If the record is already printed, supersede it and enqueue again, so every click on an idle queue prints once; a click while a job is still pending returns that job (`enqueued: false`). Errors: 404 not_found (no briefing), 409 plugin_inactive, 409 printable_raster_missing, 400 validation_error (bad date, inactive member). | Brief: print through our queue; the Printer page is reworked in parallel, so printing code is not touched. A separate record key keeps manual prints out of the auto-print dedup and out of the briefing's derived printed-status (which describes the automatic print). Day-scoped claims make `targetDate = today` mandatory for printing past dates. Cross-worker note: the Printer page can label jobs whose record key contains `:manual:` as manual. |
| D7 | Still rendering: `generateBriefing` registers `(memberId, date)` in an in-memory in-flight counter from the end of its read transaction until it returns or throws. `readBriefingPng` returns `{found, png, generating}`; the route answers 200 when a PNG is stored, else `202 {status: "rendering"}` while generating, else 404, else 409. | In our synchronous model `pending` is never visible, so the reference's `status === "pending"` test has no equivalent; an in-flight registry is the honest signal (one process, one scheduler). A stored PNG still wins during a regeneration (the old image stays visible until replaced). |
| D8 | Member pills (both workspaces) show active children plus any active adult who is opted in, each with a colour dot from a static class map (`bg-member-<key>-500`, the `TodayAgenda.tsx` precedent; no inline styles, so `check:ui-debt` does not move). The opt-in list keeps every active member. | Brief item 9 says children only; our FR-021 lets parents opt in, so an opted-in parent must stay reachable. |
| D9 | Heading = sidebar label: the page title becomes `t("admin.sidebar.briefing")` ("Briefing" / "Resumen"). No existing message value changes. | Cross-cutting rule 2. |
| D10 | Regenerate sends `{memberId}` when the selected date is the household today (or unknown), and `{memberId, date}` otherwise. | Keeps the e2e contract that pins the UI request body (`{memberId}`) for midnight safety, and lets the server resolve "today". |
| D11 | Image is fetched with `authFetch` and shown from an object URL, so the status code drives the state; Retry button on "still rendering" and "failed". No polling. "Show" always refetches (version counter). "View PNG" is a link (`target="_blank"`) to the preview URL (cookie auth, same as today's `<img>`). | Reference `BriefingImage.tsx`; brief rule 5. |
| D12 | Pause control: a `CheckboxField` under each weekday heading of the block matrix (label "Print", accessible name "<Day>: print"). Paused columns disable that day's checkbox in every row via a new optional `disabledDays` prop on the shared `WeekdayPicker` (additive, backward compatible; no new primitive). | Reference master switch per column. Our matrix renders a `WeekdayPicker` per row spanning the seven columns. |
| D13 | "Settings changed" notice: shown in the Blocks workspace after any successful block-settings, block-order or schedule save; cleared when the Blocks member changes or a regenerate succeeds. Styled with existing semantic tokens (`bg-accent`, `border`), `role="status"`. | No warning/amber semantic token exists; raw amber classes count as UI debt. |
| D14 | Paused regenerate feedback: an inline polite status line in the Preview workspace ("<name> is paused on <date> — switch the day back on in Blocks to generate."). No toast system exists and none is added. | Rule 3 (no new shared primitive). |
| D15 | New client code is split out of the 1493-line page: `src/client/daily-briefing/admin/BriefingWorkspace.tsx` (history + actions + payload + image), `BriefingImage.tsx`, `BriefingMemberPills.tsx` (pattern: `src/client/calendar/admin/`). | Keeps the page file from growing; each unit is testable alone. |
| D16 | Lazy load: the workspace fetches history/read/image only while the Preview / Generate tab is active. | Avoids fetches on the default Blocks tab (and keeps existing Blocks-only tests' strict fetch mocks valid). |
| D17 | No seed changes. | E2E creates its own members; history fills as soon as anything is generated. |
| D19 | No URL sub-routes: the Blocks / Preview tabs, the selected member, the selected history date and "Go to date" are all local component state inside the existing `/admin/daily-briefing` page. `AdminRoutes.tsx` and `src/client/shell/routes.ts` are not touched. | Admin sub-paths make `Shell.tsx`'s admin-unlock route reset relock the admin (`resolveHouseholdRoute` matches exact paths only) and break the pinned admin-route inventory test (orchestrator note). The reference's `/admin/daily-briefing/preview` sub-route is ported as a tab. |
| D18 | The existing hidden selects `daily-briefing-member-select` and `daily-briefing-admin-block-settings-member-select` stay (bound to the same pill state); `daily-briefing-admin-preview-member-select` is removed (one member choice in the workspace). | Minimises test churn while removing the duplicate preview member choice. |

## 4. Architecture

### 4.1 Server

```
schedule.ts (new)          errors.ts (+3 classes)
   ▲    ▲     ▲   ▲               ▲
   │    │     │   └── trigger.ts (filter eligible members)
   │    │     └────── job.ts (isMissed, retry pass)
   │    └──────────── settings.ts (readAllSettings.memberSchedules)
   └───────────────── index.ts (generateBriefing pause check, generateAllBriefings skip,
                                in-flight registry, readBriefingPng.generating,
                                listBriefingHistory, printBriefing)
routes/daily-briefing.ts: PUT /schedule/:memberId, GET /history/:memberId,
                          POST /:memberId/:date/print, generate → skipped, preview → 202
```

- `schedule.ts` (imports only `../../host-api`, `./errors`, `../../../shared/weekdays`):
  `readMemberWeekdays(memberId): WeekdayCode[]`, `listMemberSchedules(): BriefingSchedule[]`,
  `setMemberSchedule(memberId, weekdays: unknown): BriefingSchedule`,
  `isBriefingScheduledOn(memberId, date): boolean`.
- `errors.ts`: `DailyBriefingPausedError(memberId, date)` (NOT a validation error),
  `DailyBriefingNotFoundError`, `DailyBriefingPrintUnavailableError`,
  `DailyBriefingRasterMissingError`.
- `weekday-integrity.ts` checks the new column (nullable, keyed by `member_id`).

### 4.2 Shared types (`src/shared/dailyBriefing.ts`, already re-exported by `src/shared/index.ts`)

```ts
export interface BriefingSchedule { memberId: string; weekdays: WeekdayCode[] }
export interface BriefingHistoryEntry { id: string; date: string; status: BriefingStatus; updatedAt: number }
export interface BriefingHistoryResponse { today: string; entries: BriefingHistoryEntry[] }
export interface GenerateSkippedResponse { skipped: true; reason: "paused"; memberId: string; date: string }
export interface BriefingPrintResponse { jobId: string; enqueued: boolean }
export interface BriefingPreviewRendering { status: "rendering" }
```

### 4.3 Client

- `DailyBriefingManagement.tsx` keeps: tabs, opt-in list, Generate all + statuses, generation
  settings card, block-order card, block matrix. Changes: title key (D9); Retry buttons on member
  and settings load errors; Blocks member pills via `BriefingMemberPills`; per-day pause row in the
  matrix header + `disabledDays`; schedule state from `memberSchedules`; "settings changed" notice;
  the old single-member generate panel and preview card are replaced by `<BriefingWorkspace>`.
- `BriefingWorkspace` props: `members` (pill set), `optIns`, `active` (tab visible),
  `blocked` (Generate all running or opt-in PUT pending), `onGenerated(briefing)`,
  `onBusyChange(busy)`. Owns: selected member, `selectedDate | null`, history, read result,
  image version, generate/print state, notices.
- `BriefingImage` props: `memberId`, `date`, `version`, `status?` (to word the 409 message).
- `BriefingMemberPills` props: `members`, `selectedId`, `onSelect`, `testIdPrefix`.

## 5. UI layout (Preview / Generate tab)

1. Opt-in card (unchanged behaviour; the member pill no longer lives inside each opt-in row).
2. Generate all bar + latest statuses + already-running note (unchanged).
3. Workspace (stacks on narrow screens, side by side from `xl`):
   - Left: member pills; history list (date in mono + status badge; selected highlighted;
     empty: "No briefing yet — Generate creates today's."); "Go to date" date input + Show.
   - Right: actions row — Generate/Regenerate (label depends on whether the active date has a
     briefing; disabled with hint when the member is not opted in), View PNG (link), Print
     (disabled with a hint when Printing is inactive or there is no briefing); notices
     (paused, print queued / already queued, errors with Retry); status line; JSON payload
     (`<pre>`); image panel with its states.

Test ids kept: `daily-briefing-management`, `daily-briefing-tab-blocks|preview`,
`daily-briefing-blocks-workspace`, `daily-briefing-preview-workspace`, `daily-briefing-opt-in-<id>`,
`daily-briefing-preview-member-<id>` (now the workspace pills), `daily-briefing-member-select`,
`daily-briefing-generate`, `daily-briefing-generate-all`, `daily-briefing-generate-all-info`,
`daily-briefing-member-statuses`, `daily-briefing-member-status-<id>`, `daily-briefing-status`,
`daily-briefing-generated-payload`, `daily-briefing-admin-preview-date`,
`daily-briefing-admin-preview-show`, `daily-briefing-admin-preview-image`, every Blocks id.
New: `daily-briefing-history-list`, `daily-briefing-history-entry-<date>`,
`daily-briefing-history-empty`, `daily-briefing-history-error`, `daily-briefing-view-png`,
`daily-briefing-print`, `daily-briefing-print-notice`, `daily-briefing-paused-notice`,
`daily-briefing-needs-opt-in`, `daily-briefing-image-state` (with `data-state`),
`daily-briefing-image-retry`, `daily-briefing-schedule-day-<day>`, `daily-briefing-settings-changed`,
`daily-briefing-retry`, `daily-briefing-settings-retry`, `daily-briefing-schedule-error`.

## 6. Error handling

| Situation | Server | Client |
|-----------|--------|--------|
| Bad weekday / unknown key / inactive member on schedule PUT | 400 validation_error | ErrorNotice in Blocks (`daily-briefing-schedule-error`), checkbox reverts |
| Generate on paused weekday | 200 `{skipped:true,...}` | paused notice, nothing else changes |
| History load fails | — | ErrorNotice + Retry |
| Preview 202 / 404 / 409 / other | as D7 | rendering+Retry / "No briefing for <date>" / "Render failed" (status render-failed) or "No printable image — Printing was off when it was generated" / "Could not load the image" + Retry |
| Print: no briefing / Printing off / no raster / inactive member | 404 / 409 plugin_inactive / 409 printable_raster_missing / 400 | ErrorNotice with the server message via `responseMessage` |
| Members / settings load fails | — | ErrorNotice + Retry (new) |

## 7. Documentation changes

- `docs/features/daily-briefing.md`: User Story 4 (admin page), FR-023…FR-028 (pause schedule,
  skip semantics incl. trigger, history, manual print through the queue, 202 rendering,
  member pills/notice are UI and stay out of FRs), Key Entity "Member schedule".
- `docs/api/daily-briefing/openapi.yaml`: generate 200 `oneOf [Briefing, GenerateSkippedResponse]`;
  `GET /api/daily-briefing/history/{memberId}`.
- `docs/api/briefing-render/openapi.yaml`: `DailyBriefingSettingsView.memberSchedules`;
  `PUT /api/daily-briefing/schedule/{memberId}`; preview 202; `POST /api/daily-briefing/{memberId}/{date}/print`.
- `docs/ui/household-contract.md` line 64.

## 8. Testing

- Server (vitest): new `tests/boundary/daily-briefing-admin-parity.test.ts` (schedule PUT/GET,
  pause skip in generate route + `generateAllBriefings` + retry pass + `isMissed`, history,
  print happy/reprint/errors, 202 while a generation is held open); one new case in
  `tests/integration/daily-briefing-trigger.test.ts` (paused member is not enqueued).
  Updated: settings GET `toEqual`, migration lists (3 files), plugin-routes auth matrix.
- Client (vitest): new `tests/client/daily-briefing-workspace.test.tsx` (history, select,
  payload, image states, regenerate body rule, paused notice, print enabled/disabled + notice,
  Retry); `weekday-picker.test.tsx` (+`disabledDays`); management/admin tests updated for the
  new pills, schedule row, notice, Retry and heading.
- E2E: `tests/e2e/daily-briefing.spec.ts` heading key; the first test also checks the history
  entry and a pause → regenerate → skipped → resume round trip.

## 9. Out of scope

Reference print-playground, browser Bluetooth printing from this page, `force` regenerate,
per-member GET schedule endpoint, toasts, polling for renders, seed changes, Printer page work.
