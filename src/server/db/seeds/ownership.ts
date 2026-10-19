import type { DatabaseConnection } from "../client";

export const DEMO_PROFILE = "simpsons-demo";
export const DEMO_PROFILE_VERSION = 1;

const DEMO_ID_PREFIX = "demo:";
const MIGRATIONS_TABLE = "drizzle_universe_migrations";
const MARKER_TABLE = "seed_profile_state";
const LIFECYCLE_TABLES = new Set([
  "installation_lineage",
  "plugin_activation_registry",
  "plugin_lifecycle_operations",
  "plugin_migration_journal",
]);
const PLUGIN_IDS = [
  "daily-briefing",
  "printing",
  "weather",
  "time-announcements",
  "backups",
  "network-devices",
  "meals-recipes",
  "reminders",
  "daily-messages",
] as const;

export const DEMO_SETTINGS_OBJECT_NAMES = [
  "locale",
  "weather",
  "printer",
  "printerTransport",
] as const;

/** The seed runner may only ever canonicalize rows in this declared inventory. Tables absent from
 * the current schema are kept here for the serialized later schema work and are scanned once they
 * exist; every other non-system row is an ownership refusal.
 */
export const DEMO_OWNED_TABLES = [
  "members",
  "calendar_events",
  "calendar_assignments",
  "calendar_external_sources",
  "calendar_highlight_rules",
  "routines",
  "chores",
  "routine_assignments",
  "chore_completions",
  "reminder",
  "reminder_assignment",
  "recipes",
  "meal_plans",
  "meal_entries",
  "daily_messages",
  "daily_briefing_optin",
  "daily_briefing_member_block_settings",
  "daily_briefing_block_order",
  "daily_briefing_settings",
  "time_announcements",
  "settings_objects",
] as const;

type DemoOwnedTable = (typeof DEMO_OWNED_TABLES)[number];
type MarkerStatus = "running" | "complete";

export interface SeedProfileRequest {
  asOfDate: string;
  nowMs: number;
}

export interface SeedProfileResult {
  action: "created" | "repair" | "rerun" | "completed";
  profile: typeof DEMO_PROFILE;
  status: MarkerStatus;
}

interface MarkerRow {
  profile: string;
  version: number;
  as_of_date: string;
  status: string;
  started_at: number;
  completed_at: number | null;
}

interface DatabaseRow {
  [column: string]: unknown;
}

const CANONICAL_DAY_PERIODS = [
  { id: "morning", label_key: "dayPeriod.morning", start_minutes: 300, sort_order: 0 },
  { id: "afternoon", label_key: "dayPeriod.afternoon", start_minutes: 720, sort_order: 1 },
  { id: "evening", label_key: "dayPeriod.evening", start_minutes: 1080, sort_order: 2 },
  { id: "night", label_key: "dayPeriod.night", start_minutes: 1260, sort_order: 3 },
] as const;

const MEMBER_SCOPED_TABLES = new Set<DemoOwnedTable>([
  "daily_briefing_optin",
  "daily_briefing_member_block_settings",
]);

const SINGLETON_TABLES = new Set<DemoOwnedTable>([
  "daily_briefing_block_order",
  "daily_briefing_settings",
]);

export class SeedOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedOwnershipError";
  }
}

export function beginSeedProfile(
  db: DatabaseConnection,
  request: SeedProfileRequest
): SeedProfileResult {
  assertRequest(request);
  assertMarkerTableExists(db);

  const markers = markerRows(db);
  if (markers.length === 0) {
    assertFreshBaseline(db);
    db.prepare(
      `INSERT INTO ${quoted(MARKER_TABLE)}
        (profile, version, as_of_date, status, started_at, completed_at)
       VALUES (?, ?, ?, 'running', ?, NULL)`
    ).run(DEMO_PROFILE, DEMO_PROFILE_VERSION, request.asOfDate, request.nowMs);
    return { action: "created", profile: DEMO_PROFILE, status: "running" };
  }

  const marker = assertExpectedMarker(markers);
  assertRerunInventory(db);
  if (marker.as_of_date !== request.asOfDate) {
    if (marker.status !== "complete") {
      throw new SeedOwnershipError("Seed profile marker as-of date does not match this rerun");
    }
    db.prepare(
      `UPDATE ${quoted(MARKER_TABLE)}
       SET as_of_date = ?, status = 'running', started_at = ?, completed_at = NULL
       WHERE profile = ? AND status = 'complete'`
    ).run(request.asOfDate, request.nowMs, DEMO_PROFILE);
    return { action: "repair", profile: DEMO_PROFILE, status: "running" };
  }
  return {
    action: marker.status === "running" ? "repair" : "rerun",
    profile: DEMO_PROFILE,
    status: marker.status,
  };
}

export type SeedProfileMarkerState = "absent" | MarkerStatus | "unrecognized";

/** Where the demo profile marker stands, without validating the rest of the database: "absent"
 * when nothing was ever seeded (or the marker table does not exist yet), "unrecognized" for a
 * marker of another profile or status, which the runner would refuse anyway.
 */
export function readSeedProfileMarker(db: DatabaseConnection): SeedProfileMarkerState {
  if (!tableNames(db).includes(MARKER_TABLE)) return "absent";
  const markers = markerRows(db);
  if (markers.length === 0) return "absent";
  const [marker] = markers;
  if (markers.length !== 1 || marker?.profile !== DEMO_PROFILE) return "unrecognized";
  return marker.status === "running" || marker.status === "complete"
    ? marker.status
    : "unrecognized";
}

export function completeSeedProfile(
  db: DatabaseConnection,
  request: SeedProfileRequest
): SeedProfileResult {
  assertRequest(request);
  assertMarkerTableExists(db);
  const marker = assertExpectedMarker(markerRows(db), request.asOfDate);
  assertRerunInventory(db);

  if (marker.status === "complete") {
    return { action: "rerun", profile: DEMO_PROFILE, status: "complete" };
  }

  db.prepare(
    `UPDATE ${quoted(MARKER_TABLE)}
     SET status = 'complete', completed_at = ?
     WHERE profile = ? AND status = 'running'`
  ).run(request.nowMs, DEMO_PROFILE);
  return { action: "completed", profile: DEMO_PROFILE, status: "complete" };
}

function assertRequest(request: SeedProfileRequest): void {
  if (!isStrictCalendarDate(request.asOfDate)) {
    throw new SeedOwnershipError("Seed profile as-of date must be a valid calendar date");
  }
  if (!Number.isSafeInteger(request.nowMs) || request.nowMs < 0) {
    throw new SeedOwnershipError("Seed profile timestamp must be a non-negative integer");
  }
}

function isStrictCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function assertMarkerTableExists(db: DatabaseConnection): void {
  if (!tableNames(db).includes(MARKER_TABLE)) {
    throw new SeedOwnershipError("Seed profile state table is not available");
  }
}

function assertFreshBaseline(db: DatabaseConnection): void {
  assertLifecycleMetadata(db);
  for (const table of tableNames(db)) {
    if (table === MIGRATIONS_TABLE) continue;
    if (table === MARKER_TABLE) continue;
    if (LIFECYCLE_TABLES.has(table)) continue;
    if (table === "day_periods") {
      assertCanonicalDayPeriods(db);
      continue;
    }
    assertTableEmpty(db, table, "fresh baseline");
  }
}

function assertRerunInventory(db: DatabaseConnection): void {
  assertLifecycleMetadata(db);
  for (const table of tableNames(db)) {
    if (table === MIGRATIONS_TABLE) continue;
    if (LIFECYCLE_TABLES.has(table)) continue;
    if (table === MARKER_TABLE) {
      assertExpectedMarker(markerRows(db));
      continue;
    }
    if (table === "day_periods") {
      assertCanonicalDayPeriods(db);
      continue;
    }
    if (isDemoOwnedTable(table)) {
      assertOwnedRows(db, table);
      continue;
    }
    assertTableEmpty(db, table, "profile rerun");
  }
}

function assertLifecycleMetadata(db: DatabaseConnection): void {
  const lineageCount = db.prepare("SELECT COUNT(*) AS count FROM installation_lineage").get() as {
    count: number;
  };
  if (lineageCount.count !== 1) {
    throw new SeedOwnershipError("Seed target has invalid installation_lineage metadata");
  }

  const pluginIds = (
    db.prepare("SELECT plugin_id FROM plugin_activation_registry ORDER BY plugin_id").all() as {
      plugin_id: string;
    }[]
  ).map(({ plugin_id }) => plugin_id);
  const expectedPluginIds = [...PLUGIN_IDS].sort();
  if (JSON.stringify(pluginIds) !== JSON.stringify(expectedPluginIds)) {
    throw new SeedOwnershipError("Seed target has invalid plugin_activation_registry metadata");
  }

  const operationCount = db
    .prepare("SELECT COUNT(*) AS count FROM plugin_lifecycle_operations")
    .get() as { count: number };
  if (operationCount.count !== 0) {
    throw new SeedOwnershipError("Seed target has an in-progress plugin lifecycle operation");
  }
}

function assertExpectedMarker(
  markers: MarkerRow[],
  asOfDate?: string
): MarkerRow & { status: MarkerStatus } {
  if (markers.length !== 1 || markers[0]?.profile !== DEMO_PROFILE) {
    throw new SeedOwnershipError("Seed profile marker is stale or belongs to another profile");
  }

  const marker = markers[0];
  if (marker.version !== DEMO_PROFILE_VERSION) {
    throw new SeedOwnershipError("Seed profile marker version is stale");
  }
  if (!isStrictCalendarDate(marker.as_of_date)) {
    throw new SeedOwnershipError("Seed profile marker has an invalid as-of date");
  }
  if (asOfDate !== undefined && marker.as_of_date !== asOfDate) {
    throw new SeedOwnershipError("Seed profile marker as-of date does not match this rerun");
  }
  if (!Number.isSafeInteger(marker.started_at) || marker.started_at < 0) {
    throw new SeedOwnershipError("Seed profile marker has an invalid start timestamp");
  }
  if (marker.status === "running" && marker.completed_at === null)
    return marker as MarkerRow & {
      status: "running";
    };
  if (
    marker.status === "complete" &&
    Number.isSafeInteger(marker.completed_at) &&
    (marker.completed_at ?? -1) >= marker.started_at
  ) {
    return marker as MarkerRow & { status: "complete" };
  }
  throw new SeedOwnershipError("Seed profile marker has an invalid status transition");
}

function assertCanonicalDayPeriods(db: DatabaseConnection): void {
  const rows = db
    .prepare(
      "SELECT id, label_key, start_minutes, sort_order FROM day_periods ORDER BY sort_order ASC"
    )
    .all();
  if (JSON.stringify(rows) !== JSON.stringify(CANONICAL_DAY_PERIODS)) {
    throw new SeedOwnershipError("Seed target has noncanonical day_periods rows");
  }
}

function assertOwnedRows(db: DatabaseConnection, table: DemoOwnedTable): void {
  const rows = allRows(db, table);
  for (const row of rows) {
    if (table === "settings_objects") {
      if (
        typeof row.object_name === "string" &&
        DEMO_SETTINGS_OBJECT_NAMES.includes(row.object_name as never)
      ) {
        continue;
      }
      throw unrelatedRow(table, row.object_name);
    }
    if (MEMBER_SCOPED_TABLES.has(table)) {
      if (isDemoId(row.member_id)) continue;
      throw unrelatedRow(table, row.member_id);
    }
    if (SINGLETON_TABLES.has(table)) {
      if (row.id === 1) continue;
      throw unrelatedRow(table, row.id);
    }
    if (isDemoId(row.id)) continue;
    throw unrelatedRow(table, row.id);
  }
}

function assertTableEmpty(db: DatabaseConnection, table: string, phase: string): void {
  const row = db.prepare(`SELECT 1 AS present FROM ${quoted(table)} LIMIT 1`).get();
  if (row !== undefined) {
    throw new SeedOwnershipError(`Seed target has an unrelated row in ${table} during ${phase}`);
  }
}

function tableNames(db: DatabaseConnection): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  )
    .map((row) => row.name)
    .sort();
}

function markerRows(db: DatabaseConnection): MarkerRow[] {
  return db
    .prepare(
      `SELECT profile, version, as_of_date, status, started_at, completed_at FROM ${quoted(MARKER_TABLE)} ORDER BY profile ASC`
    )
    .all() as MarkerRow[];
}

function allRows(db: DatabaseConnection, table: string): DatabaseRow[] {
  return db.prepare(`SELECT * FROM ${quoted(table)}`).all() as DatabaseRow[];
}

function isDemoOwnedTable(table: string): table is DemoOwnedTable {
  return (DEMO_OWNED_TABLES as readonly string[]).includes(table);
}

function isDemoId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(DEMO_ID_PREFIX);
}

function unrelatedRow(table: string, identifier: unknown): SeedOwnershipError {
  return new SeedOwnershipError(
    `Seed target has an unrelated row in ${table}: ${typeof identifier === "string" ? identifier : "unknown"}`
  );
}

function quoted(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
