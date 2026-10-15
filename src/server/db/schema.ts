import {
  sqliteTable,
  text,
  integer,
  blob,
  check,
  unique,
  index,
  primaryKey,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { MEMBER_COLOR_KEYS } from "../../shared/member-color";

/** API Key — the authoritative, in-DB auth state.
 * Active predicate (evaluated per request, not cached):
 * revoked_at IS NULL AND (expires_at IS NULL OR expires_at >:now)
 */
export const apiKeys = sqliteTable(
  "api_keys",
  {
    /** UUIDv4 */
    id: text("id").primaryKey(),
    /** SHA-256 hex of the full `mpk-…` key; the raw key is never stored */
    keyHash: text("key_hash").notNull().unique(),
    /** `'*'` this module; scoped `domain:verb` keys deferred */
    scope: text("scope").notNull().default("*"),
    /** CHECK in ('device', 'integration', 'bootstrap') — this module mints 'device' */
    kind: text("kind").notNull(),
    /** optional human label */
    label: text("label"),
    /** epoch ms */
    createdAt: integer("created_at").notNull(),
    /** NULL = no expiry (device * key) */
    expiresAt: integer("expires_at"),
    /** set on revocation */
    revokedAt: integer("revoked_at"),
  },
  (table) => ({
    kindCheck: check(
      "api_keys_kind_check",
      sql`${table.kind} IN ('device', 'integration', 'bootstrap')`
    ),
  })
);

/** Member — the household referential root. Archive-only (no hard delete).
 */
export const members = sqliteTable(
  "members",
  {
    /** UUIDv4 */
    id: text("id").primaryKey(),
    /** required, non-blank */
    displayName: text("display_name").notNull(),
    /** Curated on-screen identity; raw inserts may omit the key. */
    colorKey: text("color_key", { enum: MEMBER_COLOR_KEYS }).notNull().default("blue"),
    /** `admin` is structurally impossible */
    role: text("role").notNull(),
    /** new members are 'active'; archive transitions deferred */
    lifecycle: text("lifecycle").notNull().default("active"),
    /** epoch ms */
    createdAt: integer("created_at").notNull(),
    /** epoch ms */
    updatedAt: integer("updated_at").notNull(),
    /** birth date, optional; year may be null */
    birthMonth: integer("birth_month"),
    birthDay: integer("birth_day"),
    birthYear: integer("birth_year"),
  },
  (table) => ({
    displayNameCheck: check(
      "members_display_name_check",
      sql`length(trim(${table.displayName})) > 0`
    ),
    roleCheck: check("members_role_check", sql`${table.role} IN ('parent', 'child')`),
    colorKeyCheck: check(
      "members_color_key_check",
      sql`${table.colorKey} IN ('blue', 'sky', 'teal', 'green', 'lime', 'amber', 'orange', 'red', 'pink', 'violet')`
    ),
    lifecycleCheck: check(
      "members_lifecycle_check",
      sql`${table.lifecycle} IN ('active', 'archived')`
    ),
  })
);

/** Settings Object — per-object persisted settings, written and validated as a unit.
 * `locale` core object (seeded on fresh setup):
 * timezone TEXT (IANA) DEFAULT 'Europe/Madrid'
 * language TEXT DEFAULT 'en'
 * weekStartDay INTEGER (1-7) DEFAULT 1
 */
export const settingsObjects = sqliteTable("settings_objects", {
  /** PK — e.g. 'locale' */
  objectName: text("object_name").primaryKey(),
  /** JSON of persisted fields for the object (may be partial) */
  data: text("data").notNull(),
  /** epoch ms */
  updatedAt: integer("updated_at").notNull(),
});

/** Admin Config — single-row holder of the advisory admin-PIN verifier.
 * Seeded at provisioning from `ADMIN_PIN` (or a documented default).
 * `verify-pin` compares and returns `{ match }` only — advisory, no session row.
 */
export const adminConfig = sqliteTable(
  "admin_config",
  {
    /** single-row guard */
    id: integer("id").primaryKey(),
    /** argon2id/scrypt hash; raw PIN never stored or returned */
    pinHash: text("pin_hash").notNull(),
    /** epoch ms */
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    idCheck: check("admin_config_id_check", sql`${table.id} = 1`),
  })
);

/** Day Periods — the four fixed time-of-day vocabulary slots (ADR-011 defaults).
 * Seed: morning=05:00/300, afternoon=12:00/720, evening=18:00/1080, night=21:00/1260.
 * No insert/delete/merge/reorder operations — the four periods are fixed (INV-01, AC-01).
 */
export const dayPeriods = sqliteTable(
  "day_periods",
  {
    id: text("id").primaryKey().notNull(),
    labelKey: text("label_key").notNull(),
    startMinutes: integer("start_minutes").notNull(),
    sortOrder: integer("sort_order").notNull(),
  },
  (table) => ({
    idCheck: check(
      "day_periods_id_check",
      sql`${table.id} IN ('morning','afternoon','evening','night')`
    ),
    startMinutesCheck: check(
      "day_periods_start_minutes_check",
      sql`${table.startMinutes} BETWEEN 0 AND 1439`
    ),
    sortOrderCheck: check("day_periods_sort_order_check", sql`${table.sortOrder} BETWEEN 0 AND 3`),
  })
);

/** Seed profile state — tooling metadata for an explicitly selected disposable demo profile.
 * It is not household content: the seed ownership seam verifies the full owned-record inventory
 * on every run. The marker records whether an interrupted run may be repaired or every selected
 * module has completed for one strict household-local calendar date.
 */
export const seedProfileState = sqliteTable(
  "seed_profile_state",
  {
    profile: text("profile").primaryKey(),
    version: integer("version").notNull(),
    asOfDate: text("as_of_date").notNull(),
    status: text("status").notNull(),
    startedAt: integer("started_at").notNull(),
    completedAt: integer("completed_at"),
  },
  (table) => ({
    versionCheck: check("seed_profile_state_version_check", sql`${table.version} > 0`),
    asOfDateShapeCheck: check(
      "seed_profile_state_as_of_date_shape_check",
      sql`${table.asOfDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`
    ),
    statusCheck: check(
      "seed_profile_state_status_check",
      sql`${table.status} IN ('running', 'complete')`
    ),
    completionCheck: check(
      "seed_profile_state_completion_check",
      sql`(${table.status} = 'running' AND ${table.completedAt} IS NULL) OR (${table.status} = 'complete' AND ${table.completedAt} IS NOT NULL)`
    ),
  })
);

/** Calendar events — the event master (single occurrence or recurring series).
 * Two date shapes are mutually exclusive:
 * - All-day: start_date/end_date (YYYY-MM-DD, half-open, end > start)
 * - Timed: start_utc/end_utc (ISO instant) + tzid (IANA)
 * Per ADR-062, timed events store UTC instant + originating TZID for DST-correct recurrence.
 */
export const calendarEvents = sqliteTable(
  "calendar_events",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    title: text("title").notNull(),
    allDay: integer("all_day").notNull(),
    startDate: text("start_date"),
    endDate: text("end_date"),
    startUtc: text("start_utc"),
    endUtc: text("end_utc"),
    tzid: text("tzid"),
    rrule: text("rrule"),
    exdates: text("exdates").notNull().default("[]"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    // Household-authored text for local events; imported text lives in the external meta row.
    description: text("description"),
    location: text("location"),
  },
  (table) => ({
    sourceCheck: check(
      "calendar_events_source_check",
      sql`${table.source} IN ('local', 'external')`
    ),
    allDayCheck: check("calendar_events_all_day_check", sql`${table.allDay} IN (0, 1)`),
    mutuallyExclusiveDates: check(
      "calendar_events_dates_check",
      sql`(
        (
          ${table.allDay} = 1
          AND ${table.startDate} IS NOT NULL
          AND ${table.endDate} IS NOT NULL
          AND ${table.startUtc} IS NULL
          AND ${table.endUtc} IS NULL
          AND ${table.tzid} IS NULL
        )
        OR (
          ${table.allDay} = 0
          AND ${table.startDate} IS NULL
          AND ${table.endDate} IS NULL
          AND ${table.startUtc} IS NOT NULL
          AND ${table.endUtc} IS NOT NULL
          AND ${table.tzid} IS NOT NULL
        )
      )`
    ),
  })
);

/** Calendar external sources — persisted subscription configuration only.
 * A row never represents a successful request, parsed feed, synchronized state, or materialized
 * external event. The Calendar write seam validates the raw URL before it reaches this table and
 * public reads expose its masked representation only.
 */
export const calendarExternalSources = sqliteTable(
  "calendar_external_sources",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    provider: text("provider").notNull(),
    feedUrl: text("feed_url").notNull().unique(),
    enabled: integer("enabled").notNull().default(1),
    pollIntervalMin: integer("poll_interval_min").notNull().default(15),
    etag: text("etag"),
    lastModified: text("last_modified"),
    contentHash: text("content_hash"),
    lastAttemptAt: integer("last_attempt_at"),
    lastSuccessAt: integer("last_success_at"),
    lastErrorCode: text("last_error_code"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastImportedCount: integer("last_imported_count").notNull().default(0),
    lastSkippedCount: integer("last_skipped_count").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    idCheck: check("calendar_external_sources_id_check", sql`length(trim(${table.id})) > 0`),
    nameCheck: check("calendar_external_sources_name_check", sql`length(trim(${table.name})) > 0`),
    providerCheck: check(
      "calendar_external_sources_provider_check",
      sql`${table.provider} IN ('google', 'microsoft', 'apple', 'ics_generic')`
    ),
    enabledCheck: check("calendar_external_sources_enabled_check", sql`${table.enabled} IN (0, 1)`),
    pollIntervalCheck: check(
      "calendar_external_sources_poll_interval_check",
      sql`${table.pollIntervalMin} BETWEEN 1 AND 1440`
    ),
    contentHashCheck: check(
      "calendar_external_sources_content_hash_check",
      sql`${table.contentHash} IS NULL OR (length(${table.contentHash}) = 64 AND ${table.contentHash} NOT GLOB '*[^0-9a-f]*')`
    ),
    lastErrorCodeCheck: check(
      "calendar_external_sources_last_error_code_check",
      sql`${table.lastErrorCode} IS NULL OR ${table.lastErrorCode} IN ('unsafe_url', 'unavailable', 'timeout', 'too_large', 'invalid_calendar', 'parse_failed', 'reconcile_failed')`
    ),
    consecutiveFailuresCheck: check(
      "calendar_external_sources_consecutive_failures_check",
      sql`${table.consecutiveFailures} >= 0`
    ),
    lastImportedCountCheck: check(
      "calendar_external_sources_last_imported_count_check",
      sql`${table.lastImportedCount} >= 0`
    ),
    lastSkippedCountCheck: check(
      "calendar_external_sources_last_skipped_count_check",
      sql`${table.lastSkippedCount} >= 0`
    ),
  })
);

/** Calendar-owned external identity and feed metadata for one materialized event. */
export const calendarExternalEventMeta = sqliteTable(
  "calendar_external_event_meta",
  {
    eventId: text("event_id")
      .primaryKey()
      .references(() => calendarEvents.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => calendarExternalSources.id, { onDelete: "restrict" }),
    externalUid: text("external_uid").notNull(),
    recurrenceId: text("recurrence_id").notNull().default(""),
    description: text("description"),
    location: text("location"),
    status: text("status").notNull().default("active"),
    rawHash: text("raw_hash").notNull(),
    sourceUpdatedAt: integer("source_updated_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    uniqueIdentity: unique("calendar_external_event_meta_identity_unique").on(
      table.sourceId,
      table.externalUid,
      table.recurrenceId
    ),
    externalUidCheck: check(
      "calendar_external_event_meta_external_uid_check",
      sql`length(trim(${table.externalUid})) > 0`
    ),
    statusCheck: check(
      "calendar_external_event_meta_status_check",
      sql`${table.status} IN ('active', 'cancelled')`
    ),
    rawHashCheck: check(
      "calendar_external_event_meta_raw_hash_check",
      sql`length(${table.rawHash}) = 64 AND ${table.rawHash} NOT GLOB '*[^0-9a-f]*'`
    ),
  })
);

/** Ordered, user-authored rules used to decorate Calendar reads without mutating stored titles. */
export const calendarHighlightRules = sqliteTable(
  "calendar_highlight_rules",
  {
    id: text("id").primaryKey(),
    emoji: text("emoji").notNull(),
    keywordsJson: text("keywords_json").notNull(),
    enabled: integer("enabled").notNull().default(1),
    priority: integer("priority").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    uniquePriority: unique("calendar_highlight_rules_priority_unique").on(table.priority),
    idCheck: check("calendar_highlight_rules_id_check", sql`length(trim(${table.id})) > 0`),
    emojiCheck: check(
      "calendar_highlight_rules_emoji_check",
      sql`length(trim(${table.emoji})) BETWEEN 1 AND 32`
    ),
    keywordsJsonCheck: check(
      "calendar_highlight_rules_keywords_json_check",
      sql`json_valid(${table.keywordsJson}) AND json_type(${table.keywordsJson}) = 'array'`
    ),
    enabledCheck: check("calendar_highlight_rules_enabled_check", sql`${table.enabled} IN (0, 1)`),
    priorityCheck: check("calendar_highlight_rules_priority_check", sql`${table.priority} >= 0`),
  })
);

/** Calendar assignments — series-level link event → member.
 * Every occurrence of a recurring event inherits the assignment.
 */
export const calendarAssignments = sqliteTable(
  "calendar_assignments",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => calendarEvents.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (table) => ({
    uniqueEventMember: unique("calendar_assignments_unique_event_member").on(
      table.eventId,
      table.memberId
    ),
  })
);

/** Routines — repeatable child-facing household work templates attached to one day period.
 */
export const routines = sqliteTable(
  "routines",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    dayPeriodId: text("day_period_id")
      .notNull()
      .references(() => dayPeriods.id),
    active: integer("active").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    activeCheck: check("routines_active_check", sql`${table.active} IN (0, 1)`),
    dayPeriodCheck: check(
      "routines_day_period_id_check",
      sql`${table.dayPeriodId} IN ('morning','afternoon','evening','night')`
    ),
  })
);

/** Chores — ordered tasks within one routine.
 */
export const chores = sqliteTable(
  "chores",
  {
    id: text("id").primaryKey(),
    routineId: text("routine_id")
      .notNull()
      .references(() => routines.id),
    name: text("name").notNull(),
    icon: text("icon"),
    sortOrder: integer("sort_order").notNull(),
    active: integer("active").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    activeCheck: check("chores_active_check", sql`${table.active} IN (0, 1)`),
    sortOrderCheck: check("chores_sort_order_check", sql`${table.sortOrder} >= 0`),
  })
);

/** Routine assignments — link routine to one active child on a set of weekdays.
 */
export const routineAssignments = sqliteTable(
  "routine_assignments",
  {
    id: text("id").primaryKey(),
    routineId: text("routine_id")
      .notNull()
      .references(() => routines.id),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id),
    weekdays: text("weekdays").notNull().default("[]"),
    active: integer("active").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    activeCheck: check("routine_assignments_active_check", sql`${table.active} IN (0, 1)`),
    uniqueRoutineMember: unique("routine_assignments_unique_routine_member").on(
      table.routineId,
      table.memberId
    ),
  })
);

/** Chore completions — evidence that a member marked a chore done for a date.
 */
export const choreCompletions = sqliteTable(
  "chore_completions",
  {
    id: text("id").primaryKey(),
    choreId: text("chore_id")
      .notNull()
      .references(() => chores.id),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id),
    date: text("date").notNull(),
    completedAt: integer("completed_at").notNull(),
  },
  (table) => ({
    uniqueMemberChoreDate: unique("chore_completions_unique_member_chore_date").on(
      table.memberId,
      table.choreId,
      table.date
    ),
  })
);

/** Reminder — scheduled or calendar_gated reminder rule (kind-aware discriminant CHECK, 0009).
 */
export const reminders = sqliteTable(
  "reminder",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    targetingMode: text("targeting_mode").notNull(),
    text: text("text").notNull(),
    weekdays: text("weekdays"),
    query: text("query"),
    queryFields: text("query_fields"),
    active: integer("active").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    kindCheck: check("reminders_kind_check", sql`${table.kind} IN ('scheduled','calendar_gated')`),
    targetingModeCheck: check(
      "reminders_targeting_mode_check",
      sql`${table.targetingMode} IN ('apply_to_all','specific')`
    ),
    discriminantCheck: check(
      "reminders_discriminant_check",
      sql`(${table.kind} = 'scheduled' AND ${table.query} IS NULL AND ${table.queryFields} IS NULL AND ((${table.targetingMode} = 'apply_to_all' AND ${table.weekdays} IS NOT NULL) OR (${table.targetingMode} = 'specific' AND ${table.weekdays} IS NULL))) OR (${table.kind} = 'calendar_gated' AND ${table.query} IS NOT NULL AND ${table.queryFields} IS NOT NULL AND ${table.weekdays} IS NULL)`
    ),
    activeCheck: check("reminders_active_check", sql`${table.active} IN (0, 1)`),
  })
);

/** Reminder assignment — links a specific-mode reminder to one active member on weekdays.
 */
export const reminderAssignments = sqliteTable(
  "reminder_assignment",
  {
    id: text("id").primaryKey(),
    reminderId: text("reminder_id")
      .notNull()
      .references(() => reminders.id, { onDelete: "cascade" }),
    memberId: text("member_id").notNull(),
    weekdays: text("weekdays").notNull().default("[]"),
    active: integer("active").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    activeCheck: check("reminder_assignments_active_check", sql`${table.active} IN (0, 1)`),
    uniqueReminderMember: unique("reminder_assignments_unique_reminder_member").on(
      table.reminderId,
      table.memberId
    ),
  })
);

/** Recipes — a named recipe with optional ingredients/instructions/suggested slots.
 */
export const recipes = sqliteTable(
  "recipes",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    ingredients: text("ingredients"),
    instructions: text("instructions"),
    slots: text("slots"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    nameCheck: check("recipes_name_check", sql`length(trim(${table.name})) > 0`),
    nameIdx: index("recipes_name_idx").on(table.name),
  })
);

/** Meal plans — a named recurring menu template. Deactivate-only (no hard delete, INV-08).
 */
export const mealPlans = sqliteTable(
  "meal_plans",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    active: integer("active").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    nameCheck: check("meal_plans_name_check", sql`length(trim(${table.name})) > 0`),
    activeCheck: check("meal_plans_active_check", sql`${table.active} IN (0, 1)`),
  })
);

/** Meal entries — single table, nullable recurring/one-off discriminator.
 * Recurring: meal_plan_id + weekday. One-off: entry_date. Content: recipe_id xor note.
 */
export const mealEntries = sqliteTable(
  "meal_entries",
  {
    id: text("id").primaryKey(),
    mealPlanId: text("meal_plan_id").references(() => mealPlans.id),
    weekday: text("weekday"),
    entryDate: text("entry_date"),
    slot: text("slot").notNull(),
    recipeId: text("recipe_id").references(() => recipes.id, { onDelete: "cascade" }),
    note: text("note"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => ({
    kindCheck: check(
      "meal_entries_kind_check",
      sql`(${table.mealPlanId} IS NOT NULL AND ${table.weekday} IS NOT NULL AND ${table.entryDate} IS NULL) OR (${table.entryDate} IS NOT NULL AND ${table.mealPlanId} IS NULL AND ${table.weekday} IS NULL)`
    ),
    contentCheck: check(
      "meal_entries_content_check",
      sql`(${table.recipeId} IS NOT NULL AND ${table.note} IS NULL) OR (${table.recipeId} IS NULL AND ${table.note} IS NOT NULL)`
    ),
    slotCheck: check(
      "meal_entries_slot_check",
      sql`${table.slot} IN ('breakfast','lunch','snack','dinner')`
    ),
    weekdayCheck: check(
      "meal_entries_weekday_check",
      sql`${table.weekday} IS NULL OR ${table.weekday} IN ('mon','tue','wed','thu','fri','sat','sun')`
    ),
    recipeIdIdx: index("meal_entries_recipe_id_idx").on(table.recipeId),
    entryDateSlotIdx: index("meal_entries_entry_date_slot_idx").on(table.entryDate, table.slot),
    mealPlanWeekdaySlotIdx: index("meal_entries_meal_plan_id_weekday_slot_idx").on(
      table.mealPlanId,
      table.weekday,
      table.slot
    ),
  })
);

/** Daily messages — one message per (member, date); upsert via ON CONFLICT(member_id, date).
 * No ON DELETE on member_id (members archive-only, ADR-054); reads gate on member existence,
 * not active status, so an archived member's historical rows stay readable.
 */
export const dailyMessages = sqliteTable(
  "daily_messages",
  {
    id: text("id").primaryKey(),
    memberId: text("member_id").notNull(),
    date: text("date").notNull(),
    text: text("text").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    textCheck: check("daily_messages_text_check", sql`length(trim(${table.text})) > 0`),
    uniqueMemberDate: unique("daily_messages_unique_member_date").on(table.memberId, table.date),
  })
);

/** Daily briefing — one current row per (member, date); id stable across regeneration (INV-02).
 * PLUGIN table (ADR-029) — `member_id` is a plain column, NO `.references` (ADR-039 §3 / INV-02).
 * The render layer's columns are:
 * `failedRenderBlocks` (render-layer failure records, `[]` default; data-layer failures stay in the
 * envelope, 010 pattern), `rasterBits`/`rasterHeight` (the packed 1-bit printable raster + its row
 * count — the printable-provider's synchronous lookup target), `png` (pressedslip's own 1-bit PNG,
 * admin/preview surface only), and the `last_print_*` trio (D11 — a DERIVED, advisory cache of
 * Printing's canonical record; never authoritative, never load-bearing on its own). All four
 * raster/png columns are NULL together (no printable raster yet, Printing inactive at generation,
 * or a catastrophic render — `render-failed`); the status CHECK widens to admit `render-failed`
 * Catastrophic renders must never read back as `ready` with a missing raster. See
 * `drizzle/0017_daily_briefing_render.sql` for the table-rebuild migration (SQLite cannot
 * ALTER a CHECK constraint, precedent drizzle/0009_reminders_calendar_gated.sql /
 * 0010_drop_member_fks.sql).
 */
export const dailyBriefings = sqliteTable(
  "daily_briefing",
  {
    id: text("id").primaryKey(),
    memberId: text("member_id").notNull(),
    date: text("date").notNull(),
    status: text("status").notNull(),
    payload: text("payload").notNull(),
    // `failedRenderBlocks` holds ONLY genuine
    // render-layer failures (feeds D5's status derivation); `unrenderedBlocks` is the separate,
    // status-EXCLUDED population — block types with no pressedslip render-def yet (a registry
    // miss). See `render/bridge.ts#RenderBridgeResult` for the exact partition.
    failedRenderBlocks: text("failed_render_blocks").notNull().default("[]"),
    unrenderedBlocks: text("unrendered_blocks").notNull().default("[]"),
    rasterBits: blob("raster_bits", { mode: "buffer" }),
    rasterHeight: integer("raster_height"),
    png: blob("png", { mode: "buffer" }),
    lastPrintState: text("last_print_state"),
    lastPrintAt: integer("last_print_at"),
    lastPrintGeneration: integer("last_print_generation"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    statusCheck: check(
      "daily_briefing_status_check",
      sql`${table.status} IN ('pending','ready','partial','failed','render-failed')`
    ),
    lastPrintStateCheck: check(
      "daily_briefing_last_print_state_check",
      sql`${table.lastPrintState} IS NULL OR ${table.lastPrintState} IN ('completed','failed')`
    ),
    uniqueMemberDate: unique("daily_briefing_unique_member_date").on(table.memberId, table.date),
  })
);

/** Daily briefing opt-in — per-member opt-in flag (absent row = off, ADR-027).
 * `weekdays` is the per-member pause schedule (drizzle/0005).
 * PLUGIN table (ADR-029) — `member_id` is a plain PK column, NO `.references` (ADR-039 §3 / INV-02).
 */
export const dailyBriefingOptins = sqliteTable(
  "daily_briefing_optin",
  {
    memberId: text("member_id").primaryKey(),
    enabled: integer("enabled").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    /** Weekday pause schedule (JSON weekday codes, canonical order); NULL = every day. */
    weekdays: text("weekdays"),
  },
  (table) => ({
    enabledCheck: check("daily_briefing_optin_enabled_check", sql`${table.enabled} IN (0, 1)`),
  })
);

/** Daily briefing block cache — shared-scope block payloads, one row per (date, block_type)
 * Eager-loaded per generation run and write-through, at most one
 * successful external call per source per day per household (FR-019). No eviction this module (v1
 * parity; bounded growth — one row per shared type per day). PLUGIN table (ADR-029).
 */
export const dailyBriefingBlockCache = sqliteTable(
  "daily_briefing_block_cache",
  {
    date: text("date").notNull(),
    blockType: text("block_type").notNull(),
    payload: text("payload").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => ({
    pk: unique("daily_briefing_block_cache_pk").on(table.date, table.blockType),
  })
);

/** Daily briefing member block settings — per (member_id, block_type): enabled, weekday mask,
 * per-block params. An absent row means enabled (v1 parity), EXCEPT
 * `onThisDay` => disabled by default (FR-013 — seeded as an explicit row at first admin write or
 * generation bootstrap, not encoded here). PLUGIN table (ADR-029) — `member_id` is a plain column,
 * NO `.references` (ADR-039 §3 / INV-02).
 */
export const dailyBriefingMemberBlockSettings = sqliteTable(
  "daily_briefing_member_block_settings",
  {
    memberId: text("member_id").notNull(),
    blockType: text("block_type").notNull(),
    enabled: integer("enabled").notNull().default(1),
    weekdays: text("weekdays"),
    params: text("params"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    pk: unique("daily_briefing_member_block_settings_pk").on(table.memberId, table.blockType),
    enabledCheck: check(
      "daily_briefing_member_block_settings_enabled_check",
      sql`${table.enabled} IN (0, 1)`
    ),
  })
);

/** Daily briefing block order — the household-wide single-row (id=1) ordered list of block
 * instances. Owned by Daily Briefing, never an App Setting (INV-05).
 * PLUGIN table (ADR-029).
 */
export const dailyBriefingBlockOrder = sqliteTable(
  "daily_briefing_block_order",
  {
    id: integer("id").primaryKey(),
    orderJson: text("order_json").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    singleRowCheck: check("daily_briefing_block_order_single_row_check", sql`${table.id} = 1`),
  })
);

/** Daily briefing settings — the household-wide single-row (id=1) generation schedule + the
 * auto-print trigger BINDING. `auto_print_trigger` is NULL (no
 * binding) or `'morning_complete'` (bound+active) — deliberately NOT a boolean `autoPrint` flag
 * The trigger-binding model means automatic printing IS the presence of
 * an active binding). PLUGIN table (ADR-029).
 */
export const dailyBriefingSettings = sqliteTable(
  "daily_briefing_settings",
  {
    id: integer("id").primaryKey(),
    generationTime: text("generation_time").notNull().default("06:00"),
    autoPrintTrigger: text("auto_print_trigger"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    singleRowCheck: check("daily_briefing_settings_single_row_check", sql`${table.id} = 1`),
    autoPrintTriggerCheck: check(
      "daily_briefing_settings_auto_print_trigger_check",
      sql`${table.autoPrintTrigger} IS NULL OR ${table.autoPrintTrigger} IN ('morning_complete')`
    ),
  })
);

/** Client log — redacted client/server telemetry records. Core Tier-0 table (not
 * plugin-namespaced). `event_id` is a server-assigned correlation id for the external-sink
 * projection (INV-03/07). `event_time` is client-claimed, advisory only; `received_at` is the
 * authoritative retention/ordering clock. `component`/`message` are value-pattern-redacted
 * (attacker-controlled, sink-forwarded). `data` is redacted+bounded JSON (post
 * `boundAndRedact`), or NULL. Always-on, no household setting (INV-12); no legacy import (AC-07).
 */
export const clientLog = sqliteTable(
  "client_log",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    eventTime: integer("event_time"),
    receivedAt: integer("received_at").notNull(),
    level: text("level").notNull(),
    component: text("component").notNull(),
    message: text("message").notNull(),
    data: text("data"),
  },
  (table) => ({
    levelCheck: check(
      "client_log_level_check",
      sql`${table.level} IN ('debug', 'info', 'warn', 'error')`
    ),
    receivedAtIdx: index("client_log_received_at_idx").on(table.receivedAt),
    componentIdx: index("client_log_component_idx").on(table.component),
  })
);

/** Time announcements — the domain's WHOLE server surface: rule DATA ONLY, no firing
 * state of any kind (no queue rows, claims, or staleness sweeps — INV-06); firing is entirely
 * client-side (ADR-051 as reconciled by ADR-065). `time` is stored exactly as written, never
 * normalized (INV-02, module-validated strict `HH:MM`, DB CHECK below as a second gate).
 * `week_days` is a non-empty, deduped, canonical-order JSON array of `mon..sun` codes (INV-03,
 * module-validated, mirrors the `reminder.weekdays` precedent of no JSON1 DB CHECK). `is_active`
 * is the only pause (INV-05, soft-disable only); delete is permanent, no archive tier.
 */
export const timeAnnouncements = sqliteTable(
  "time_announcements",
  {
    id: text("id").primaryKey(),
    time: text("time").notNull(),
    weekDays: text("week_days").notNull(),
    isActive: integer("is_active").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    timeShapeCheck: check(
      "time_announcements_time_check",
      sql`${table.time} GLOB '[0-2][0-9]:[0-5][0-9]' AND CAST(substr(${table.time}, 1, 2) AS INTEGER) BETWEEN 0 AND 23`
    ),
    weekDaysCheck: check(
      "time_announcements_week_days_check",
      sql`length(trim(${table.weekDays})) > 0`
    ),
    isActiveCheck: check("time_announcements_is_active_check", sql`${table.isActive} IN (0, 1)`),
    timeIdx: index("time_announcements_time_idx").on(table.time),
  })
);

/** Network devices — the curated household device registry over the UniFi
 * controller's reported clients ("Table: network_devices"). PLUGIN table
 * (ADR-029/039) — `member_id` is a plain nullable id-only column, NO `.references`
 * (ADR-039 §3, precedent `0010_drop_member_fks.sql`): integrity is app-side
 * (assertActiveMember via the host-API), strict-on-write / tolerant-on-read. `mac` is
 * canonical (lowercase, colon-separated) and immutable — no UPDATE path ever writes it
 * (INV-02); its UNIQUE index is what resolves racing registrations at the DB layer, not app
 * locking (INV-01). NO `ip` column exists anywhere — the drop is structural (INV-06).
 * `isBlocked` is the local BELIEF mirror of controller state, reconciled only by the
 * background poll (INV-04); `beliefDivergedAt` marks a mirror-write failure after a
 * controller success, cleared by the converging poll (AC-02). `lastSeenAt` is
 * observation-only (INV-10) — stamped from the live-cache entry at registration and by the
 * poll, never defaulted at creation.
 */
export const networkDevices = sqliteTable(
  "network_devices",
  {
    id: text("id").primaryKey(),
    mac: text("mac").notNull().unique(),
    alias: text("alias").notNull(),
    memberId: text("member_id"),
    isBlocked: integer("is_blocked").notNull().default(0),
    beliefDivergedAt: integer("belief_diverged_at"),
    lastSeenAt: integer("last_seen_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    isBlockedCheck: check("network_devices_is_blocked_check", sql`${table.isBlocked} IN (0, 1)`),
  })
);

/** Print records — the per-output truth (dedup anchor for print triggers, * "print_records"). PLUGIN table (ADR-029/039). UNIQUE(record_key, target_date) makes
 * "already printed for the date" (FR-012) a DB-level guarantee: the trigger's dedup check
 * can never lose a race to double-enqueue. `superseded_at` non-null means re-printable
 * (ADR-062 timestamp convention); `printed_job_id` names the job whose ack satisfied this
 * record. `generation` is incremented by
 * `supersedePrintRecord` — the clock-granularity-proof way to tell a STALE (pre-supersede)
 * in-flight job apart from the CURRENT one: a fetched-in-flight job may keep running past its
 * supersede (H2 accepted), so `created_at`/`updated_at` comparisons can't distinguish "before"
 * from "after" reliably, but a monotonically-incremented counter always can.
 */
export const printRecords = sqliteTable(
  "print_records",
  {
    id: text("id").primaryKey(),
    recordKey: text("record_key").notNull(),
    targetDate: text("target_date").notNull(),
    supersededAt: integer("superseded_at"),
    printedJobId: text("printed_job_id"),
    generation: integer("generation").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    uniqueRecordKeyDate: unique("print_records_unique_record_key_target_date").on(
      table.recordKey,
      table.targetDate
    ),
  })
);

/** Print jobs — one durable delivery attempt-set ("print_jobs"). PLUGIN table
 * (ADR-029/039); `member_id` is a plain nullable column with NO `.references` (ADR-039 §3 /
 * INV-02, precedent drizzle/0010_drop_member_fks.sql) — cross-namespace integrity is app-side
 * (assertActiveMember via the host-API), strict-on-write / tolerant-on-read; null for the test
 * printable. `record_id` IS a declared FK to print_records — intra-namespace (same plugin),
 * allowed per ADR-039 §3. `output_ref` is the producer's artifact reference ONLY — no raster
 * ever lives in this table (ADR-041/PRINTING-INV-03 fetch-at-execute). `attempts`
 * counts RECOVERABLE failures only (permanent failures dead-letter immediately without
 * incrementing it — "Failure taxonomy"). `lease_token`/`lease_expires_at` are the
 * D1 atomic-claim/lease mechanics; `payload_served_at` distinguishes claimed-not-yet-fetched
 * (cancellable by supersede) from fetched-in-flight (continues, H2 accepted). `generation`
 * is copied from `print_records.generation` at
 * enqueue time and never changes thereafter — it freezes WHICH supersede-epoch this job belongs
 * to, so a stale-generation survivor (a fetched-in-flight job left running past a supersede) can
 * be told apart from the current-generation job dedup/ack must treat as canonical.
 */
export const printJobs = sqliteTable(
  "print_jobs",
  {
    id: text("id").primaryKey(),
    recordId: text("record_id")
      .notNull()
      .references(() => printRecords.id, { onDelete: "cascade" }),
    memberId: text("member_id"),
    targetDate: text("target_date").notNull(),
    state: text("state").notNull(),
    outputRef: text("output_ref").notNull(),
    attempts: integer("attempts").notNull().default(0),
    leaseToken: text("lease_token"),
    leaseExpiresAt: integer("lease_expires_at"),
    claimedAt: integer("claimed_at"),
    printedAt: integer("printed_at"),
    failureReason: text("failure_reason"),
    payloadServedAt: integer("payload_served_at"),
    generation: integer("generation").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    stateCheck: check(
      "print_jobs_state_check",
      sql`${table.state} IN ('pending','claimed','printed','failed','cancelled')`
    ),
    targetDateStateIdx: index("print_jobs_target_date_state_idx").on(table.targetDate, table.state),
    recordIdIdx: index("print_jobs_record_id_idx").on(table.recordId),
  })
);

/** Printer capability marker (FR-021, ADR-035). PLUGIN table
 * (ADR-029/039) — one row per session (the executor's device-key id, `api_keys.id`) that
 * registered printer capability on pairing; `claimJob` refuses a session with no row here, so a
 * bare provisioned key alone cannot hold leases away from the real executor. `key_id` is a PLAIN
 * column with NO FK to `api_keys` (cross-namespace — ADR-039 §3, the `member_id` precedent
 * above): integrity is app-side, tolerant-on-read. Registration is idempotent (re-pairing the
 * SAME key upserts `registered_at` rather than erroring).
 */
export const printerCapabilities = sqliteTable("printer_capabilities", {
  keyId: text("key_id").primaryKey(),
  registeredAt: integer("registered_at").notNull(),
});

/** Immutable singleton classifying the store from the migration journal snapshot captured before
 * the lifecycle migration ran. This provenance is never reconstructed from business data.
 */
export const installationLineage = sqliteTable(
  "installation_lineage",
  {
    singletonId: integer("singleton_id").primaryKey(),
    kind: text("kind").notNull(),
    preRunMigrationFiles: text("pre_run_migration_files").notNull(),
    capturedAt: text("captured_at").notNull(),
  },
  (table) => ({
    singletonCheck: check("installation_lineage_singleton_check", sql`${table.singletonId} = 1`),
    kindCheck: check(
      "installation_lineage_kind_check",
      sql`${table.kind} IN ('fresh', 'prior_baseline')`
    ),
    historyCheck: check(
      "installation_lineage_history_check",
      sql`json_valid(${table.preRunMigrationFiles}) AND json_type(${table.preRunMigrationFiles}) = 'array'`
    ),
    capturedAtCheck: check(
      "installation_lineage_captured_at_check",
      sql`length(${table.capturedAt}) = 24
        AND ${table.capturedAt} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
        AND strftime('%Y-%m-%dT%H:%M:%fZ', ${table.capturedAt}) = ${table.capturedAt}`
    ),
  })
);

/** The sole canonical active/inactive/errored record for the closed first-party plugin cohort. */
export const pluginActivationRegistry = sqliteTable(
  "plugin_activation_registry",
  {
    pluginId: text("plugin_id").primaryKey(),
    state: text("state").notNull(),
    activatedAt: text("activated_at"),
    updatedAt: text("updated_at").notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
  },
  (table) => ({
    pluginIdCheck: check(
      "plugin_activation_registry_plugin_id_check",
      sql`${table.pluginId} IN ('daily-briefing', 'printing', 'weather', 'time-announcements', 'backups', 'network-devices', 'meals-recipes', 'reminders', 'daily-messages')`
    ),
    stateCheck: check(
      "plugin_activation_registry_state_check",
      sql`${table.state} IN ('active', 'inactive', 'errored')`
    ),
    activatedAtCheck: check(
      "plugin_activation_registry_activated_at_check",
      sql`${table.activatedAt} IS NULL OR (
        length(${table.activatedAt}) = 24
        AND ${table.activatedAt} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
        AND strftime('%Y-%m-%dT%H:%M:%fZ', ${table.activatedAt}) = ${table.activatedAt}
      )`
    ),
    updatedAtCheck: check(
      "plugin_activation_registry_updated_at_check",
      sql`length(${table.updatedAt}) = 24
        AND ${table.updatedAt} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
        AND strftime('%Y-%m-%dT%H:%M:%fZ', ${table.updatedAt}) = ${table.updatedAt}`
    ),
    errorCheck: check(
      "plugin_activation_registry_error_check",
      sql`(
        (${table.errorCode} IS NULL AND ${table.errorMessage} IS NULL)
        OR (
          ${table.state} = 'errored'
          AND ${table.errorCode} IS NOT NULL
          AND ${table.errorMessage} IS NOT NULL
          AND (
            (${table.errorCode} = 'settings_initialization_failed' AND ${table.errorMessage} = 'Plugin settings could not be prepared.')
            OR (${table.errorCode} = 'migration_failed' AND ${table.errorMessage} = 'Plugin data could not be prepared.')
            OR (${table.errorCode} = 'runtime_mount_failed' AND ${table.errorMessage} = 'Plugin services could not be started.')
            OR (${table.errorCode} = 'drain_failed' AND ${table.errorMessage} = 'Plugin work could not stop safely.')
            OR (${table.errorCode} = 'runtime_unmount_failed' AND ${table.errorMessage} = 'Plugin services could not be stopped.')
            OR (${table.errorCode} = 'contribution_failed' AND ${table.errorMessage} = 'A plugin contribution failed.')
            OR (${table.errorCode} = 'reconciliation_failed' AND ${table.errorMessage} = 'Plugin recovery requires attention.')
          )
        )
      )`
    ),
  })
);

/** Durable reconciliation cursor; operation phases never become a fourth canonical state. */
export const pluginLifecycleOperations = sqliteTable(
  "plugin_lifecycle_operations",
  {
    operationId: text("operation_id").primaryKey(),
    pluginId: text("plugin_id")
      .notNull()
      .unique()
      .references(() => pluginActivationRegistry.pluginId, { onDelete: "restrict" }),
    targetState: text("target_state").notNull(),
    phase: text("phase").notNull(),
    startedAt: text("started_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    operationIdCheck: check(
      "plugin_lifecycle_operations_operation_id_check",
      sql`length(trim(${table.operationId})) > 0`
    ),
    targetPhaseCheck: check(
      "plugin_lifecycle_operations_target_phase_check",
      sql`(
        (${table.targetState} = 'active' AND ${table.phase} IN ('preparing-settings', 'running-migrations', 'mounting', 'committing-active'))
        OR
        (${table.targetState} = 'inactive' AND ${table.phase} IN ('blocking-claims', 'draining', 'unmounting', 'committing-inactive'))
      )`
    ),
    startedAtCheck: check(
      "plugin_lifecycle_operations_started_at_check",
      sql`length(${table.startedAt}) = 24
        AND ${table.startedAt} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
        AND strftime('%Y-%m-%dT%H:%M:%fZ', ${table.startedAt}) = ${table.startedAt}`
    ),
    updatedAtCheck: check(
      "plugin_lifecycle_operations_updated_at_check",
      sql`length(${table.updatedAt}) = 24
        AND ${table.updatedAt} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
        AND strftime('%Y-%m-%dT%H:%M:%fZ', ${table.updatedAt}) = ${table.updatedAt}`
    ),
  })
);

/** Forward-only, idempotent plugin-local migration journal. */
export const pluginMigrationJournal = sqliteTable(
  "plugin_migration_journal",
  {
    pluginId: text("plugin_id")
      .notNull()
      .references(() => pluginActivationRegistry.pluginId, { onDelete: "restrict" }),
    migrationId: text("migration_id").notNull(),
    appliedAt: text("applied_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.pluginId, table.migrationId] }),
    migrationIdCheck: check(
      "plugin_migration_journal_migration_id_check",
      sql`length(trim(${table.migrationId})) > 0`
    ),
    appliedAtCheck: check(
      "plugin_migration_journal_applied_at_check",
      sql`length(${table.appliedAt}) = 24
        AND ${table.appliedAt} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
        AND strftime('%Y-%m-%dT%H:%M:%fZ', ${table.appliedAt}) = ${table.appliedAt}`
    ),
  })
);
