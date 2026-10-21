// Code-first OpenAPI: route schemas for the backups HTTP surface.
// These zod schemas are the single source of truth for docs/api/openapi.json
// (npm run generate:openapi). They document the HTTP contract; validation stays in
// src/server/modules/* so error envelopes remain byte-compatible.
import { z } from "zod";
import { component, defineRouteSchemas, noContent } from "./zod";
import {
  AuthForbidden,
  AuthUnauthorized,
  PluginUnavailable,
  authenticationBackoffResponse,
} from "./common";

export const BackupType = component(
  "BackupType",
  z.enum(["scheduled", "snapshot", "pre-restore", "upload"])
);

export const BackupListItem = component(
  "BackupListItem",
  z.strictObject({ filename: z.string(), type: BackupType, createdAt: z.int(), sizeBytes: z.int() })
);

export const BackupListResponse = component(
  "BackupListResponse",
  z.strictObject({
    backups: z.array(BackupListItem),
    dbGeneration: z.int(),
    lastBackupError: z.string().nullable(),
    lastPruneError: z.string().nullable(),
  })
);

export const BackupsError = component(
  "BackupsError",
  z.strictObject({ error: z.string(), message: z.string() })
);

export const DumpInternalError = component(
  "DumpInternalError",
  z.strictObject({
    statusCode: z.literal(500),
    error: z.literal("Internal Server Error"),
    message: z.string(),
  })
);

export const Quiescing = component(
  "Quiescing",
  z.strictObject({ error: z.literal("quiescing"), message: z.string() })
);

export const RestoreRequest = component(
  "RestoreRequest",
  z.strictObject({ filename: z.string(), confirmFilename: z.string() })
);

export const RestoreResult = component(
  "RestoreResult",
  z.xor([
    z.strictObject({ status: z.enum(["restored"]), dbGeneration: z.int(), migrated: z.boolean() }),
    z.strictObject({
      status: z.enum([
        "validation_error",
        "confirmation_mismatch",
        "incompatible_backup",
        "downgrade_rejected",
        "unsupported_lineage",
        "restore_in_progress",
        "snapshot_in_progress",
        "quiesce_timeout",
        "pre_restore_failed",
        "swap_failed",
        "migration_failed_rolled_back",
        "rollback_failed",
        "retention_floor",
        "protected_pre_restore",
        "upload_too_large",
        "backup_failed",
        "not_found",
      ]),
      message: z.string().optional(),
    }),
  ])
);

export const SnapshotResult = component(
  "SnapshotResult",
  z.xor([
    z.strictObject({ status: z.enum(["completed"]), filename: z.string() }),
    z.strictObject({ status: z.enum(["already_running"]) }),
  ])
);

export const UploadResult = component("UploadResult", z.strictObject({ filename: z.string() }));

export const backupsSchemas = defineRouteSchemas({
  /** GET /api/backups */
  listBackups: {
    operationId: "listBackups",
    tags: ["backups"],
    summary: "List the backup shelf (file-derived; backups:admin)",
    security: [{ deviceKeyCookie: [] }],
    response: {
      200: {
        description: "Newest-first shelf listing.",
        content: { "application/json": { schema: BackupListResponse } },
      },
      401: {
        description:
          "Missing, ambiguous or invalid API credential (shared authentication boundary).",
        content: { "application/json": { schema: AuthUnauthorized } },
      },
      403: {
        description:
          "Revoked/expired credential or denied capability; code distinguishes credential loss from scope denial.",
        content: { "application/json": { schema: AuthForbidden } },
      },
      429: authenticationBackoffResponse,
      503: {
        description:
          "The owning plugin is inactive or unavailable. Ordinary API traffic is also unavailable during quiescent restore.",
        content: { "application/json": { schema: z.union([PluginUnavailable, Quiescing]) } },
      },
    },
  },
  /** POST /api/backups/restore */
  restoreBackup: {
    operationId: "restoreBackup",
    tags: ["backups"],
    summary: "Restore a backup (typed-filename confirmation; ADR-017 sequence)",
    security: [{ deviceKeyCookie: [] }],
    body: RestoreRequest,
    response: {
      200: {
        description: "Restored; clients should reload (dbGeneration bumped).",
        content: { "application/json": { schema: RestoreResult } },
      },
      400: {
        description: "Validation error or typed-confirmation mismatch — no side effects.",
        content: { "application/json": { schema: RestoreResult } },
      },
      401: {
        description:
          "Missing, ambiguous or invalid API credential (shared authentication boundary).",
        content: { "application/json": { schema: AuthUnauthorized } },
      },
      404: {
        description:
          "The named backup vanished between list and action (or failed the F9 hardened resolve).",
        content: { "application/json": { schema: RestoreResult } },
      },
      409: {
        description: "A restore or snapshot is already in progress.",
        content: { "application/json": { schema: RestoreResult } },
      },
      422: {
        description:
          "Incompatible backup, unsupported lineage, or downgrade rejected (fail-closed version gate).",
        content: { "application/json": { schema: RestoreResult } },
      },
      429: authenticationBackoffResponse,
      500: {
        description:
          "Pre-restore snapshot failed (aborted untouched); a swap failure (WAL/SHM cleanup or copy/rename, rolled back losslessly); or a forward migration failure (rolled back losslessly).\n",
        content: { "application/json": { schema: RestoreResult } },
      },
      503: {
        description: "The owning plugin is inactive or unavailable.",
        content: { "application/json": { schema: z.union([RestoreResult, PluginUnavailable]) } },
      },
    },
  },
  /** POST /api/backups/snapshot */
  createSnapshot: {
    operationId: "createSnapshot",
    tags: ["backups"],
    summary: "Create a snapshot now (routes through the scheduler's manual entry)",
    security: [{ deviceKeyCookie: [] }],
    response: {
      200: {
        description: "Completed (with filename) or an honest already_running.",
        content: { "application/json": { schema: SnapshotResult } },
      },
      409: {
        description:
          "A restore is currently in progress; snapshots are refused until it completes.",
        content: { "application/json": { schema: BackupsError } },
      },
      429: authenticationBackoffResponse,
      500: {
        description:
          "The snapshot write itself failed (e.g. ENOSPC) — error \"backup_failed\". `backup_failed` IS a member of the closed RestoreResult error-code enum above (F7, review #636/#637) — included there only for that union's exhaustiveness, since `restoreDatabase` itself never returns it, same precedent as `upload_too_large`. The failure is also surfaced via GET /api/backups's lastBackupError field and server logs.\n",
        content: { "application/json": { schema: BackupsError } },
      },
      503: {
        description: "The owning plugin is inactive or unavailable.",
        content: { "application/json": { schema: z.union([BackupsError, PluginUnavailable]) } },
      },
    },
  },
  /** POST /api/backups/upload */
  uploadBackup: {
    operationId: "uploadBackup",
    tags: ["backups"],
    summary: "Upload a.db backup (size-capped before writing;.sql rejected)",
    security: [{ deviceKeyCookie: [] }],
    consumes: ["application/octet-stream"],
    body: z.string().meta({ format: "binary" }),
    response: {
      200: {
        description: "Stored on the shelf with an upload- prefix.",
        content: { "application/json": { schema: UploadResult } },
      },
      400: {
        description: "Not a SQLite file / empty body (.sql is rejected via this same check).",
        content: { "application/json": { schema: BackupsError } },
      },
      401: {
        description:
          "Missing, ambiguous or invalid API credential (shared authentication boundary).",
        content: { "application/json": { schema: AuthUnauthorized } },
      },
      403: {
        description:
          "Revoked/expired credential or denied capability; code distinguishes credential loss from scope denial.",
        content: { "application/json": { schema: AuthForbidden } },
      },
      413: {
        description: "Over the size cap; zero bytes written.",
        content: { "application/json": { schema: BackupsError } },
      },
      415: {
        description:
          "Unsupported Content-Type — this route only accepts application/octet-stream (F4, independent review of #639/#640).\n",
        content: { "application/json": { schema: BackupsError } },
      },
      429: authenticationBackoffResponse,
      500: {
        description:
          "An unexpected failure inside the upload route (e.g. a disk write or rename failure). A stable, English, internals-free upload_failed envelope — never the raw thrown message (F4, independent review of #639/#640).\n",
        content: { "application/json": { schema: BackupsError } },
      },
      503: {
        description: "The owning plugin is inactive or unavailable.",
        content: { "application/json": { schema: PluginUnavailable } },
      },
    },
  },
  /** DELETE /api/backups/{filename} */
  deleteBackup: {
    operationId: "deleteBackup",
    tags: ["backups"],
    summary: "Delete a backup (respects the retention floor; protected pre-restore refused)",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ filename: z.string() }),
    response: {
      204: noContent("Deleted."),
      400: {
        description: "Invalid filename (allowlist/traversal).",
        content: { "application/json": { schema: BackupsError } },
      },
      401: {
        description:
          "Missing, ambiguous or invalid API credential (shared authentication boundary).",
        content: { "application/json": { schema: AuthUnauthorized } },
      },
      403: {
        description:
          "Revoked/expired credential or denied capability; code distinguishes credential loss from scope denial.",
        content: { "application/json": { schema: AuthForbidden } },
      },
      404: {
        description: "The named backup vanished between list and action.",
        content: { "application/json": { schema: BackupsError } },
      },
      409: {
        description:
          "Floor violation (retention_floor) or a pre-restore snapshot targeted while a restore is in progress (protected_pre_restore).\n",
        content: { "application/json": { schema: BackupsError } },
      },
      429: authenticationBackoffResponse,
      503: {
        description: "The owning plugin is inactive or unavailable.",
        content: { "application/json": { schema: PluginUnavailable } },
      },
    },
  },
  /** GET /api/backups/{filename}/download */
  downloadBackup: {
    operationId: "downloadBackup",
    tags: ["backups"],
    summary: "Download a backup file (sensitive; backups:admin)",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ filename: z.string() }),
    response: {
      200: {
        description: "The backup file.",
        content: { "application/octet-stream": { schema: z.string().meta({ format: "binary" }) } },
      },
      400: {
        description: "Invalid filename.",
        content: { "application/json": { schema: BackupsError } },
      },
      401: {
        description:
          "Missing, ambiguous or invalid API credential (shared authentication boundary).",
        content: { "application/json": { schema: AuthUnauthorized } },
      },
      403: {
        description:
          "Revoked/expired credential or denied capability; code distinguishes credential loss from scope denial.",
        content: { "application/json": { schema: AuthForbidden } },
      },
      404: {
        description: "The named backup vanished between list and action.",
        content: { "application/json": { schema: BackupsError } },
      },
      429: authenticationBackoffResponse,
      503: {
        description: "The owning plugin is inactive or unavailable.",
        content: { "application/json": { schema: PluginUnavailable } },
      },
    },
  },
  /** GET /api/backups/{filename}/download-sql */
  downloadBackupSql: {
    operationId: "downloadBackupSql",
    tags: ["backups"],
    summary: "Read-only in-process SQL export (never re-importable)",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ filename: z.string() }),
    response: {
      200: { description: "SQL text export.", content: { "text/plain": { schema: z.string() } } },
      400: {
        description: "Invalid filename, or the file could not be read as SQLite.",
        content: { "application/json": { schema: BackupsError } },
      },
      401: {
        description:
          "Missing, ambiguous or invalid API credential (shared authentication boundary).",
        content: { "application/json": { schema: AuthUnauthorized } },
      },
      403: {
        description:
          "Revoked/expired credential or denied capability; code distinguishes credential loss from scope denial.",
        content: { "application/json": { schema: AuthForbidden } },
      },
      404: {
        description: "The named backup vanished between list and action.",
        content: { "application/json": { schema: BackupsError } },
      },
      429: authenticationBackoffResponse,
      500: {
        description: "Opening or re-validating the SQL dump source failed before streaming.",
        content: { "application/json": { schema: DumpInternalError } },
      },
      503: {
        description: "The owning plugin is inactive or unavailable.",
        content: { "application/json": { schema: PluginUnavailable } },
      },
    },
  },
});
