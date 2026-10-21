// Document-level OpenAPI metadata: info, tags (one per HTTP domain) and security schemes.
// Route-level contracts live beside each domain in src/server/openapi/<domain>.ts.

export const API_INFO = {
  title: "Marplanner HTTP API",
  version: "1.0.0",
  description:
    "Household planning API served by the Marplanner backend. Everything under `/api/*` requires the `mp_device_key` device cookie minted by `POST /api/auth/provision` (the plugin-management subtree `/api/plugins*` also admits an integration bearer key); `/health` is public. This document is generated from the zod route schemas in `src/server/openapi/` (`npm run generate:openapi`).",
};

export const API_TAGS = [
  {
    name: "bootstrap",
    description:
      "**Marplanner foundation API**\n\nHealth, frontend access, device provisioning, PIN verification and household settings. Device cookies authorize the API. Effective settings contain only active contributions; the UI PIN is advisory.",
  },
  {
    name: "settings",
    description:
      "**Marplanner — Settings registry API**\n\nRead the effective settings projection (core locale plus the settings objects of active plugins) and atomically replace one registered settings object. The UI PIN does not authorize writes.",
  },
  {
    name: "members",
    description:
      "**Marplanner — Members referential root API**\n\nMember creation, editing, archive and restore. Member roles and lifecycle are validated independently from API credential capabilities. Historical records remain readable after archival.",
  },
  {
    name: "day-periods",
    description:
      "**Marplanner — Day Periods vocabulary API**\n\nThe fixed four household day periods and their editable start times. Ordering and uniqueness are validated; end boundaries derive from the next start.",
  },
  {
    name: "chores",
    description:
      "**Marplanner — Household Daily Chores Board API**\n\nRoutines, member assignments, dated completion and derived streaks. Active-member validation applies on writes; historical reads tolerate archived members.",
  },
  {
    name: "calendar",
    description:
      "**Marplanner — Calendar local feed API**\n\nLocal and imported events, recurrence, member assignment, highlight rules and source metadata. Timed events preserve UTC instants and originating timezones; all-day dates use exclusive end boundaries.\n\n**Marplanner Calendar Feed Synchronization API**\n\nExternal calendar source configuration, synchronization and safe diagnostics. Fetch validation rejects private network destinations; writes reconcile complete source results atomically.",
  },
  {
    name: "meals",
    description:
      "**Marplanner — Meals & Recipes API**\n\nRecipe catalogue, meal types and additive dated or recurring meal entries. Deleting a recipe requires an informed cascade; read projections remain derived from current data.",
  },
  {
    name: "reminders",
    description:
      "**Marplanner — Scheduled Reminders API**\n\nScheduled reminder CRUD, assignment replacement, and live emissions. Supports all-member and explicit-member modes. Assignment replacement is atomic; the advisory UI PIN does not authorize backend requests.\n\n**Marplanner — Calendar-gated Reminders API delta**\n\nCalendar-gated reminders extend scheduled reminder CRUD and assignments with query rules and dry-run explanations. Request shapes are discriminated by reminder kind.",
  },
  {
    name: "daily-messages",
    description:
      "**Marplanner — Daily Messages API**\n\nPer-member daily messages with strict dates and text validation. Writes require an active member; reads preserve archived-member history and reject unknown members. The device-key cookie authorizes backend access.",
  },
  {
    name: "daily-briefing",
    description:
      "**Marplanner — Daily Briefing API**\n\nBriefing block configuration, generation, preview and print integration. The server composes and renders content; printing uses the current registered provider at execution time.\n\n**Marplanner — Daily Briefing API**\n\nMember briefing generation, opt-in settings, snapshots and status. Calendar, chores, reminders, meals and messages are read through their owning domain interfaces.",
  },
  {
    name: "time-announcements",
    description:
      "**Marplanner — Time Announcements API**\n\nRule-CRUD surface for. The server owns rule DATA ONLY — firing is entirely client-side (ADR-051 as reconciled by ADR-065): no server-side scheduler job, queue row, claim, or staleness sweep exists for announcements, so this contract is the domain's WHOLE server surface (drift-checked by tools/check-openapi-drift.mjs). Writes require the time-announcements:admin capability (fail-closed via registerRoutesWithCapabilities, telemetry precedent); the list is kiosk-visible behind the standard auth boundary (TIME-ANNOUNCEMENTS-AC-07). Validation is strict-reject, never normalize (TIME-ANNOUNCEMENTS-INV-02/03); the active-overlap check runs inside the write transaction on POST and PATCH (TIME-ANNOUNCEMENTS-INV-04).",
  },
  {
    name: "weather",
    description:
      "**Marplanner — Weather API**\n\nHousehold location settings and forecast reads. Location may be unset. Provider unavailability is explicit; inactive plugin settings are omitted from effective settings.",
  },
  {
    name: "printing",
    description:
      "**marplanner printing**\n\nDurable printing jobs, printer capability registration, fenced claims, payloads, acknowledgement and failure reporting. Printed state requires a valid acknowledgement. The browser performs physical transport.",
  },
  {
    name: "network-devices",
    description:
      '**Marplanner — Network Devices API**\n\nRegistered network devices, live controller inventory and block state. Every route requires an active credential with the network:admin (or full "*") capability; a normally provisioned household device qualifies. Provider failures use safe typed errors.',
  },
  {
    name: "backups",
    description:
      "**Marplanner — Backups API**\n\nSnapshot, shelf, download, upload, delete and quiescent restore operations. Requires backups:admin capability. Restore validates compatibility and takes a pre-restore snapshot before replacing the database.",
  },
  {
    name: "telemetry",
    description:
      "**Marplanner Client Logging / Telemetry API**\n\nTelemetry ingest + admin read. Ingest is best-effort at-most-once: a well-formed batch ALWAYS returns 200 (accepted/dropped counts), never 429 and never per-entry errors the client would react to. Redaction and bounding happen server-side before storage (Constitution II). Capabilities: telemetry:write (ingest) / telemetry:admin (read); full-access ('*') keys satisfy both.",
  },
  {
    name: "plugins",
    description:
      "**Marplanner Plugin Lifecycle API**\n\nAuthenticated first-party plugin catalog and lifecycle mutations for. Canonical plugin state is active, inactive, or errored; operation is a separate transient projection. The API never accepts or returns the admin PIN or raw errors.",
  },
  {
    name: "docs",
    description:
      "**API documentation**\n\nThe generated OpenAPI document and its interactive reference UI (`/api/docs`). Same authentication as the rest of `/api/*`.",
  },
];

export const SECURITY_SCHEMES: Record<string, Record<string, string>> = {
  deviceKeyCookie: {
    type: "apiKey",
    in: "cookie",
    name: "mp_device_key",
    description:
      "The minted `*` device key (an `mpk-…` value). Set HttpOnly+Secure+SameSite=Lax at provisioning; never readable by client JS and never echoed in any response body.\n",
  },
  integrationKey: {
    type: "http",
    scheme: "bearer",
    description: "Existing raw-header integration credential whose live scopes include `*`.",
  },
};
