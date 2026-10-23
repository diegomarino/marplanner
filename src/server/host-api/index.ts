/** Public host surface for first-party plugins: domain reads, dates, settings,
 * persistence, telemetry, events and scheduler operations. The import boundary is
 * enforced by ESLint. This is not a security sandbox: getDb exposes the shared
 * SQLite connection, as documented in ADR-039.
 */
export {
  isActiveMember,
  assertActiveMember,
  memberExists,
  listActiveMembers,
  MemberReferenceError,
} from "../modules/members/referential";
export { resolveMemberLabel } from "../modules/members/label";
/** Daily-messages read seam (sibling — `blocks/message.ts`'s * host-api-barrel gap, closed here): the "message" block generator needs a per-member per-date
 * message read, previously held behind an injectable port pending this export
 * (`modules/daily-briefing/blocks/message.ts`'s module doc). `DailyMessageNotFoundError` is
 * re-exported so a caller can distinguish "member does not exist" (throws) from "no message
 * today" (resolves `null`) without reaching into `modules/daily-messages` directly (Rule B).
 */
export { getMessage, DailyMessageNotFoundError } from "../modules/daily-messages/index";
export { getEvents, WindowError } from "../modules/calendar/index";
export type { CalendarReadContext, GetEventsParams } from "../modules/calendar/index";
export { getReminders } from "../modules/reminders/index";
export { getBoard } from "../modules/routines/index";
export { getMenu } from "../modules/meals/index";
/** Weather read seam — the daily-briefing plugin resolves the
 * household's location + forecast port through this barrel, exactly like every other
 * cross-plugin read above; `modules/weather/* ` itself may only import its own subtree +
 * this barrel (eslint.config.mjs zone), never the other direction.
 */
export { readWeatherLocation } from "../modules/weather/index";
export { getForecastPort } from "../modules/weather/port";
export {
  isStrictCalendarDate,
  weekdayOf,
  readHouseholdTimezone,
  readWeekStartDay,
  todayInHouseholdTz,
} from "../lib/household-date";
/** Generic named-settings-object read seam — the daily-briefing plugin's own
 * `daily-briefing` settings row (not part of the `locale`/`weather` app-settings registry,
 * `routes/settings.ts`) is read through this rather than a raw SQL query inside
 * `src/server/modules/* ` (ADR-039 Rule B / INV-07).
 */
export { readSettingsObject } from "../lib/settings-objects";
export { readEffectiveSettings } from "../modules/settings";
export { getDb } from "../db/client";
export { emit } from "../lib/event-bus";
/** Producer-subscribe seam ( ADR-040 "producer-subscribes"): the event
 * bus has always implemented `subscribe` (../lib/event-bus.ts) — until now, only `emit` was
 * exported through this barrel, so no PLUGIN module could actually subscribe (Rule B forbids a
 * direct `../lib/event-bus` import). Daily Briefing's wakeup-hint trigger
 * (`routines.completion_changed`) is this seam's first production subscriber; see
 * tests/boundary/host-api-subscribe.test.ts for the boundary proof (a plugin-zone module
 * subscribes through this barrel and receives a post-commit event via the REAL bus).
 */
export { subscribe } from "../lib/event-bus";
/** Printing producer seam ( ADR-041/ADR-022): a producer registers
 * its artifact provider and enqueues durable print jobs through this SAME seam the test-printable
 * trigger itself uses — `enqueuePrintJob` is producer-agnostic (FR-001), `registerPrintableProvider`
 * is the fetch-at-execute resolution point (Printing never stores a raster), and
 * `supersedePrintRecord` invalidates a stale print record on regeneration (cancels pending +
 * claimed-not-yet-fetched jobs; fetched-in-flight jobs continue — H2/ADR-022). 019 is this seam's
 * first real consumer.
 * `hasTerminalFailedJob`: a minimal SELECT-only gate
 * a level-triggered producer (daily-briefing's auto-print trigger) uses to stop re-enqueuing a
 * dead-lettered job on every sweep — `enqueuePrintJob` itself stays fully permissive (the admin
 * manual-retry remedy after dead-letter must remain reachable); see the function's own doc
 * comment in `modules/printing/index.ts` for the full rationale.
 * `supersedePrintRecordTxn` ( fold): the
 * transaction-composable variant of `supersedePrintRecord` — a caller building its OWN write
 * transaction (daily-briefing's regeneration) calls this DIRECTLY from inside that transaction so
 * the snapshot replacement and the supersede commit/rollback together (FR-003). `getPrintRecordStatus`
 * is the minimal SELECT-only read daily-briefing's printed-status derivation needs at read time
 * (D11's read-time fallback, FR-005/AC-04) — see each function's own doc comment in
 * `modules/printing/index.ts` for the full rationale.
 */
export {
  enqueuePrintJob,
  supersedePrintRecord,
  supersedePrintRecordTxn,
  registerPrintableProvider,
  isPrintingPluginActive,
  hasTerminalFailedJob,
  getPrintRecordStatus,
} from "../modules/printing/index";
export type {
  EnqueuePrintJobParams,
  EnqueuePrintJobResult,
  PrintableRaster,
  PrintableProvider,
  PrintRecordStatus,
} from "../modules/printing/index";
/** Telemetry write choke point (FR-010): lets a future plugin producer log
 * through the same validate->bound->flood-check->redact->insert pipeline the HTTP ingest route
 * uses, without reaching `../telemetry/index` directly. A straight named re-export — unlike
 * `registerJob`/`runJobNow` below, this has no scheduler-singleton indirection to resolve at
 * call time.
 */
export { writeClientLog } from "../telemetry/index";

import { getScheduler } from "../scheduler/index";
import type {
  JobRegistration as SchedulerJobRegistration,
  StopHandle as SchedulerStopHandle,
  RunJobResult as SchedulerRunJobResult,
} from "../scheduler/index";

/** Register a background job on the process-wide scheduler singleton
 * (ADR-014). Delegates to `getScheduler` — the entrypoint
 * (`src/server/index.ts`, core) owns `initScheduler`/`start`/`stop`; this
 * barrel exposes only the registration + manual-run seam a plugin needs.
 */
export function registerJob(reg: SchedulerJobRegistration): SchedulerStopHandle {
  return getScheduler().registerJob(reg);
}

/** Manually trigger a registered job, sharing the same in-flight guard as its scheduled trigger. */
export function runJobNow(id: string, arg?: unknown): Promise<SchedulerRunJobResult> {
  return getScheduler().runJobNow(id, arg);
}

export type { JobRegistration, StopHandle, Trigger, RunJobResult } from "../scheduler/index";

/** Reserved operator (deploy-time) config keys, `<namespace>.<key>` (* PLUGIN-SYSTEM-INV-09) → the environment variable each resolves to. Extend this map when
 * a future plugin needs a deploy knob — e.g. adds `unifi.apiKey` / `unifi.consoleId`
 * / `unifi.siteId` here, consuming the SAME accessor and the SAME `process.env` ban below.
 * (ADR-053 §1): the network-devices controller client
 * (`modules/network-devices/client.ts`) is the SOLE reader of these `unifi.*` keys — `apiKey`/
 * `siteId` unset (or NEITHER `host` nor `consoleId` set) means "controller unconfigured", a
 * NORMAL state (never conflated with a set-but-rejected credential, a distinct error state the
 * client itself reports).
 * Architect update 2026-09-05 (maintainer-supplied real UniFi docs, the maintainer's UniFi homelab notes,
 * read-only reference): `unifi.host` + `unifi.tlsInsecure` added — the household's PROVEN path
 * is the LOCAL Integration API v1 (`docs/access.md` "API Local (Integration API v1)": "Para
 * scripts en LAN (este repo), usar siempre la API local directamente" — marplanner itself runs
 * on-LAN), reached via a bare host/IP (e.g. `192.168.1.1`) rather than the cloud console. The
 * local controller's cert is self-signed (every doc example uses `curl -sk`) — `tlsInsecure` is
 * the operator's explicit, opt-in acknowledgment of that (never inferred).
 */
const OPERATOR_CONFIG_ENV: Record<string, string> = {
  "weather.endpoint": "WEATHER_ENDPOINT",
  "weather.enabled": "WEATHER_ENABLED",
  // (the WEATHER_ENDPOINT precedent): the same deploy-time-override seam,
  // extended to the two `daily-briefing` external ports (`modules/daily-briefing/external/
  // ports.ts`) that otherwise always hit the real zenquotes.io / *.wikipedia.org hosts — an
  // e2e run's built `npm start` process is not `isTestRuntime`, so without an override those
  // adapters perform genuine, uncontrolled egress under Playwright (unlike weather, which
  // already had this seam). Keys are module-scoped (`dailyBriefing.*`), matching every other
  // key here (`weather.*`, `unifi.*`) — a bare `quote.*`/`onThisDay.*` would collide with a
  // future module also owning a "quote" or "onThisDay" concept. The
  // env var NAMES stay exactly as-is (already baked into playwright.config.ts).
  "dailyBriefing.quoteEndpoint": "QUOTE_ENDPOINT",
  "dailyBriefing.onThisDayEndpoint": "ONTHISDAY_ENDPOINT",
  "unifi.apiKey": "UNIFI_API_KEY",
  "unifi.consoleId": "UNIFI_CONSOLE_ID",
  "unifi.siteId": "UNIFI_SITE_ID",
  "unifi.host": "UNIFI_HOST",
  "unifi.tlsInsecure": "UNIFI_TLS_INSECURE",
};

/** Read-only operator (deploy-time) configuration accessor (ADR-053 §1,
 * PLUGIN-SYSTEM-INV-09) — the ONLY way a plugin module may observe an environment
 * variable; `eslint.config.mjs` bans a direct `process.env` read anywhere under
 * `src/server/modules/* ` (this barrel lives OUTSIDE that boundary, so it may read
 * `process.env` directly here). Absent-safe: an unset OR unrecognized key returns
 * `undefined`, never throws. NEVER logs the resolved value — deploy secrets/URLs read
 * through this seam must not reach any log sink.
 */
export function getOperatorConfig(key: string): string | undefined {
  const envName = OPERATOR_CONFIG_ENV[key];
  if (!envName) return undefined;
  return process.env[envName];
}

/** Test-runtime signal — a SEPARATE, single-purpose
 * `process.env` read from `getOperatorConfig` above: it answers "is this the test runner?",
 * never a deploy-time value, and nothing it returns is ever household- or operator-supplied
 * config. The `openMeteoPort` factory (`modules/weather/port.ts`) uses this to refuse
 * constructing a REAL fetch-based port while running under vitest, throwing immediately
 * instead of letting a forgotten `__setForecastPortForTests` injection fall through to a real
 * (CI-forbidden) network call that would otherwise just hang toward the test timeout — the
 * plugin-namespace `process.env` ban is exactly why this lives here, outside
 * `src/server/modules/* `, rather than as an inline read inside the port module.
 */
export function isTestRuntime(): boolean {
  return process.env.VITEST === "true";
}
