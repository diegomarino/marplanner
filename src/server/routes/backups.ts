import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { registerRoutesWithCapabilities } from "../auth/capability";
import {
  listBackups,
  getDbGeneration,
  getLastBackupError,
  getLastPruneError,
  isValidBackupFilename,
  resolveBackupsRoot,
  resolveExistingBackupPath,
  openExistingBackupFd,
  unlinkBackupSidecars,
  wouldViolateFloor,
  formatBackupFilename,
  isValidSqliteFile,
  parseBackupFilename,
  UPLOAD_MAX_BYTES,
} from "../backups/storage";
import type { SnapshotOutcome } from "../backups/storage";
import { BACKUPS_JOB_ID } from "../backups/job";
import { restoreDatabase, isRestoreInProgress } from "../backups/restore";
import { runJobNow } from "../host-api";
import type { PluginLifecycle } from "../plugins/lifecycle";
import type {
  BackupErrorCode,
  BackupListResponse,
  RestoreRequest,
  RestoreResult,
  SnapshotResult,
  UploadResult,
} from "../../shared";

/** the generic `{error, message}`
 * envelope this file's non-restore routes send, TYPED against the closed `BackupErrorCode` union
 * rather than an ad hoc string literal — used at least everywhere `backup_failed` is sent. */
type BackupsErrorBody = { error: BackupErrorCode; message: string };

/** `RestoreResult["status"]` -> HTTP status code ("API surface"): 200 on success;
 * 400 validation/confirmation-mismatch; 404 vanished filename; 409 in-progress/floor/protected
 * (`retention_floor`/`protected_pre_restore` belong to the DELETE route's OWN status mapping, not
 * this restore route — included here only for the closed `BackupErrorCode` union's exhaustiveness,
 * `restoreDatabase` itself never returns them); 422 incompatible/downgrade; 413
 * upload-too-large (belongs to the upload route's own mapping, ditto — `restoreDatabase` never
 * returns it either); 500 pre-restore-failed/swap-failed/migration-failed-rolled-back (all three
 * ROLL BACK — the active DB is either untouched or restored to the pre-restore snapshot, never
 * left "restored" onto a failure); 503 quiesce-timeout (fail-safe abort, self-resolving — retry
 * shortly) AND rollback_failed .
 */
function statusCodeForRestoreResult(result: RestoreResult): number {
  if (result.status === "restored") return 200;
  switch (result.status) {
    case "validation_error":
    case "confirmation_mismatch":
      return 400;
    case "not_found":
      return 404;
    case "restore_in_progress":
    case "snapshot_in_progress":
    case "retention_floor":
    case "protected_pre_restore":
      return 409;
    case "incompatible_backup":
    case "downgrade_rejected":
    case "unsupported_lineage":
      return 422;
    case "upload_too_large":
      return 413;
    // "backup_failed" belongs to the snapshot route's own mapping, ditto —
    // `restoreDatabase` never returns it either; included only for `BackupErrorCode`'s
    // exhaustiveness, same precedent as "upload_too_large" above.
    case "pre_restore_failed":
    case "swap_failed":
    case "migration_failed_rolled_back":
    case "backup_failed":
      return 500;
    case "quiesce_timeout":
    case "rollback_failed":
      return 503;
  }
}

/** All backup routes require backups:admin. Manual snapshots share the scheduler's
 * in-flight guard with nightly snapshots. A failed snapshot returns backup_failed;
 * a missing scheduler returns scheduler_unavailable without exposing internals.
 * Restore receives the lifecycle reconciler so runtime state follows the reopened DB.
 */
export async function backupsRoutes(
  app: FastifyInstance,
  pluginLifecycle?: Pick<PluginLifecycle, "reconcileAll">
): Promise<void> {
  registerRoutesWithCapabilities(app, [
    {
      method: "get",
      path: "/api/backups",
      capability: "backups:admin",
      handler: async (_request: FastifyRequest, reply: FastifyReply) => {
        const body: BackupListResponse = {
          backups: listBackups(),
          dbGeneration: getDbGeneration(),
          lastBackupError: getLastBackupError(),
          //, C2 carry-forward: wired alongside the DTO + contract change (same move).
          lastPruneError: getLastPruneError(),
        };
        return reply.code(200).send(body);
      },
    },
    {
      method: "post",
      path: "/api/backups/snapshot",
      capability: "backups:admin",
      handler: async (_request: FastifyRequest, reply: FastifyReply) => {
        let runResult;
        try {
          runResult = await runJobNow(BACKUPS_JOB_ID, { source: "snapshot" });
        } catch {
          // A missing scheduler returns a stable envelope without internal error details.
          return reply.code(503).send({
            error: "scheduler_unavailable",
            message: "The backup scheduler is not available.",
          });
        }

        if (runResult.status === "already_running") {
          const body: SnapshotResult = { status: "already_running" };
          return reply.code(200).send(body);
        }

        if (runResult.status === "failed") {
          // follow-up: the scheduler core now surfaces a manual run's thrown action as a
          // typed `{status:"failed", error}` result instead of always resolving `completed` with
          // an undefined result. `createSnapshot` (this job's action) is defensive by design and
          // never actually throws — it always resolves its own `SnapshotOutcome` discriminated
          // union below — so this branch is a defensive fallback only, kept for exhaustiveness
          // against the scheduler's own type, never expected to execute in practice. A fixed
          // message, mirroring the sibling `outcome?.ok === false` branch just
          // below: `error` here is the scheduler's raw, untyped thrown value — unlike
          // `SnapshotOutcome.error` (always this module's own caught-and-logged message string),
          // it could be anything, so this genuinely-unreachable path never echoes it back.
          const body: BackupsErrorBody = {
            error: "backup_failed",
            message: "Snapshot creation failed",
          };
          return reply.code(500).send(body);
        }

        const outcome = runResult.result as SnapshotOutcome | undefined;
        if (!outcome || !outcome.ok) {
          // (storage.ts's reverse guard): a snapshot attempt (scheduled
          // or manual — both routed through this same action) that arrived while a restore is
          // in progress is a conflict, not a write failure — 409, distinct from the 500 every
          // other `SnapshotOutcome.ok:false` reason maps to below.
          if (outcome?.error === "restore_in_progress") {
            const conflictBody: BackupsErrorBody = {
              error: "restore_in_progress",
              message:
                "A restore is currently in progress; snapshots are refused until it completes",
            };
            return reply.code(409).send(conflictBody);
          }
          const body: BackupsErrorBody = {
            error: "backup_failed",
            message: outcome?.error ?? "Snapshot creation failed",
          };
          return reply.code(500).send(body);
        }

        const body: SnapshotResult = { status: "completed", filename: outcome.filename };
        return reply.code(200).send(body);
      },
    },
    {
      method: "post",
      path: "/api/backups/restore",
      capability: "backups:admin",
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as Partial<RestoreRequest> | null | undefined;
        const restoreRequest: RestoreRequest = {
          filename: typeof body?.filename === "string" ? body.filename : "",
          confirmFilename: typeof body?.confirmFilename === "string" ? body.confirmFilename : "",
        };
        const result = await restoreDatabase(restoreRequest, undefined, pluginLifecycle);
        if (result.status === "quiesce_timeout") {
          reply.header("Retry-After", "2");
        }
        return reply.code(statusCodeForRestoreResult(result)).send(result);
      },
    },
    {
      method: "delete",
      path: "/api/backups/:filename",
      capability: "backups:admin",
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        const { filename } = request.params as { filename: string };

        // 1. Allowlist first (400) — distinct from "doesn't exist" (404), mirroring the split
        // `resolveExistingBackupPath` itself makes internally (FR-012).
        if (!isValidBackupFilename(filename)) {
          return reply
            .code(400)
            .send({ error: "invalid_filename", message: "Invalid backup filename" });
        }
        // 2. Hardened existence + symlink/hardlink/traversal re-check — never distinguish
        // WHY a candidate was rejected (vanished vs. a planted symlink), same precedent as
        // restore.ts's own `not_found` mapping.
        const resolved = resolveExistingBackupPath(filename);
        if (!resolved) {
          return reply
            .code(404)
            .send({ error: "not_found", message: "The selected backup no longer exists" });
        }

        // 3. Protected pre-restore refusal (FR-009/US3 AC4, "In-memory
        // state"): the own literal wording is "target a pre-restore snapshot during a
        // restore... refused" — read precisely (implementation scope), this refuses deleting ANY
        // pre-restore-type file while ANY restore is in progress (not narrowed to "the newest"
        // or "the one this restore itself created" — at the point a restore acquires its lock it
        // has not yet written its OWN pre-restore snapshot, so narrowing to "the depended-on one"
        // is not even resolvable at request time; the conservative superset is the safe, correct
        // reading). Deletes of NON-pre-restore files are deliberately NOT blocked here: the
        // restore engine re-reads its candidate path at the swap step and already has a rollback
        // net (`swap_failed` -> `rollbackToPreRestore`) for a source file vanishing out from
        // under it mid-sequence, so a broader "refuse every delete while a restore runs" guard
        // would add no additional safety, only unnecessary friction against the (also-safe)
        // legitimate case of tidying an unrelated old backup during a long-running restore.
        const parsed = parseBackupFilename(filename);
        if (parsed?.type === "pre-restore" && isRestoreInProgress()) {
          return reply.code(409).send({
            error: "protected_pre_restore",
            message: "A restore is in progress; the pre-restore snapshot cannot be deleted",
          });
        }

        // 4. Retention floor (FR-013/— "explicit delete MUST respect the
        // retention floor"), reusing storage.ts's exact `wouldViolateFloor` rule (
        // — "explicit delete reuses the same floor check"). No-op for pre-restore/upload types.
        const listing = listBackups();
        if (wouldViolateFloor(listing, filename)) {
          return reply.code(409).send({
            error: "retention_floor",
            message: "Deleting this backup would drop the regular shelf below its retention floor",
          });
        }

        try {
          fs.unlinkSync(resolved);
        } catch {
          // Vanished between the hardened resolve above and this unlink (a narrow TOCTOU window,
          // e.g. a concurrent delete of the same file) — the never-trust-the-stale-list case.
          return reply
            .code(404)
            .send({ error: "not_found", message: "The selected backup no longer exists" });
        }
        //: a readonly open
        // elsewhere (isValidSqliteFile / download-sql / checkVersionGate) may have left
        // `-wal`/`-shm` sidecars next to this exact file — sweep them here too, rather than
        // waiting for the next boot sweep. This is one of the two allowed sweep points: deleting
        // the backup's own main file already implies nobody else can legitimately still be
        // reading it (see `unlinkBackupSidecars`'s doc comment, storage.ts).
        unlinkBackupSidecars(resolved);
        return reply.code(204).send();
      },
    },
    {
      method: "get",
      path: "/api/backups/:filename/download",
      capability: "backups:admin",
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        const { filename } = request.params as { filename: string };
        if (!isValidBackupFilename(filename)) {
          return reply
            .code(400)
            .send({ error: "invalid_filename", message: "Invalid backup filename" });
        }
        const resolved = resolveExistingBackupPath(filename);
        if (!resolved) {
          return reply
            .code(404)
            .send({ error: "not_found", message: "The selected backup no longer exists" });
        }
        //: O_NOFOLLOW open + fstat re-check IMMEDIATELY before
        // streaming — closes the validate-then-reopen-by-path TOCTOU window between
        // `resolveExistingBackupPath`'s lstat/realpath validation above and the actual
        // byte-level read a plain `fs.createReadStream(resolved)` would have performed.
        const fd = openExistingBackupFd(resolved);
        if (fd === null) {
          return reply
            .code(404)
            .send({ error: "not_found", message: "The selected backup no longer exists" });
        }
        let sizeBytes: number;
        try {
          sizeBytes = fs.fstatSync(fd).size;
        } catch {
          try {
            fs.closeSync(fd);
          } catch {
            /* best-effort */
          }
          return reply
            .code(404)
            .send({ error: "not_found", message: "The selected backup no longer exists" });
        }
        // Sensitive (FR-013): the raw household database, byte for byte — same
        // `backups:admin` capability class as every other route here, no separate allowance.
        reply
          .header("content-type", "application/octet-stream")
          .header("content-disposition", `attachment; filename="${filename}"`)
          .header("content-length", String(sizeBytes));
        // Streamed from the SAME already-validated fd (never re-opened by path) — `autoClose`
        // closes it once the stream ends or errors.
        return reply.send(fs.createReadStream("", { fd, autoClose: true }));
      },
    },
    {
      method: "get",
      path: "/api/backups/:filename/download-sql",
      capability: "backups:admin",
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        const { filename } = request.params as { filename: string };
        if (!isValidBackupFilename(filename)) {
          return reply
            .code(400)
            .send({ error: "invalid_filename", message: "Invalid backup filename" });
        }
        const resolved = resolveExistingBackupPath(filename);
        if (!resolved) {
          return reply
            .code(404)
            .send({ error: "not_found", message: "The selected backup no longer exists" });
        }
        //: an in-process, read-only export (readonly connection over `sqlite_master`
        // + a proper-quoting serializer) — never an external `sqlite3` binary shell-out (ADR-042
        // removed that dependency; CI has no binary guarantee). Explicitly NOT re-importable —
        // the header comment inside the stream itself says so (dumpBackupSqlChunks).
        //
        // `isValidSqliteFile` runs FIRST, synchronously, in this handler — `createSqlDumpStream`
        // below wraps a GENERATOR, whose body (including its own `new Database` open) does not
        // execute until the stream is first pulled from, well after this handler has returned; a
        // bad file discovered only THEN would surface as a mid-response stream error, not a clean
        // 400. Validating eagerly here keeps every error path a normal HTTP response.
        if (!isValidSqliteFile(resolved)) {
          return reply.code(400).send({
            error: "invalid_backup_file",
            message: "The selected file could not be read as SQLite",
          });
        }
        reply
          .header("content-type", "text/plain; charset=utf-8")
          .header("content-disposition", `attachment; filename="${filename}.sql"`);
        return reply.send(createSqlDumpStream(resolved, filename));
      },
    },
  ]);

  await registerUploadRoute(app);
}

// ─── Upload ────────────────────────────────────────────────

/** Upload registered on its OWN encapsulated Fastify child context (`app.register(async
 * (scope) => {...})`), not directly on `app` like every other route above. Two things need to be
 * scoped to ONLY this route, never leaking onto the rest of the API surface:
 * 1. A custom `application/octet-stream` content-type parser (Fastify has none built in) with
 * a HARD `bodyLimit: UPLOAD_MAX_BYTES` — Fastify's own raw-body parser checks the
 * `Content-Length` header (or the running byte count for a chunked body) against that limit
 * BEFORE this handler ever runs, so an oversized upload is rejected with ZERO bytes ever
 * written to disk (the "size cap enforced BEFORE any disk write") — this route
 * never has to implement that check itself.
 * 2. A `setErrorHandler` that maps Fastify's own `FST_ERR_CTP_BODY_TOO_LARGE` (raised by that
 * parser, BEFORE the handler runs, so it would otherwise reach Fastify's generic default
 * error envelope) to the contract's closed `{error, message}` `BackupsError` shape at 413.
 * Fastify's plugin encapsulation means a child scope's own `addContentTypeParser`/
 * `setErrorHandler` never affects the parent `app` or its other routes, while hooks registered on
 * `app` BEFORE this call (the quiesce onRequest hook, `authBoundary`, `accessGate`) are still
 * inherited — only decorators/parsers/error-handlers set INSIDE this child scope are scoped to it.
 */
async function registerUploadRoute(app: FastifyInstance): Promise<void> {
  await app.register(async (scope: FastifyInstance) => {
    scope.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer", bodyLimit: UPLOAD_MAX_BYTES },
      (_request, body, done) => done(null, body)
    );

    //: this handler used to
    // echo `error.message` straight through on the generic fallback branch — contradicting the
    // internals-free-envelope precedent every other route in this file follows (a fixed, stable,
    // English message on every OTHER error path). Every branch below now sends a fixed message;
    // the raw error is only ever logged server-side.
    scope.setErrorHandler(
      (error: Error & { code?: string; statusCode?: number }, _request, reply) => {
        if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
          return reply.code(413).send({
            error: "upload_too_large",
            message: `Upload exceeds the ${UPLOAD_MAX_BYTES}-byte size cap; nothing was written to disk`,
          });
        }
        if (error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
          return reply.code(415).send({
            error: "unsupported_media_type",
            message: "Upload must be sent as application/octet-stream",
          });
        }
        console.error("Backups: upload route error handler caught an unexpected error:", error);
        const statusCode =
          typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 600
            ? error.statusCode
            : 500;
        return reply.code(statusCode).send({
          error: "upload_failed",
          message: "Upload failed",
        });
      }
    );

    registerRoutesWithCapabilities(scope, [
      {
        method: "post",
        path: "/api/backups/upload",
        capability: "backups:admin",
        handler: async (request: FastifyRequest, reply: FastifyReply) => {
          const uploadedBody = request.body;
          if (!Buffer.isBuffer(uploadedBody) || uploadedBody.length === 0) {
            return reply.code(400).send({
              error: "invalid_upload",
              message: "Upload body must be a non-empty application/octet-stream payload",
            });
          }

          const root = resolveBackupsRoot();
          const existing = fs.readdirSync(root);
          const filename = formatBackupFilename("upload", Date.now(), existing);
          const tmpPath = path.join(root, `.tmp-${filename}`);
          const finalPath = path.join(root, filename);

          try {
            fs.writeFileSync(tmpPath, uploadedBody);
          } catch {
            try {
              fs.unlinkSync(tmpPath);
            } catch {
              /* best-effort */
            }
            return reply
              .code(500)
              .send({ error: "upload_failed", message: "Failed to write the uploaded file" });
          }

          // / FR-011: `.sql` (and any non-SQLite payload) rejection IS this check —
          // uploads carry no client-supplied filename to inspect an extension against (the body
          // is raw `application/octet-stream`), so the actual gate is "does this parse as a real
          // SQLite database" (`isValidSqliteFile`, storage.ts).
          if (!isValidSqliteFile(tmpPath)) {
            try {
              fs.unlinkSync(tmpPath);
            } catch {
              /* best-effort */
            }
            return reply.code(400).send({
              error: "invalid_backup_file",
              message: "The uploaded file is not a valid SQLite backup",
            });
          }

          try {
            fs.renameSync(tmpPath, finalPath);
          } catch {
            try {
              fs.unlinkSync(tmpPath);
            } catch {
              /* best-effort */
            }
            return reply
              .code(500)
              .send({ error: "upload_failed", message: "Failed to store the uploaded file" });
          }

          const result: UploadResult = { filename };
          return reply.code(200).send(result);
        },
      },
    ]);
  });
}

// ─── download-sql: in-process SQL dump ───────────────────────────

function quoteSqlIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteSqlValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return `X'${value.toString("hex")}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildInsertStatement(
  table: string,
  columns: string[],
  row: Record<string, unknown>
): string {
  const cols = columns.map(quoteSqlIdentifier).join(", ");
  const vals = columns.map((c) => quoteSqlValue(row[c])).join(", ");
  return `INSERT INTO ${quoteSqlIdentifier(table)} (${cols}) VALUES (${vals});\n`;
}

/** Lazily emit a human-inspectable SQL dump of the backup at `dbPath`: opens a
 * READONLY connection, iterates `sqlite_master` for `table`/`index`/`trigger` objects (`sqlite_`
 * internal bookkeeping tables — SQLite's own, not `drizzle_universe_migrations`, which IS a real
 * application table and is included — are skipped), emits each object's own `CREATE` statement
 * verbatim, and for every TABLE additionally emits one `INSERT` per row via `.iterate` (a true
 * row-at-a-time generator over the connection, not a bulk `.all` — the row data is never fully
 * buffered in memory before being handed to the HTTP response stream). The header comment is the
 * "NOT re-importable" documentation requires — this is a read-only export, not a
 * backup format; the version-gate/restore machinery never consumes this output.
 * this generator's body — including the `new Database` open
 * below — does not run until Fastify first pulls from the stream, potentially well after the
 * route handler's own eager `isValidSqliteFile` check ran, and long after `resolveExistingBackupPath`
 * validated `dbPath`. Re-validated here via the fd-level O_NOFOLLOW+fstat check
 * (`openExistingBackupFd`) IMMEDIATELY before opening — the closest this in-process export can
 * get to a TOCTOU-safe open, since better-sqlite3 itself only ever accepts a PATH, never a fd; the
 * residual window between this check's `closeSync` and better-sqlite3's own internal open is an
 * accepted, documented gap .
 * this readonly open deliberately does NOT
 * sweep its own `-wal`/`-shm` sidecars on completion. `dbPath` is a genuine shelf file another
 * request may be concurrently reading (e.g. a second overlapping download-sql export of the SAME
 * backup, or a restore's version gate) — sidecars are SHARED SQLite lock/state, not a
 * per-connection temporary, so unlinking them while another connection on this exact file is still
 * open can split lock state or break that connection's subsequent reads. Any sidecar this open
 * creates is left for the boot-time sweep or a later DELETE to collect (`unlinkBackupSidecars`'s * doc comment, storage.ts, names the two allowed sweep points).
 */
function* dumpBackupSqlChunks(dbPath: string, sourceFilename: string): Generator<string> {
  const revalidateFd = openExistingBackupFd(dbPath);
  if (revalidateFd === null) {
    throw new Error("Backup file failed fd re-validation immediately before the SQL dump open");
  }
  fs.closeSync(revalidateFd);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    yield "-- marplanner backup SQL export\n";
    yield "-- Produced in-process, read-only. This is a human-inspectable dump, NOT re-importable\n";
    yield "-- — it is not a backup format, and the restore engine never reads this output.\n";
    yield `-- source: ${sourceFilename}\n\n`;

    const objects = db
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
         WHERE type IN ('table', 'index', 'trigger')
           AND sql IS NOT NULL
           AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
         ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`
      )
      .all() as { type: "table" | "index" | "trigger"; name: string; sql: string }[];

    for (const object of objects) {
      yield `${object.sql};\n`;
      if (object.type === "table") {
        const columns = (
          db.prepare(`PRAGMA table_info(${quoteSqlIdentifier(object.name)})`).all() as {
            name: string;
          }[]
        ).map((c) => c.name);
        const rows = db
          .prepare(`SELECT * FROM ${quoteSqlIdentifier(object.name)}`)
          .iterate() as IterableIterator<Record<string, unknown>>;
        for (const row of rows) {
          yield buildInsertStatement(object.name, columns, row);
        }
      }
      yield "\n";
    }
  } finally {
    db.close();
  }
}

/** Wrap `dumpBackupSqlChunks`'s generator in a Readable. The generator's body — including its
 * own `new Database` open — does NOT run until the stream is first pulled from (standard JS
 * generator semantics), so callers MUST validate `dbPath` opens as SQLite BEFORE calling this
 * (the download-sql route handler does, via `isValidSqliteFile`) rather than relying on this
 * function to throw synchronously — it never does. */
function createSqlDumpStream(dbPath: string, sourceFilename: string): Readable {
  return Readable.from(dumpBackupSqlChunks(dbPath, sourceFilename), { objectMode: false });
}
