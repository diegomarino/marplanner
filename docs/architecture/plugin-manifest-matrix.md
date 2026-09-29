# Plugin Manifest Matrix

This document is the canonical T002 mapping from the closed ADR-029 plugin cohort to the
contributions that exist in the current application. The catalog IDs below are stable manifest IDs;
each maps to an existing owner symbol, destination, or block type. Scheduler job IDs are the exact
runtime IDs registered with the scheduler, not catalog aliases.

The ordered catalog cohort is unchanged:

1. `daily-briefing`
2. `printing`
3. `weather`
4. `time-announcements`
5. `backups`
6. `network-devices`
7. `meals-recipes`
8. `reminders`
9. `daily-messages`

`external-calendar-sync` remains excluded. The eight ADR-029 core candidates remain host-owned and
must never receive manifests.

## Contribution inventory

Service entries use `id (runtime)` where runtime is exactly `server` or `browser`. Content-source
IDs are the exact Daily Briefing block type consumed by the generation registry. An empty cell means
that the plugin owns no contribution in that category today.

The public six-category contribution DTO is projected without loss: route, Admin, settings-panel,
and widget IDs retain their category; runtime service IDs and content-source IDs both appear exactly
once in public `services`; scheduler IDs appear exactly once in public `jobs`. Runtime metadata and
runtime scheduler punctuation remain internal. Content sources use the following stable kebab-case
public IDs:

| Internal content-source ID | Public service ID |
| -------------------------- | ----------------- |
| `weather`                  | `weather`         |
| `weatherText`              | `weather-text`    |
| `meals`                    | `meals`           |
| `reminders`                | `reminders`       |
| `message`                  | `message`         |

Runtime scheduler IDs use the following stable kebab-case public job IDs:

| Internal scheduler ID             | Public job ID                     |
| --------------------------------- | --------------------------------- |
| `daily-briefing.generate-all`     | `daily-briefing-generate-all`     |
| `daily-briefing.retry-15`         | `daily-briefing-retry-15`         |
| `daily-briefing.retry-30`         | `daily-briefing-retry-30`         |
| `daily-briefing.auto-print-sweep` | `daily-briefing-auto-print-sweep` |
| `backups.nightly`                 | `backups-nightly`                 |
| `network-devices.poll`            | `network-devices-poll`            |

| Plugin ID            | Route IDs                | Admin IDs            | Settings-panel IDs        | Widget IDs          | Service IDs                                              | Content-source IDs       | Scheduler job IDs                                                                                                      |
| -------------------- | ------------------------ | -------------------- | ------------------------- | ------------------- | -------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `daily-briefing`     | `daily-briefing-api`     | `daily-briefing`     | `daily-briefing-settings` | —                   | `daily-briefing-generator (server)`                      | —                        | `daily-briefing.generate-all`, `daily-briefing.retry-15`, `daily-briefing.retry-30`, `daily-briefing.auto-print-sweep` |
| `printing`           | `printing-api`           | `printing`           | —                         | `printer-attention` | `printing-queue (server)`, `printing-executor (browser)` | —                        | —                                                                                                                      |
| `weather`            | `weather-api`            | `weather`            | `weather-settings`        | `weather-pill`      | `weather-forecast-provider (server)`                     | `weather`, `weatherText` | —                                                                                                                      |
| `time-announcements` | `time-announcements-api` | `time-announcements` | —                         | —                   | `time-announcements-speaker (browser)`                   | —                        | —                                                                                                                      |
| `backups`            | `backups-api`            | `backups`            | —                         | —                   | —                                                        | —                        | `backups.nightly`                                                                                                      |
| `network-devices`    | `network-devices-api`    | `network-devices`    | —                         | —                   | `network-devices-controller (server)`                    | —                        | `network-devices.poll`                                                                                                 |
| `meals-recipes`      | `meals-recipes-api`      | `meals`              | —                         | `today-meals`       | —                                                        | `meals`                  | —                                                                                                                      |
| `reminders`          | `reminders-api`          | `reminders`          | —                         | —                   | —                                                        | `reminders`              | —                                                                                                                      |
| `daily-messages`     | `daily-messages-api`     | `daily-messages`     | —                         | —                   | —                                                        | `message`                | —                                                                                                                      |

### Contribution sources

| Plugin ID            | Source evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `daily-briefing`     | Route owner: `src/server/routes/daily-briefing.ts` (`dailyBriefingRoutes`). Admin destination and panel: `src/client/shell/routes.ts`, `src/client/admin/AdminRoutes.tsx`, and `src/client/admin/DailyBriefingManagement.tsx` (`daily-briefing-admin-settings`). Server generator: `src/server/modules/daily-briefing/index.ts` (`generateBriefing`, `generateAllBriefings`). Job IDs: `src/server/modules/daily-briefing/job.ts` and `src/server/modules/daily-briefing/trigger.ts`. |
| `printing`           | Route owner: `src/server/routes/printing.ts` (`printingRoutes`). Admin destination: `src/client/shell/routes.ts` and `src/client/admin/AdminRoutes.tsx`. Visible widget mount: `src/client/shell/HouseholdChrome.tsx` (`PrinterAttention`). Server queue: `src/server/modules/printing/index.ts`. Browser executor: `src/client/printing/PrintExecutor.tsx`.                                                                                                                          |
| `weather`            | Route owner: `src/server/routes/weather.ts` (`weatherRoutes`). Admin destination and settings surface: `src/client/shell/routes.ts`, `src/client/admin/AdminRoutes.tsx`, and `src/client/admin/WeatherManagement.tsx`. Visible widget mount: `src/client/shell/HouseholdChrome.tsx` (`WeatherPill`). Server provider: `src/server/modules/weather/port.ts` (`getForecastPort`). Content sources: `src/server/modules/daily-briefing/blocks/weather.ts` and `weatherText.ts`.          |
| `time-announcements` | Route owner: `src/server/routes/time-announcements.ts` (`timeAnnouncementsRoutes`). Admin destination: `src/client/shell/routes.ts` and `src/client/admin/AdminRoutes.tsx`. The speaking service is browser-local: `src/client/time-announcements/service.tsx` registers `AnnouncementService` through the shell, and `src/client/main.tsx` loads that registration. There is no server speaking service or scheduler job.                                                            |
| `backups`            | Route owner: `src/server/routes/backups.ts` (`backupsRoutes`). Admin destination: `src/client/shell/routes.ts` and `src/client/admin/AdminRoutes.tsx`. The only lifecycle-controlled background job is the exact `BACKUPS_JOB_ID` from `src/server/backups/job.ts`. No snapshot or restore primitive is a declared service contribution.                                                                                                                                              |
| `network-devices`    | Route owner: `src/server/routes/network-devices.ts` (`networkDevicesRoutes`). Admin destination: `src/client/shell/routes.ts` and `src/client/admin/AdminRoutes.tsx`. Server controller: `src/server/modules/network-devices/client.ts` (`getUniFiClient`). Job ID: `src/server/modules/network-devices/poll.ts` (`NETWORK_DEVICES_POLL_JOB_ID`).                                                                                                                                     |
| `meals-recipes`      | Route owner: `src/server/routes/meals.ts` (`mealsRoutes`). Family and Admin destinations: `src/client/shell/routes.ts` and `src/client/admin/AdminRoutes.tsx`. Visible home widget: `src/client/home/HomeSurface.tsx` (`TodayMeals`). Daily Briefing content source: `src/server/modules/daily-briefing/blocks/meals.ts` (`mealsBlock.type`).                                                                                                                                         |
| `reminders`          | Route owner: `src/server/routes/reminders.ts` (`remindersRoutes`). Admin destination: `src/client/shell/routes.ts` and `src/client/admin/AdminRoutes.tsx`. Daily Briefing content source: `src/server/modules/daily-briefing/blocks/reminders.ts` (`remindersBlock.type`). Reminders own no client widget and no scheduler job.                                                                                                                                                       |
| `daily-messages`     | Route owner: `src/server/routes/daily-messages.ts` (`dailyMessagesRoutes`). Admin destination: `src/client/shell/routes.ts` and `src/client/admin/AdminRoutes.tsx`. Daily Briefing content source: `src/server/modules/daily-briefing/blocks/message.ts` (`messageBlock.type`). Daily Messages own no client widget and no scheduler job.                                                                                                                                             |

## Core requirements

Requirement IDs name feature-specific core dependencies. Universal host envelopes such as the
Fastify process and the React/i18n rendering substrate are not repeated on every row.

| Plugin ID            | Exact requirement IDs                                                         | Source evidence                                                                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `daily-briefing`     | `members`, `app-settings`, `calendar-local`, `day-periods`, `routines-chores` | `src/server/modules/daily-briefing/index.ts`, `job.ts`, `trigger.ts`, and the `today.ts`/`streak.ts` blocks read member eligibility, locale/settings, local events, and the day-period/chores board.       |
| `printing`           | `auth-sessions`, `app-settings`, `kiosk-shell`                                | `src/server/routes/printing.ts`, `src/server/modules/settings/index.ts`, and `src/client/shell/Shell.tsx`/`src/client/printing/PrinterSession.tsx`.                                                        |
| `weather`            | `app-settings`                                                                | `src/server/modules/weather/index.ts` reads the `weather` App Settings object; household timezone is supplied through the same settings owner in `src/server/modules/weather/port.ts`.                     |
| `time-announcements` | `app-settings`, `kiosk-shell`                                                 | `src/client/time-announcements/service.tsx` reads household timezone and registers in the browser shell.                                                                                                   |
| `backups`            | `auth-sessions`, `app-settings`                                               | `src/server/routes/backups.ts` uses authenticated management routes; `src/server/backups/storage.ts` reads household timezone from App Settings.                                                           |
| `network-devices`    | `members`                                                                     | `src/server/modules/network-devices/index.ts` validates and resolves member assignments. Operator `unifi.*` configuration is private host configuration, not a catalog requirement or settings descriptor. |
| `meals-recipes`      | `members`, `app-settings`                                                     | `src/server/modules/meals/index.ts` owns member-linked data and reads household timezone plus `weekStartDay`.                                                                                              |
| `reminders`          | `members`, `calendar-local`, `app-settings`                                   | `src/server/modules/reminders/index.ts` validates members, evaluates calendar-gated rules, and derives weekdays using household timezone.                                                                  |
| `daily-messages`     | `members`                                                                     | `src/server/modules/daily-messages/index.ts` validates and resolves member ownership.                                                                                                                      |

## Settings descriptors

Descriptors expose schema only; they never expose configured or default values. Their public keys
are camelCase identifiers accepted by the OpenAPI contract; the source-owner column names the
plugin-local object and field to which each key maps. `sensitive` marks household-location fields
even though values are never present in the manifest.

| Plugin ID        | Key                             | Label key                                 | Value type | Required | Sensitive | Source evidence                                                                                                    |
| ---------------- | ------------------------------- | ----------------------------------------- | ---------- | -------- | --------- | ------------------------------------------------------------------------------------------------------------------ |
| `daily-briefing` | `dailyBriefingGenerationTime`   | `dailyBriefing.admin.generationTimeLabel` | `string`   | yes      | no        | `src/server/modules/daily-briefing/settings.ts`: `dailyBriefing.generationTime` in `DailyBriefingSettingsSnapshot` |
| `daily-briefing` | `dailyBriefingAutoPrintTrigger` | `dailyBriefing.admin.triggerBindingLabel` | `enum`     | no       | no        | `src/server/modules/daily-briefing/settings.ts`: `dailyBriefing.autoPrintTrigger` (`"morning_complete"             | null`) |
| `weather`        | `weatherLat`                    | `weather.management.latLabel`             | `number`   | no       | yes       | `src/server/modules/weather/index.ts`: `weather.lat` in `WeatherSettingsObject`/`validateWeather`                  |
| `weather`        | `weatherLon`                    | `weather.management.lonLabel`             | `number`   | no       | yes       | `src/server/modules/weather/index.ts`: `weather.lon` in `WeatherSettingsObject`/`validateWeather`                  |
| `weather`        | `weatherLabel`                  | `weather.management.labelLabel`           | `string`   | no       | yes       | `src/server/modules/weather/index.ts`: `weather.label` in `WeatherSettingsObject`/`validateWeather`                |

Printing's validator-owned `printer` and `printerTransport` fields have no localized authoring
surface, so they are intentionally absent from the public catalog schema. The lifecycle does not
invent labels or expose private operator configuration. All other plugins also have an empty
settings schema.

## Backups lifecycle boundary

Only the `backups-api` product surface, the `backups` Admin destination, and the
`backups.nightly` scheduled/manual product job are lifecycle-controlled contributions. The manifest
deliberately declares no broad snapshot or restore service.

The following safety responsibilities remain mandatory, host-owned, and callable regardless of the
Backups lifecycle state:

- migration protection required by Constitution XII and FR-019;
- the `createSnapshot("pre-restore")` path used inside `restoreDatabase`;
- restore filename/source validation and the execution-time version gate;
- the post-swap `PRAGMA integrity_check` and core read-boundary smoke;
- rollback to the pre-restore snapshot and the quiesce/drain safety sequence.

Their current owners are `src/server/db/migrate.ts`, `src/server/backups/storage.ts`, and
`src/server/backups/restore.ts`. No current or future manifest contribution ID may claim these host
safety primitives.
