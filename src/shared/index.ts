import type { BriefingStatus } from "./dailyBriefing.js";
import type { WeekdayCode } from "./householdTime.js";
import type { WeatherSettingsObject } from "./weather.js";
import type { LiveCacheState, LiveClient, RegisteredDevice } from "./networkDevices.js";
import type { PrintJobState, DerivedPrintJobState } from "./printing.js";
import type { MemberColorKey } from "./member-color.js";

export {
  MEMBER_COLOR_KEYS,
  RETIRED_MEMBER_COLOR_KEYS,
  chooseMemberColorKey,
} from "./member-color.js";
export type { MemberColorKey } from "./member-color.js";

/** Role enum — exactly `parent` | `child`.
 * (`enum: [parent, child]`; `admin` is rejected).
 */
export enum Role {
  parent = "parent",
  child = "child",
}

/** LocaleObject — all three fields always present; defaults fill unset values.
 * Contract: docs/api/bootstrap/openapi.yaml `components/schemas/LocaleObject`
 */
export interface LocaleObject {
  timezone: string;
  language: string;
  weekStartDay: number;
}

// ─── API contract types (direct mapping of openapi.yaml schemas) ──────────────

/** Health response schema.
 * Contract: docs/api/bootstrap/openapi.yaml `components/schemas/Health`
 */
export interface Health {
  status: "ok";
}

/** ProvisionResult — success body carries NO raw key.
 * Contract: docs/api/bootstrap/openapi.yaml `components/schemas/ProvisionResult`
 */
export interface ProvisionResult {
  provisioned: true;
}

/** Effective settings returned by the settings registry. Locale is always
 * present. Plugin-owned objects appear only while their plugin is active;
 * each present object fills unset fields from its defaults. The corresponding
 * B0 HTTP contract is in docs/api/bootstrap/openapi.yaml.
 */
export interface EffectiveSettings {
  locale: LocaleObject;
  /** Present when the weather adapter is installed and active. */
  weather?: WeatherSettingsObject;
  printer?: PrinterSettings;
  printerTransport?: PrinterTransportSettings;
}

export interface PrinterSettings {
  paperWidthDots: number;
}

export interface PrinterTransportSettings {
  deviceId: string;
  name: string;
  serviceUuid: string;
  characteristicUuid: string;
}

/** VerifyPinRequest payload.
 * Contract: docs/api/bootstrap/openapi.yaml `components/schemas/VerifyPinRequest`
 */
export interface VerifyPinRequest {
  pin: string;
}

/** VerifyPinResult — advisory only, no session created.
 * Contract: docs/api/bootstrap/openapi.yaml `components/schemas/VerifyPinResult`
 */
export interface VerifyPinResult {
  match: boolean;
}

/** CreateMemberRequest — required `displayName` and `role`, optional `birthDate`.
 */
export interface CreateMemberRequest {
  displayName: string;
  role: Role;
  colorKey?: MemberColorKey;
  birthDate?: { month: number; day: number; year: number | null } | null;
}

/** Member — full member record as returned by the API.
 */
export interface Member {
  id: string;
  displayName: string;
  colorKey: MemberColorKey;
  role: Role;
  lifecycle: "active" | "archived";
  createdAt: number;
  updatedAt: number;
  birthDate?: { month: number; day: number; year: number | null } | null;
}

/** Error body — never contains `mpk-`/`mpg-` values or raw PINs.
 * Contract: docs/api/bootstrap/openapi.yaml `components/schemas/Error`
 */
export interface Error {
  error: string;
  message?: string;
}

/** MemberDTO — the domain-facing member shape used by application code.
 * Mirrors the `Member` API shape but uses the `Role` enum instead of a bare
 * string for `role`, and adds `updatedAt` from `members.updated_at` (epoch ms).
 */
export interface MemberDTO {
  id: string;
  displayName: string;
  colorKey: MemberColorKey;
  role: Role;
  lifecycle: "active" | "archived";
  createdAt: number;
  updatedAt: number;
  birthDate?: { month: number; day: number; year: number | null } | null;
}

// ─── Day Periods DTOs ───────────────────────────────────────

/** PeriodId — the four fixed period slugs.
 * Values are morning, afternoon, evening and night.
 */
export type PeriodId = "morning" | "afternoon" | "evening" | "night";

/** Weekday — the seven canonical day codes.
 * Values are the seven `mon` through `sun` day codes.
 */
export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

/** DayPeriodDTO — a day period as returned by the API.
 * Carries `id`, `labelKey`, `start` and `sortOrder`.
 */
export interface DayPeriodDTO {
  id: PeriodId;
  labelKey: string;
  start: string;
  sortOrder: number;
}

/** EditStartRequest — PATCH body for editing a period start boundary.
 * Carries the new `start` boundary.
 */
export interface EditStartRequest {
  start: string;
}

/** ActivePeriodResult — the active period now, determined server-authoritative.
 * Carries the `activeId`.
 */
export interface ActivePeriodResult {
  activeId: PeriodId;
}

// ─── Calendar DTOs ──────────────────────────────────────────

/** EventInput — create/edit payload for a local event master. Exactly one date
 * shape by `allDay`: all-day uses `startDate`/`endDate` (half-open); timed uses
 * `startUtc`/`endUtc` + `tzid` (ADR-062). Optional `rrule`/`exdates` make it
 * recurring. Types only — write-boundary validation lives in the server module.
 */
export interface EventInput {
  title: string;
  allDay: boolean;
  startDate?: string;
  endDate?: string;
  startUtc?: string;
  endUtc?: string;
  tzid?: string;
  rrule?: string | null;
  exdates?: string[];
  /** Free text; blank or null clears it on edit. */
  description?: string | null;
  location?: string | null;
}

/** FeedItem — one EXPANDED occurrence (not a master) returned by `getEvents`.
 * `occurrenceStart` is an instant (timed) or a `YYYY-MM-DD` (all-day).
 * `decoratedTitle` is derived on Calendar reads; `provider` and `sourceRef` carry
 * external provenance. Stored titles are never rewritten by highlighting.
 */
export interface FeedItem {
  id: string;
  occurrenceStart: string;
  occurrenceEnd?: string;
  source: "local" | "external";
  title: string;
  allDay: boolean;
  tzid?: string | null;
  assignedTo: string[];
  decoratedTitle?: string | null;
  provider?: string | null;
  sourceRef?: string | null;
  /** Plain text: household-authored for a local event, as the feed sent it for an external one.
   * Present only when there is some.
   */
  description?: string;
  location?: string;
}

export type ExternalSourceProvider = "google" | "microsoft" | "apple" | "ics_generic";

export type ExternalSourceErrorCode =
  | "unsafe_url"
  | "unavailable"
  | "timeout"
  | "too_large"
  | "invalid_calendar"
  | "parse_failed"
  | "reconcile_failed";

export type SynchronizationPhase =
  "requesting" | "downloading" | "parsing" | "reconciling" | "succeeded" | "failed";

/** Client-safe Calendar source DTO. The token-bearing feed URL is deliberately absent. */
export interface ExternalSourcePublic {
  id: string;
  name: string;
  provider: ExternalSourceProvider;
  maskedUrl: string;
  enabled: boolean;
  pollIntervalMin: number;
  phase: SynchronizationPhase | null;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastErrorCode: ExternalSourceErrorCode | null;
  consecutiveFailures: number;
  lastImportedCount: number;
  lastSkippedCount: number;
}

export interface HighlightRuleCreate {
  emoji: string;
  keywords: string[];
}

export interface HighlightRulePatch {
  enabled: boolean;
}

export interface HighlightRule extends HighlightRuleCreate {
  id: string;
  enabled: boolean;
  priority: number;
}

export interface HighlightRuleOrder {
  orderedIds: string[];
}

export * from "./events.js";
export { detectCalendarProvider } from "./calendar-provider.js";
export { isSingleEmoji } from "./emoji.js";

/** AssignmentReplace — full replacement set of member ids for an event (atomic
 * replace; each MUST be an active member, FR-006).
 */
export interface AssignmentReplace {
  memberIds: string[];
}

// ─── Routines & Chores DTOs ────────────────────────────────

/** Routine — a named template attached to exactly one day period.
 */
export interface Routine {
  id: string;
  name: string;
  dayPeriodId: string;
  active: boolean;
}

/** RoutineInput — create payload.
 */
export interface RoutineInput {
  name: string;
  dayPeriodId: string;
}

/** RoutineEditInput — edit payload (name and/or active only).
 * (no `required` list — both fields optional).
 */
export interface RoutineEditInput {
  name?: string;
  active?: boolean;
}

/** Chore — a named, ordered task within one routine.
 */
export interface Chore {
  id: string;
  routineId: string;
  name: string;
  icon: string | null;
  sortOrder: number;
  active: boolean;
}

/** ChoreInput — create payload.
 */
export interface ChoreInput {
  name: string;
  icon?: string | null;
}

/** ChoreEditInput — edit payload.
 * (no `required` list — all fields optional).
 */
export interface ChoreEditInput {
  name?: string;
  icon?: string | null;
  routineId?: string;
  active?: boolean;
}

/** ChoreOrderInput — full ordered list of routine's active chore ids.
 */
export interface ChoreOrderInput {
  choreIds: string[];
}

/** Assignment — links one routine to one active child on a set of weekdays.
 */
export interface Assignment {
  id: string;
  memberId: string;
  weekdays: Weekday[];
  active: boolean;
}

/** AssignmentUpsert — upsert payload.
 * (`required: [weekdays]`, `active` has default: true).
 */
export interface AssignmentUpsert {
  weekdays: Weekday[];
  active?: boolean;
}

/** BoardChore — a chore on the daily board.
 */
export interface BoardChore {
  id: string;
  name: string;
  icon: string | null;
  completed: boolean;
}

/** BoardDayPeriod — one of the four fixed periods on a board column.
 * * `id` is typed `PeriodId`, not the wire-level `string` this interface
 * originally declared — `day_periods.id` is schema-enforced at the DB layer
 * (`day_periods_id_check`, drizzle/0003) and `getBoard` (server/modules/routines/index.ts)
 * always sources it from `listDayPeriods`, which already returns `DayPeriodDTO["id"]` (=
 * `PeriodId`). Narrowing here lets a client index a `Record<PeriodId, MessageKey>` label map
 * directly off `id` instead of trusting the server-supplied `labelKey` string with an
 * `as MessageKey` cast (the SC-007 debt this migration removes) — see `ChoresBoard.tsx`.
 */
export interface BoardDayPeriod {
  id: PeriodId;
  labelKey: string;
  chores: BoardChore[];
}

/** BoardColumn — one active child's column on the household board.
 */
export interface BoardColumn {
  memberId: string;
  displayName: string;
  dayPeriods: BoardDayPeriod[];
  streak: number | null;
  todayProgress: { completed: number; total: number } | null;
}

/** CompletionInput — completion/uncompletion payload.
 */
export interface CompletionInput {
  memberId: string;
  date: string;
}
// ─── Scheduled Reminders DTOs ────────────────────────────────

/** ReminderKind — scheduled (006) or calendar_gated (009, query/queryFields-driven).
 */
export type ReminderKind = "scheduled" | "calendar_gated";

/** TargetingMode — the two targeting modes for scheduled reminders.
 */
export type TargetingMode = "apply_to_all" | "specific";

/** ReminderQueryField — allowed calendar fields a calendar_gated rule may match against.
 */
export type ReminderQueryField = "title" | "description" | "location";

/** Reminder — a scheduled or calendar_gated reminder rule as returned by the API.
 * The calendar-gated variant extends the scheduled reminder response shape.
 */
export interface Reminder {
  id: string;
  kind: ReminderKind;
  targetingMode: TargetingMode;
  text: string;
  weekdays: Weekday[] | null;
  query?: string | null;
  queryFields?: ReminderQueryField[] | null;
  active: boolean;
  assignments: ReminderAssignment[];
}

/** ReminderInput — create payload. Discriminated by `kind`: scheduled carries weekdays (no
 * query/queryFields); calendar_gated carries query (+ optional queryFields, defaults to
 * [title,description]) and no weekdays.
 * The calendar-gated variant extends the scheduled create shape.
 */
export interface ReminderInput {
  kind: ReminderKind;
  targetingMode: TargetingMode;
  text: string;
  weekdays?: Weekday[];
  query?: string;
  queryFields?: ReminderQueryField[];
  assignments?: ReminderAssignmentInput[];
}

/** ReminderEditInput — edit payload. Scheduled fields (text/active/weekdays) coexist
 * with calendar_gated query/queryFields edits; omitting queryFields on PATCH preserves the
 * stored value; it is not reset to the create-time default.
 * The calendar-gated variant extends the scheduled edit shape.
 */
export interface ReminderEditInput {
  text?: string;
  weekdays?: Weekday[];
  query?: string;
  queryFields?: ReminderQueryField[];
  active?: boolean;
}

/** ReminderAssignment — links a reminder to one member on a weekday set.
 */
export interface ReminderAssignment {
  id: string;
  memberId: string;
  weekdays: Weekday[];
  active: boolean;
}

/** ReminderAssignmentInput — assignment upsert payload.
 */
export interface ReminderAssignmentInput {
  memberId: string;
  weekdays: Weekday[];
}

/** ReminderAssignmentSetInput — atomic full-set replace payload.
 */
export interface ReminderAssignmentSetInput {
  assignments: ReminderAssignmentInput[];
}

/** ReminderEmission — one emitting reminder for a (member,date) read.
 */
export interface ReminderEmission {
  id: string;
  text: string;
}

/** DryRunReason — the 3 mutually-exclusive reasons a calendar_gated rule would not emit.
 * Precedence: no_assigned_events -> matched_but_unassigned -> query_miss.
 */
export type DryRunReason = "no_assigned_events" | "matched_but_unassigned" | "query_miss";

/** DryRunResult — the verdict of POST /api/reminders/{id}/dry-run: would this calendar_gated
 * rule emit for (memberId, date), and if not, why. `reason` is present iff `wouldEmit` is false.
 */
export interface DryRunResult {
  wouldEmit: boolean;
  reason?: DryRunReason;
}

// ─── Meals & Recipes DTOs ────────────────────────────────────

/** Slot — the four fixed meal slots.
 */
export type Slot = "breakfast" | "lunch" | "snack" | "dinner";

/** Recipe — a named recipe as returned by the API.
 */
export interface Recipe {
  id: string;
  name: string;
  ingredients: string[] | null;
  instructions: string | null;
  slots: Slot[] | null;
  createdAt: number;
  updatedAt: number;
}

/** RecipeInput — create payload.
 */
export interface RecipeInput {
  name: string;
  ingredients?: string[];
  instructions?: string;
  slots?: Slot[];
}

/** RecipeEditInput — edit payload (allow-list name/ingredients/instructions/slots).
 */
export interface RecipeEditInput {
  name?: string;
  ingredients?: string[];
  instructions?: string;
  slots?: Slot[];
}

/** RecipeDependentCounts — split dependent counts, advisory pre-delete (AC-06).
 */
export interface RecipeDependentCounts {
  recurringCount: number;
  oneOffCount: number;
}

/** MealPlan — a named recurring menu template. Deactivate-only (no hard delete).
 */
export interface MealPlan {
  id: string;
  name: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

/** MealPlanInput — create payload.
 */
export interface MealPlanInput {
  name: string;
}

/** MealPlanEditInput — edit payload (allow-list name/active).
 */
export interface MealPlanEditInput {
  name?: string;
  active?: boolean;
}

/** MealEntry — discriminated: recurring (mealPlanId+weekday) | oneoff (date);
 * content recipeId xor note.
 */
export interface MealEntry {
  id: string;
  kind: "recurring" | "oneoff";
  mealPlanId: string | null;
  weekday: Weekday | null;
  date: string | null;
  slot: Slot;
  recipeId: string | null;
  note: string | null;
  createdAt: number;
}

/** MealEntryInput — create payload (recurring | oneoff; recipeId xor note;
 * dual discriminant validated in-module — FR-028).
 */
export interface MealEntryInput {
  kind: "recurring" | "oneoff";
  mealPlanId?: string;
  weekday?: Weekday;
  date?: string;
  slot: Slot;
  recipeId?: string;
  note?: string;
}

/** MealEntryEditInput — content-only edit payload (recipeId xor note); move = delete+re-add.
 */
export interface MealEntryEditInput {
  recipeId?: string;
  note?: string;
}

/** MenuItem — one derived menu entry (no materialized rows — INV-03).
 */
export interface MenuItem {
  entryId: string;
  slot: Slot;
  label: string;
  isTombstone: boolean;
  source: "recurring" | "oneoff";
  recipeId: string | null;
  note: string | null;
}

/** DailyMessage — one message for (memberId, date), stored verbatim.
 */
export interface DailyMessage {
  id: string;
  memberId: string;
  date: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

/** DailyMessageUpsert — create/replace payload (additionalProperties:false, handler-enforced).
 */
export interface DailyMessageUpsert {
  memberId: string;
  date: string;
  text: string;
}

// ─── Daily Briefing DTOs ─────────────────────────────────────

export * from "./dailyBriefing.js";

// ─── Background-Jobs Scheduler DTOs ─────────────────────────

/** GenerateAllResponse — the daily-briefing generate-all response, re-pointed through the
 * scheduler's shared in-flight guard. `already_running` means a same-job run
 * (scheduled, catch-up, or another manual call) is already in flight: the request performed NO
 * generation and produced zero duplicate rows.
 * `GenerateAllResponse` is the manual daily-briefing generation result.
 */
export type GenerateAllResponse =
  | {
      status: "completed";
      count: number;
      generated: Array<{ memberId: string; status: BriefingStatus }>;
    }
  | { status: "already_running" };

// ─── Client Logging / Telemetry DTOs ────────────────────────

/** BuildInfo — the commit a server or client bundle was built from. Any part that could not be
 * determined is null; `builtAt` is null for a server running from source.
 */
export interface BuildInfo {
  sha: string | null;
  subject: string | null;
  builtAt: string | null;
}

/** SystemStatus — what the admin overview shows about the running server. */
export interface SystemStatus {
  status: "ok";
  checkedAt: string;
  build: BuildInfo;
}

/** ClientLogLevel — the four fixed severities.
 */
export type ClientLogLevel = "debug" | "info" | "warn" | "error";

/** ClientLogEntryInput — one producer-side envelope entry (the only shape producers know).
 */
export interface ClientLogEntryInput {
  level: ClientLogLevel;
  component: string;
  message: string;
  data?: unknown;
  eventTime?: number;
}

/** ClientLogBatch — the ingest request body (≤100 entries; over-cap entries dropped+counted).
 */
export interface ClientLogBatch {
  entries: ClientLogEntryInput[];
}

/** ClientLogIngestResult — always HTTP 200 on a parseable body, even when every entry dropped
 * (best-effort at-most-once — the client never needs retry logic).
 */
export interface ClientLogIngestResult {
  accepted: number;
  dropped: number;
}

/** ClientLogRow — one stored, redacted row as returned by the admin read route.
 */
export interface ClientLogRow {
  id: string;
  eventId: string;
  eventTime: number | null;
  receivedAt: number;
  level: ClientLogLevel;
  component: string;
  message: string;
  data: string | null;
}

/** ClientLogPage — a cursor-paged, server-hard-capped (50) admin read result.
 */
export interface ClientLogPage {
  rows: ClientLogRow[];
  nextCursor: string | null;
}

/** TelemetrySinkEnvelope — the external-sink egress projection. EXACTLY five fields; `data` is
 * structurally absent (INV-07 as a compile-time property — a sink can never receive it). The
 * `data?: never` marker isn't just documentation-by-omission: it also rejects a `data`-carrying
 * variable* passed where an envelope is expected (an excess-property check alone only catches
 * object literals, not values assigned through an intermediate variable).
 */
export interface TelemetrySinkEnvelope {
  level: ClientLogLevel;
  component: string;
  message: string;
  receivedAt: number;
  eventId: string;
  data?: never;
}

// ─── Backups & Restore DTOs ─────────────────────────────────

/** BackupType — the four filename-prefix lanes. `scheduled`/`snapshot` share the
 * regular retention lane; `pre-restore` is its own count-only lane; `upload` is exempt from
 * automatic prune entirely.
 */
export type BackupType = "scheduled" | "snapshot" | "pre-restore" | "upload";

/** BackupListItem — one backup file as derived from its filename + a `stat` size read (mtime is
 * NEVER read — BACKUPS-INV-01).
 */
export interface BackupListItem {
  filename: string;
  type: BackupType;
  createdAt: number;
  sizeBytes: number;
}

/** BackupListResponse — the file-derived shelf listing (newest-first) plus the in-memory
 * `dbGeneration` reload stamp and the loud `lastBackupError` surface (BACKUPS-AC-04).
 * `lastPruneError` is the same loud-surface treatment for a
 * prune-loop failure — distinct from `lastBackupError` because a prune failure must never fail
 * (or be conflated with) the snapshot call that triggered it (FR-004).
 */
export interface BackupListResponse {
  backups: BackupListItem[];
  dbGeneration: number;
  lastBackupError: string | null;
  lastPruneError: string | null;
}

/** SnapshotResult — discriminated by `status`; `filename` is REQUIRED on `completed`, absent on
 * `already_running` (the scheduler's shared per-job guard, BACKGROUND-JOBS-SCHEDULER-AC-06).
 */
export type SnapshotResult =
  { status: "completed"; filename: string } | { status: "already_running" };

/** RestoreRequest — typed-filename confirmation payload (BACKUPS-AC-01: mismatch blocks before
 * any side effect).
 */
export interface RestoreRequest {
  filename: string;
  confirmFilename: string;
}

/** BackupErrorCode — the closed error-code union for restore/import/delete/upload failures.
 * `not_found` covers a filename that vanished between list and action
 * (DELETE/download/restore) — the never-trust-the-stale-list case. `swap_failed`
 * covers a WAL/SHM-cleanup or copy/rename failure during the swap step itself
 * (distinct from `migration_failed_rolled_back`, which is specifically a post-swap forward
 * migration failure) — both roll back to the pre-restore snapshot. `rollback_failed`
 * is the double-fault terminal state: the rollback swap itself failed, so the server
 * remains quiesced pending manual recovery — never resurrected onto a database of unknown state.
 * `backup_failed` covers the snapshot route's own write-failure envelope
 * (`POST /api/backups/snapshot`'s 500 body), keeping that response typed.
 */
export type BackupErrorCode =
  | "validation_error"
  | "confirmation_mismatch"
  | "incompatible_backup"
  | "downgrade_rejected"
  | "unsupported_lineage"
  | "restore_in_progress"
  | "snapshot_in_progress"
  | "quiesce_timeout"
  | "pre_restore_failed"
  | "swap_failed"
  | "migration_failed_rolled_back"
  | "rollback_failed"
  | "retention_floor"
  | "protected_pre_restore"
  | "upload_too_large"
  | "backup_failed"
  | "not_found";

/** RestoreResult — success carries `dbGeneration` (the reload stamp) + whether a forward
 * migration ran; failure is one of the closed `BackupErrorCode` envelopes (ADR-017 sequence,
 * FR-006/FR-007/FR-008).
 */
export type RestoreResult =
  | { status: "restored"; dbGeneration: number; migrated: boolean }
  | { status: BackupErrorCode; message?: string };

/** UploadResult — the stored `upload-` prefixed filename.
 */
export interface UploadResult {
  filename: string;
}

// ─── Time Announcements DTOs ────────────────────────────────

/** WeekdayCode — re-exported from the shared timezone math module;
 * it is not re-declared here because these rules reuse the canonical
 * `mon..sun` set the household-timezone math already owns.
 *
 */
export type { WeekdayCode } from "./householdTime.js";

/** TimeAnnouncementRule — a stored announcement rule as returned by the API.
 */
export interface TimeAnnouncementRule {
  id: string;
  time: string;
  weekDays: WeekdayCode[];
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

/** TimeAnnouncementRuleInput — create payload (POST body); PATCH uses the same shape
 * with every field optional.
 * One shared DTO shape serves both create and patch operations.
 */
export interface TimeAnnouncementRuleInput {
  time: string;
  weekDays: WeekdayCode[];
  isActive?: boolean;
}

// ─── Weather DTOs ─────────────────────────────────────────

/** Weather condition/forecast DTOs + the shared WMO code table — re-exported
 * wholesale (dailyBriefing.js precedent above) rather than re-declared here.
 *
 */
export * from "./weather.js";

// ─── Network Devices DTOs ─────────────────────────────────

/** Registry + live-cache DTOs (structurally NO ip field, NETWORK-DEVICES-INV-06)
 * — re-exported wholesale (weather.js precedent above) rather than re-declared here.
 *
 */
export * from "./networkDevices.js";

/** LiveClientsResponse — the picker feed's GET 200 envelope (`/api/network-devices/live-clients`).
 * Declared HERE rather than in `networkDevices.ts` (unlike every other type in that file) so
 * `tools/check-openapi-drift.mjs --shapes` — whose DTO parser scans this file's own source text,
 * not files re-exported wholesale — can match it against the contract's named
 * `LiveClientsResponse` schema instead of silently skipping it.
 */
export interface LiveClientsResponse {
  state: LiveCacheState;
  clients: LiveClient[];
}

/** NetworkDevicesListResponse — the registry list read's GET 200 envelope (ZERO writes, INV-05).
 * Same rationale as `LiveClientsResponse` above for living here instead of `networkDevices.ts`.
 */
export interface NetworkDevicesListResponse {
  devices: RegisteredDevice[];
  cacheState: LiveCacheState;
}

// ─── Printing DTOs ──────────────────────

/** PrintJobState/DerivedPrintJobState/PrintFailureErrorCode/AckRequest/FailRequest — re-exported
 * wholesale (weather.js precedent above) rather than re-declared here; none of these are named
 * `components/schemas` entries (state/derivedState are inline enums on
 * the `PrintJob` schema below, not their own top-level schemas; AckRequest/FailRequest are inline
 * request-body shapes, never `$ref`'d), so `tools/check-openapi-drift.mjs --shapes`'s DTO parser
 * (which scans this file's OWN source text, not files it re-exports wholesale) has nothing to
 * match them against regardless of which file declares them.
 *
 */
export * from "./printing.js";

/** ErrorResponse — the printing contract's own error envelope (distinct from the generic `Error`
 * interface above — different contract, different schema name). Declared here so the shapes
 * scanner — which only reads `export interface`/`export type` blocks literally present in THIS
 * file's source text — can match it against the `ErrorResponse` schema
 * instead of silently skipping it (it was skipped pre-fold: the previous wholesale-only
 * `printing.ts` re-export left the shapes gate silently OFF for every printing schema).
 * `code`: optional machine code —
 * `PrintCapabilityMissingError`'s `printer_capability_missing` (403) and
 * `PrintRenderFailureError`'s `render_failure` (422) are the two error classes this contract maps
 * with one; a plain 400 validation error carries `{error, message}` only (no `code`).
 */
export interface ErrorResponse {
  error: string;
  message?: string;
  code?: string;
}

/** PrintJob — a durable delivery attempt-set as returned by the API. `outputRef` is the
 * producer's artifact reference ONLY — the raster is fetched via the producer's registered
 * interface at execute time (ADR-041/PRINTING-INV-03); it never carries raster bytes.
 * `attempts` counts RECOVERABLE failures only (permanent failures don't increment it). Declared
 * HERE (not printing.ts) for the same shapes-gate-coverage reason as `ErrorResponse` above.
 */
export interface PrintJob {
  id: string;
  recordKey: string;
  outputRef: string;
  targetDate: string;
  memberId: string | null;
  state: PrintJobState;
  derivedState: DerivedPrintJobState;
  attempts: number;
  failureReason: string | null;
  claimedAt: number | null;
  printedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** ClaimResponse — the executor's successful-claim envelope: a fresh, rotated
 * `leaseToken` fences every subsequent payload/ack/fail call against this exact claim. Declared
 * HERE for shapes-gate coverage (see `ErrorResponse` above).
 */
export interface ClaimResponse {
  job: PrintJob;
  leaseToken: string;
  leaseExpiresAt: number;
}

/** JobsListResponse — the admin list read's envelope (SC-003 visibility: derivedState carries
 * dead-letter/retrying). Declared HERE for shapes-gate coverage (see `ErrorResponse` above).
 */
export interface JobsListResponse {
  jobs: PrintJob[];
}

/** TestPrintResponse — the admin trigger's envelope (FR-018; dedup per FR-012).
 * `alreadyPrinted: true` means the dedup anchor (print_records) already carries a
 * `printed_job_id` for this date — no duplicate job was enqueued. Declared HERE for
 * shapes-gate coverage (see `ErrorResponse` above).
 */
export interface TestPrintResponse {
  enqueued: boolean;
  jobId: string | null;
  alreadyPrinted?: boolean;
}

/** CapabilityResponse — `POST /api/printing/capability`'s success envelope (ADR-035, FR-021):
 * the calling session's key is now registered print-capable, so a subsequent `/claim` from the
 * SAME session succeeds. Declared HERE for shapes-gate coverage (see `ErrorResponse` above).
 */
export interface CapabilityResponse {
  registered: boolean;
}

/** PrintingStatusResponse — `GET /api/printing/status`'s envelope: the
 * client-side plugin-state read `PrintExecutor` (kiosk) and `AdminGate`'s printing nav entry
 * both gate their visibility on. Declared HERE for shapes-gate coverage (see `ErrorResponse`
 * above).
 */
export interface PrintingStatusResponse {
  active: boolean;
}

// ─── Auth-layer error codes ──────────────────────────────────────────────

/** Machine-readable `code` values on the cross-cutting auth-layer `Error` response
 * (`src/server/auth/boundary.ts` + `src/server/auth/capability.ts` — the two
 * preHandlers that run in front of every `/api/*` route). These are the ONLY two
 * codes either module ever emits on a 401/403, alongside the existing
 * `{error, message}` shape (additive — `code` was already an optional property on
 * every domain's `Error`/`ErrorResponse` schema).
 * `AUTH_CREDENTIAL_INVALID_CODE` — the device key itself is dead (missing,
 * unrecognized, revoked, or expired): `authFetch` (src/client/lib/credential.ts)
 * clears the stale `mp_provisioned` marker and falls back to the provisioning gate.
 * `AUTH_SCOPE_DENIED_CODE` — the key IS live but this specific request is denied on
 * scope grounds (`requireCapability`'s "not granted" branch, or
 * `requireManagementKey` rejecting a `kind='device'` key). The credential is still
 * good; `authFetch` passes the response through unchanged so the caller's own UI
 * handles it (e.g. NetworkDevicesManagement rendering its own error state instead
 * of the whole kiosk session dying).
 */
export const AUTH_CREDENTIAL_INVALID_CODE = "credential_invalid";
export const AUTH_SCOPE_DENIED_CODE = "scope_denied";
