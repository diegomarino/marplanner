# Step 02: Access and credentials

**Status:** complete

**Verdict:** pass (accepted dispositions recorded)

**Evidence:** [findings](evidence/02-findings.md) · [journeys](evidence/02-journeys.md) · [server](evidence/02-inspection-server.md) · [client](evidence/02-inspection-client.md) · [docs](evidence/02-inspection-docs.md) · [tests](evidence/02-inspection-tests.md) · [naming ledger](evidence/02-naming-ledger.md) · [candidate](evidence/02-candidate.txt)

**Prerequisites:** step 01

Read [PLAN.md](PLAN.md) for scope, execution and closure rules. This is a review task; remediation is a separately scoped change.

## Review actions and acceptance

- [x] Complete the common naming audit from PLAN.md; record replacements and justified retained matches.
- [x] Complete the functional journey matrix with UI/API evidence for every capability in this phase.
- [x] Complete rendered UI review and polish with screenshots, or record a justified backend-only disposition.
- [x] Verify scoped repairs and affected consumers; keep untested or unresolved items visible.

- [x] Exercise every public authentication boundary with missing, malformed, wrong-scope and revoked credentials; prove the UI PIN cannot grant API permissions.
- [x] Verify browser provisioning, gate/device cookies, unlock resilience, throttling, credential lifecycle and transport assumptions on the intended deployment origin.
- [x] Review SECURITY.md and establish the private vulnerability-reporting destination; inspect redaction and public artifact hygiene with step 13.
- [x] Trace public callers and downstream consumers; inspect implementation, tests, contracts and error paths together.
- [x] Record findings with exact path/line, public reproduction, impact and required proof.
- [x] Attach commands, observed results, candidate identity and limits; passing tests alone do not mark files reviewed.

## Owned files — exhaustive checklist

Each checkbox certifies actual inspection of that exact file. For binary/generated assets, review provenance, license, generator, integrity and their consuming behavior.

- [x] `SECURITY.md`
- [x] `docs/api/bootstrap/openapi.yaml`
- [x] `docs/architecture/contracts/auth-sessions.md`
- [x] `docs/architecture/decisions/ADR-007-api-key-backend-boundary.md`
- [x] `docs/architecture/decisions/ADR-013-pin-client-side-ui-gate.md`
- [x] `docs/architecture/decisions/ADR-030-multi-key-scoped-api-keys.md`
- [x] `docs/architecture/decisions/ADR-031-frontend-access-gate-and-unauthenticated-surface.md`
- [x] `docs/architecture/decisions/ADR-032-bootstrap-key-establishment.md`
- [x] `docs/architecture/decisions/ADR-033-fail-closed-no-environment-auth-bypass.md`
- [x] `docs/architecture/decisions/ADR-034-admin-entry-long-press-affordance.md`
- [x] `docs/architecture/decisions/ADR-036-connection-setup-provisioning-placement.md`
- [x] `docs/architecture/decisions/ADR-037-credential-format-and-generation.md`
- [x] `docs/architecture/decisions/ADR-058-kiosk-operator-trust-calibration.md`
- [x] `docs/architecture/decisions/ADR-060-deployment-transport-posture-and-cookie-security.md`
- [x] `docs/features/auth-sessions.md`
- [x] `src/client/admin/AdminGate.tsx`
- [x] `src/client/lib/adminUnlock.tsx`
- [x] `src/client/lib/credential.ts`
- [x] `src/server/auth/boundary.ts`
- [x] `src/server/auth/capability.ts`
- [x] `src/server/auth/cookies.ts`
- [x] `src/server/auth/credentials.ts`
- [x] `src/server/auth/eff-wordlist.ts`
- [x] `src/server/auth/gate.ts`
- [x] `src/server/auth/pin.ts`
- [x] `src/server/auth/provision.ts`
- [x] `src/server/auth/reconcile.ts`
- [x] `src/server/auth/throttle.ts`
- [x] `src/server/routes/provision.ts`
- [x] `src/server/routes/verify-pin.ts`
- [x] `tests/boundary/access-gate.test.ts`
- [x] `tests/boundary/auth-boundary.test.ts`
- [x] `tests/boundary/auth-throttling.test.ts`
- [x] `tests/boundary/bootstrap-reconcile.test.ts`
- [x] `tests/boundary/credentials.test.ts`
- [x] `tests/boundary/encoding-bypass.test.ts`
- [x] `tests/boundary/fail-closed.test.ts`
- [x] `tests/boundary/key-lifecycle.test.ts`
- [x] `tests/boundary/member-admin-gate.test.ts`
- [x] `tests/boundary/no-session.test.ts`
- [x] `tests/boundary/provision.test.ts`
- [x] `tests/boundary/verify-pin.test.ts`
- [x] `tests/client/admin-gate-no-boot-probe.test.tsx`
- [x] `tests/client/admin-gate-panel-reset.test.tsx`
- [x] `tests/client/admin-gate-printing-nav.test.tsx`
- [x] `tests/client/admin-gate.test.tsx`
- [x] `tests/client/admin-pin-keypad.test.tsx`
- [x] `tests/client/credential.test.ts`
- [x] `tests/client/provisioning-gate.test.tsx`
- [x] `tests/e2e/admin-unlock-resilience.spec.ts`
- [x] `tests/e2e/admin-unlock.ts`
- [x] `tests/integration/bootstrap-provision.test.ts`
- [x] `tests/integration/provision-then-settings.test.ts`

## Required shared and dependency context — exact files

Read these files for this step's interactions. This list includes the transitive maintained local-import closure and shared fixtures. Their primary inspection is tracked in their owner step. Bare dependency imports are governed by package.json/package-lock.json. Runtime paths and dynamically constructed dependencies still require caller tracing; add any discovered file before closure.

- `docs/architecture/principles.md`
- `docs/quality/verification.md`
- `eslint.config.mjs`
- `package.json`
- `playwright.config.ts`
- `scripts/build-server.mjs`
- `src/client/admin/AdminRoutes.tsx`
- `src/client/admin/BackupsManagement.tsx`
- `src/client/admin/CalendarManagement.tsx`
- `src/client/admin/ChoreOrderControls.tsx`
- `src/client/admin/DailyBriefingManagement.tsx`
- `src/client/admin/DailyMessagesManagement.tsx`
- `src/client/admin/DayPeriodsManagement.tsx`
- `src/client/admin/MealsManagement.tsx`
- `src/client/admin/MemberCreateForm.tsx`
- `src/client/admin/MembersManagement.tsx`
- `src/client/admin/NetworkDevicesManagement.tsx`
- `src/client/admin/PrintingManagement.tsx`
- `src/client/admin/RemindersManagement.tsx`
- `src/client/admin/RoutinesManagement.tsx`
- `src/client/admin/TelemetryManagement.tsx`
- `src/client/admin/TimeAnnouncementsManagement.tsx`
- `src/client/admin/WeatherManagement.tsx`
- `src/client/calendar/CalendarMonthView.tsx`
- `src/client/calendar/CalendarView.tsx`
- `src/client/calendar/ScheduleXWeekView.tsx`
- `src/client/calendar/admin/ExternalSourceCard.tsx`
- `src/client/calendar/admin/HighlightRuleCard.tsx`
- `src/client/calendar/admin/reorder.ts`
- `src/client/calendar/calendar-presentation.ts`
- `src/client/calendar/member-event-style.ts`
- `src/client/calendar/schedule-x-overrides.css`
- `src/client/chores/ChoreColumns.tsx`
- `src/client/chores/ChoresBoard.tsx`
- `src/client/chores/EmojiPicker.tsx`
- `src/client/chores/emoji-catalog.ts`
- `src/client/chores/noto-emoji.tsx`
- `src/client/chores/useTodayChores.ts`
- `src/client/components/AdminPanel.tsx`
- `src/client/components/CheckboxField.tsx`
- `src/client/components/ConfirmDialog.tsx`
- `src/client/components/ErrorNotice.tsx`
- `src/client/components/Field.tsx`
- `src/client/components/RadioField.tsx`
- `src/client/components/StatusToggle.tsx`
- `src/client/components/WeekdayPicker.tsx`
- `src/client/components/ui/button.tsx`
- `src/client/components/ui/card.tsx`
- `src/client/components/ui/dialog.tsx`
- `src/client/components/ui/input.tsx`
- `src/client/components/ui/label.tsx`
- `src/client/components/ui/select.tsx`
- `src/client/components/ui/textarea.tsx`
- `src/client/home/HomeSurface.tsx`
- `src/client/home/TodayAgenda.tsx`
- `src/client/home/TodayChores.tsx`
- `src/client/home/TodayMeals.tsx`
- `src/client/home/WeatherPill.tsx`
- `src/client/home/agenda-presentation.ts`
- `src/client/home/weatherCache.ts`
- `src/client/home/weatherFormat.ts`
- `src/client/i18n/index.tsx`
- `src/client/i18n/messages.ts`
- `src/client/lib/day-period-labels.ts`
- `src/client/lib/household-date.ts`
- `src/client/lib/householdSettings.tsx`
- `src/client/lib/logger.ts`
- `src/client/lib/recipes.ts`
- `src/client/lib/utils.ts`
- `src/client/meals/MealCell.tsx`
- `src/client/meals/MealEntryDialog.tsx`
- `src/client/meals/MealPlanGrid.tsx`
- `src/client/meals/MealsBoard.tsx`
- `src/client/meals/RecipeCatalogue.tsx`
- `src/client/meals/RecipeDetailDialog.tsx`
- `src/client/meals/RecipeDialog.tsx`
- `src/client/meals/useMealsWorkspace.ts`
- `src/client/meals/useTodayMeals.ts`
- `src/client/plugins/PluginCatalogProvider.tsx`
- `src/client/plugins/PluginHealthIndicator.tsx`
- `src/client/plugins/PluginManagement.tsx`
- `src/client/plugins/PluginUnavailable.tsx`
- `src/client/plugins/contributions.ts`
- `src/client/printing/PrintExecutor.tsx`
- `src/client/printing/PrinterAttention.tsx`
- `src/client/printing/PrinterSession.tsx`
- `src/client/printing/pluginStatus.ts`
- `src/client/printing/queueWakeup.ts`
- `src/client/printing/transport.ts`
- `src/client/shell/DensityControl.tsx`
- `src/client/shell/HouseholdChrome.tsx`
- `src/client/shell/Shell.tsx`
- `src/client/shell/densityAttribute.ts`
- `src/client/shell/routes.ts`
- `src/client/shell/usePresentationMode.ts`
- `src/client/time-announcements/events.ts`
- `src/client/time-announcements/phrases.ts`
- `src/client/time-announcements/seams.ts`
- `src/client/time-announcements/speech.ts`
- `src/server/app.ts`
- `src/server/backups/job.ts`
- `src/server/backups/restore.ts`
- `src/server/backups/storage.ts`
- `src/server/db/client.ts`
- `src/server/db/migrate.ts`
- `src/server/db/schema.ts`
- `src/server/host-api/index.ts`
- `src/server/index.ts`
- `src/server/lib/event-bus.ts`
- `src/server/lib/household-date.ts`
- `src/server/lib/settings-objects.ts`
- `src/server/modules/calendar/external-sources.ts`
- `src/server/modules/calendar/fetch-ics.ts`
- `src/server/modules/calendar/highlights.ts`
- `src/server/modules/calendar/index.ts`
- `src/server/modules/calendar/job.ts`
- `src/server/modules/calendar/parse-ics.ts`
- `src/server/modules/calendar/reconcile.ts`
- `src/server/modules/calendar/recurrence.ts`
- `src/server/modules/calendar/sync-coordinator.ts`
- `src/server/modules/daily-briefing/blocks/animal-fact.ts`
- `src/server/modules/daily-briefing/blocks/birthday.ts`
- `src/server/modules/daily-briefing/blocks/context.ts`
- `src/server/modules/daily-briefing/blocks/dad-joke.ts`
- `src/server/modules/daily-briefing/blocks/drawing-prompt.ts`
- `src/server/modules/daily-briefing/blocks/meals.ts`
- `src/server/modules/daily-briefing/blocks/message.ts`
- `src/server/modules/daily-briefing/blocks/number-fact.ts`
- `src/server/modules/daily-briefing/blocks/reminders.ts`
- `src/server/modules/daily-briefing/blocks/riddle.ts`
- `src/server/modules/daily-briefing/blocks/shotgun.ts`
- `src/server/modules/daily-briefing/blocks/streak-text.ts`
- `src/server/modules/daily-briefing/blocks/streak.ts`
- `src/server/modules/daily-briefing/blocks/today.ts`
- `src/server/modules/daily-briefing/blocks/trivia.ts`
- `src/server/modules/daily-briefing/blocks/weather.ts`
- `src/server/modules/daily-briefing/blocks/weatherText.ts`
- `src/server/modules/daily-briefing/blocks/word-of-day.ts`
- `src/server/modules/daily-briefing/blocks/word-search-placement.ts`
- `src/server/modules/daily-briefing/blocks/word-search.ts`
- `src/server/modules/daily-briefing/blocks/would-you-rather.ts`
- `src/server/modules/daily-briefing/corpora/animal-facts.es.json`
- `src/server/modules/daily-briefing/corpora/animal-facts.json`
- `src/server/modules/daily-briefing/corpora/block-types.ts`
- `src/server/modules/daily-briefing/corpora/determinism.ts`
- `src/server/modules/daily-briefing/corpora/drawing-prompts.es.json`
- `src/server/modules/daily-briefing/corpora/drawing-prompts.json`
- `src/server/modules/daily-briefing/corpora/index.ts`
- `src/server/modules/daily-briefing/corpora/jokes.json`
- `src/server/modules/daily-briefing/corpora/loader.ts`
- `src/server/modules/daily-briefing/corpora/number-facts.es.json`
- `src/server/modules/daily-briefing/corpora/number-facts.json`
- `src/server/modules/daily-briefing/corpora/riddles.json`
- `src/server/modules/daily-briefing/corpora/trivia-questions.json`
- `src/server/modules/daily-briefing/corpora/types.ts`
- `src/server/modules/daily-briefing/corpora/vocabulary-entries.json`
- `src/server/modules/daily-briefing/corpora/word-search-corpus.json`
- `src/server/modules/daily-briefing/corpora/would-you-rathers.es.json`
- `src/server/modules/daily-briefing/corpora/would-you-rathers.json`
- `src/server/modules/daily-briefing/errors.ts`
- `src/server/modules/daily-briefing/external/ports.ts`
- `src/server/modules/daily-briefing/external/shared-cache.ts`
- `src/server/modules/daily-briefing/index.ts`
- `src/server/modules/daily-briefing/job.ts`
- `src/server/modules/daily-briefing/render/adapter.ts`
- `src/server/modules/daily-briefing/render/blocks/animal-fact.ts`
- `src/server/modules/daily-briefing/render/blocks/birthday.ts`
- `src/server/modules/daily-briefing/render/blocks/dad-joke.ts`
- `src/server/modules/daily-briefing/render/blocks/drawing-prompt.ts`
- `src/server/modules/daily-briefing/render/blocks/meals.ts`
- `src/server/modules/daily-briefing/render/blocks/message.ts`
- `src/server/modules/daily-briefing/render/blocks/number-fact.ts`
- `src/server/modules/daily-briefing/render/blocks/on-this-day.ts`
- `src/server/modules/daily-briefing/render/blocks/quote-of-day.ts`
- `src/server/modules/daily-briefing/render/blocks/reminders.ts`
- `src/server/modules/daily-briefing/render/blocks/riddle.ts`
- `src/server/modules/daily-briefing/render/blocks/shotgun.ts`
- `src/server/modules/daily-briefing/render/blocks/streak-text.ts`
- `src/server/modules/daily-briefing/render/blocks/streak.ts`
- `src/server/modules/daily-briefing/render/blocks/today.ts`
- `src/server/modules/daily-briefing/render/blocks/trivia.ts`
- `src/server/modules/daily-briefing/render/blocks/weather-text.ts`
- `src/server/modules/daily-briefing/render/blocks/weather.ts`
- `src/server/modules/daily-briefing/render/blocks/word-of-day.ts`
- `src/server/modules/daily-briefing/render/blocks/word-search.ts`
- `src/server/modules/daily-briefing/render/blocks/would-you-rather.ts`
- `src/server/modules/daily-briefing/render/bridge.ts`
- `src/server/modules/daily-briefing/render/index.ts`
- `src/server/modules/daily-briefing/render/labels.ts`
- `src/server/modules/daily-briefing/render/raster.ts`
- `src/server/modules/daily-briefing/render/registry.ts`
- `src/server/modules/daily-briefing/render/theme.ts`
- `src/server/modules/daily-briefing/render/types.ts`
- `src/server/modules/daily-briefing/settings.ts`
- `src/server/modules/daily-briefing/trigger.ts`
- `src/server/modules/daily-messages/index.ts`
- `src/server/modules/day-periods/index.ts`
- `src/server/modules/meals/index.ts`
- `src/server/modules/members/birthdate.ts`
- `src/server/modules/members/index.ts`
- `src/server/modules/members/label.ts`
- `src/server/modules/members/referential.ts`
- `src/server/modules/network-devices/cache.ts`
- `src/server/modules/network-devices/client.ts`
- `src/server/modules/network-devices/index.ts`
- `src/server/modules/network-devices/normalize.ts`
- `src/server/modules/network-devices/poll.ts`
- `src/server/modules/printing/artifact.ts`
- `src/server/modules/printing/escpos.ts`
- `src/server/modules/printing/index.ts`
- `src/server/modules/reminders/index.ts`
- `src/server/modules/routines/index.ts`
- `src/server/modules/settings/index.ts`
- `src/server/modules/time-announcements/index.ts`
- `src/server/modules/weather/index.ts`
- `src/server/modules/weather/normalize.ts`
- `src/server/modules/weather/port.ts`
- `src/server/plugins/errors.ts`
- `src/server/plugins/http.ts`
- `src/server/plugins/lifecycle.ts`
- `src/server/plugins/manifest.ts`
- `src/server/plugins/routes.ts`
- `src/server/plugins/runtime.ts`
- `src/server/plugins/store.ts`
- `src/server/routes/backups.ts`
- `src/server/routes/calendar.ts`
- `src/server/routes/daily-briefing.ts`
- `src/server/routes/daily-messages.ts`
- `src/server/routes/day-periods.ts`
- `src/server/routes/health.ts`
- `src/server/routes/meals.ts`
- `src/server/routes/members.ts`
- `src/server/routes/network-devices.ts`
- `src/server/routes/printing.ts`
- `src/server/routes/reminders.ts`
- `src/server/routes/routines.ts`
- `src/server/routes/settings.ts`
- `src/server/routes/telemetry.ts`
- `src/server/routes/time-announcements.ts`
- `src/server/routes/weather.ts`
- `src/server/scheduler/index.ts`
- `src/server/telemetry/index.ts`
- `src/server/telemetry/job.ts`
- `src/server/telemetry/redact.ts`
- `src/server/telemetry/sink.ts`
- `src/shared/dailyBriefing.ts`
- `src/shared/dayPeriods.ts`
- `src/shared/events.ts`
- `src/shared/householdTime.ts`
- `src/shared/index.ts`
- `src/shared/member-color.ts`
- `src/shared/networkDevices.ts`
- `src/shared/plugins.ts`
- `src/shared/printing.ts`
- `src/shared/weather.ts`
- `tests/client/helpers/density.ts`
- `tests/client/helpers/densityStyles.ts`
- `tests/e2e/global-setup.ts`
- `tests/e2e/global-teardown.ts`
- `tests/e2e/plugin-fixture-db.ts`
- `tests/e2e/prepare-shared-db.ts`
- `tests/e2e/quote-onthisday-fixture-server.ts`
- `tests/e2e/weather-fixture-server.ts`
- `tests/fixtures/assembly-cohort.json`
- `tests/fixtures/calendar/adapter-defaults.ics`
- `tests/fixtures/calendar/adapter-isolation.ics`
- `tests/fixtures/calendar/adapter-window.ics`
- `tests/fixtures/calendar/all-day-range.ics`
- `tests/fixtures/calendar/invalid-whole-calendar.ics`
- `tests/fixtures/calendar/malformed-individual.ics`
- `tests/fixtures/calendar/recurrence-matrix.ics`
- `tests/fixtures/calendar/tracer.ics`
- `tests/fixtures/plugin-lifecycle/fresh-empty.sql`
- `tests/fixtures/plugin-lifecycle/migrated-fresh.sql`
- `tests/fixtures/plugin-lifecycle/migrated-prior.sql`
- `tests/fixtures/plugin-lifecycle/prior-baseline.sql`
- `tests/fixtures/plugin-lifecycle/unsupported-history.sql`
- `tests/helpers/calendar-process.ts`
- `tests/helpers/daily-briefing-seed.ts`
- `tests/helpers/db.ts`
- `tests/helpers/fake-clock.ts`
- `tests/helpers/schema-tables.ts`
- `tests/helpers/self-signed-tls-fixture.ts`
- `tests/helpers/unifi-fixtures.ts`
- `tests/helpers/weather-fixtures.ts`
- `tools/dev/count-ui-debt.mjs`
- `tools/e2e-data-dir.mjs`
- `vitest.config.ts`
- `vitest.setup.ts`

## Focused execution

Run from an isolated checkout of the reviewed candidate with synthetic configuration. Confirm runner discovery and execute every relevant runtime case. Tests listed below include shared cases that may require companion fixtures from this step's owned list.

```sh
npm exec -- vitest run \
  tests/boundary/access-gate.test.ts \
  tests/boundary/auth-boundary.test.ts \
  tests/boundary/auth-throttling.test.ts \
  tests/boundary/bootstrap-reconcile.test.ts \
  tests/boundary/credentials.test.ts \
  tests/boundary/encoding-bypass.test.ts \
  tests/boundary/fail-closed.test.ts \
  tests/boundary/key-lifecycle.test.ts \
  tests/boundary/member-admin-gate.test.ts \
  tests/boundary/no-session.test.ts \
  tests/boundary/provision.test.ts \
  tests/boundary/verify-pin.test.ts \
  tests/client/admin-gate-no-boot-probe.test.tsx \
  tests/client/admin-gate-panel-reset.test.tsx \
  tests/client/admin-gate-printing-nav.test.tsx \
  tests/client/admin-gate.test.tsx \
  tests/client/admin-pin-keypad.test.tsx \
  tests/client/credential.test.ts \
  tests/client/provisioning-gate.test.tsx \
  tests/integration/bootstrap-provision.test.ts \
  tests/integration/provision-then-settings.test.ts
```

```sh
npm exec -- playwright test \
  tests/e2e/admin-unlock-resilience.spec.ts
```

## Findings and evidence record


**Candidate:** `525a95458a9b8cbaab187717a4a66fd3f9002ea6` (+ review dirty tree). See `evidence/02-candidate.txt`.

**Commands / results**

- Owned vitest 21 files: **170 passed** — `evidence/02-vitest.log`
- Bootstrap-reconcile after F1 (8 tests): **pass** — `evidence/02-f1-smoke.log`
- Playwright unlock resilience: **2 passed** — `evidence/02-playwright.log`
- UI screenshots: `evidence/02-ui/`

**Repairs / docs:** naming; SECURITY private reporting; ADR-013 set-pin A; ADR-060 AC; F1 reconcile exact-expiry; F2 / INV-05 / key-mgmt household calibrations (contract, feature, operations); comment hygiene.

**Accepted dispositions:** no key-mgmt API this release; Bearer only on `/api/plugins*`; device `*` = full feature access; F3–F5, C2–C3 as in `evidence/02-findings.md`.

**Operator follow-up:** enable GitHub Private vulnerability reporting on the published repository.

**Critical auth defects:** none.

**Verdict: pass** with accepted dispositions. Owned files inspected; remaining items are explicit product/release choices.
