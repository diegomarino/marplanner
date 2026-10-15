import { LocalizedApiError, responseMessage as readResponseMessage } from "@/lib/api-error";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/credential";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { STATUS_BANNER_CLASSES, TYPE_PILL_CLASSES } from "@/lib/recipes";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { AdminPanel } from "@/components/AdminPanel";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Field } from "@/components/Field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  BackupErrorCode,
  BackupListItem,
  BackupListResponse,
  BackupType,
  RestoreRequest,
  RestoreResult,
  SnapshotResult,
  UploadResult,
} from "../../shared";

/* ------------------------------------------------------------------ */
/* BackupsManagement — the admin panel: list */
/* (household-local times, lastBackupError/lastPruneError surfaces), */
/* snapshot-now (already_running notice), restore (TYPED-CONFIRM */
/* input; reload-on-success per D8's dbGeneration reload */
/* signal), delete (refusal messages), download/download-sql links, */
/* and upload. FR-014 (slice-local, no guarantee traced) + the panel */
/* half of BACKUPS-AC-05 (filenames are always allowlist-safe by */
/* construction here — every write path goes through the server's */
/* hardened resolver; this UI never constructs a path itself). */
/* */
/* Action failures are translated by stable codes. Historical backup/prune */
/* diagnostic strings remain operational log content. */
/* */
/* (token dialect, FR-009): migrated to the shared L2 */
/* components — AdminPanel for the panel frame, ErrorNotice */
/* for every error/refusal surface (SC-011: the ONE way a migrated */
/* surface announces an error), Field for the two labelled inputs */
/* (the restore-confirm typed input and the upload file input, the */
/* latter closing this file's one accessible-names-baseline row, */
/* /). */
/* */
/* Restore keeps the stronger BACKUPS-AC-01 typed-exact-filename */
/* confirmation. adds ConfirmDialog to deletion so the */
/* destructive operation requires an explicit second action (FR-019). */
/* ------------------------------------------------------------------ */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Exported so the migration spec can pin every entry by ITERATING this map, per the current
 * verification policy (verification policy). NOTE on why the iteration shape stops short of the
 * fully-mechanical `` `backups.management.type.${k}` `` form for every key: three of the four
 * keys ARE derivable that way (`scheduled`, `snapshot`, `upload`), but `"pre-restore"` maps to
 * `.preRestore` — a hyphen-to-camelCase transform, not a plain template substitution. The spec
 * asserts the mechanically-derivable three by iteration and the fourth against the CATALOGUE
 * value directly (both locales), which is the documented escape hatch for a map whose keys are
 * not UNIFORMLY derivable from the domain key (verification policy, "assert each pair
 * against the RENDERED output instead... and say in the body why the map is not derivable"). */
export const TYPE_KEYS: Record<BackupType, MessageKey> = {
  scheduled: "backups.management.type.scheduled",
  snapshot: "backups.management.type.snapshot",
  "pre-restore": "backups.management.type.preRestore",
  upload: "backups.management.type.upload",
};

/** Relative label for ages up to 30 days; `null` means "show the absolute date instead". */
export function formatRelativeAge(createdAt: number, now: number, language: string): string | null {
  const seconds = Math.max(0, Math.trunc((now - createdAt) / 1000));
  const rtf = new Intl.RelativeTimeFormat(language === "es" ? "es-ES" : "en-GB", {
    numeric: "auto",
  });
  if (seconds < 60) return rtf.format(0, "second");
  const minutes = Math.trunc(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, "minute");
  const hours = Math.trunc(minutes / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  const days = Math.trunc(hours / 24);
  return days <= 30 ? rtf.format(-days, "day") : null;
}

export function isDbFile(name: string): boolean {
  return name.toLowerCase().endsWith(".db");
}

export const BACKUP_ERROR_KEYS: Record<BackupErrorCode, MessageKey> = {
  validation_error: "backups.error.validation_error",
  confirmation_mismatch: "backups.error.confirmation_mismatch",
  incompatible_backup: "backups.error.incompatible_backup",
  downgrade_rejected: "backups.error.downgrade_rejected",
  unsupported_lineage: "backups.error.unsupported_lineage",
  restore_in_progress: "backups.error.restore_in_progress",
  snapshot_in_progress: "backups.error.snapshot_in_progress",
  quiesce_timeout: "backups.error.quiesce_timeout",
  pre_restore_failed: "backups.error.pre_restore_failed",
  swap_failed: "backups.error.swap_failed",
  migration_failed_rolled_back: "backups.error.migration_failed_rolled_back",
  rollback_failed: "backups.error.rollback_failed",
  retention_floor: "backups.error.retention_floor",
  protected_pre_restore: "backups.error.protected_pre_restore",
  upload_too_large: "backups.error.upload_too_large",
  backup_failed: "backups.error.backup_failed",
  not_found: "backups.error.not_found",
};

export function BackupsManagement() {
  const { t, language } = useTranslation();
  const codeMessages = Object.fromEntries(
    Object.entries(BACKUP_ERROR_KEYS).map(([code, key]) => [code, t(key)])
  );
  const responseMessage = (response: Response, fallback: string) =>
    readResponseMessage(response, fallback, codeMessages);
  // US0 hoist: the household IANA timezone comes from the shared
  // `useHouseholdSettings` context (one `/api/settings` fetch per boot) instead of an
  // ad-hoc GET here. Until the context resolves (or if it never does — the provider never
  // retries), `formatCreatedAt` keeps using the browser's own timezone as the fallback,
  // exactly as this panel's own failed-fetch catch used to (silent, no error surfaced).
  const { timezone: householdTimezone } = useHouseholdSettings();
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [backups, setBackups] = useState<BackupListItem[]>([]);
  const [lastBackupError, setLastBackupError] = useState<string | null>(null);
  const [lastPruneError, setLastPruneError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [snapshotting, setSnapshotting] = useState(false);
  const [snapshotInfo, setSnapshotInfo] = useState<string | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);

  const [deletingFilenames, setDeletingFilenames] = useState<Set<string>>(() => new Set());
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [restoreConfirmInput, setRestoreConfirmInput] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  // Field-validation error (the typed-confirm mismatch) is SPLIT from operation errors: it routes
  // through Field's `error` wiring so the input carries `aria-invalid` + `aria-describedby` and an
  // assistive-technology user returning to the field can rediscover the problem after the alert's
  // one-shot announcement . Operation errors (server refusal, network) stay
  // on the standalone ErrorNotice below — they are not a property of the input.
  const [restoreMismatch, setRestoreMismatch] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const [uploadingName, setUploadingName] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [snapshotSuccess, setSnapshotSuccess] = useState<string | null>(null);
  // Key is `${filename}|db` or `${filename}|sql`.
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void loadBackups();
  }, []);

  useEffect(() => {
    if (householdTimezone !== null) setTimezone(householdTimezone);
  }, [householdTimezone]);

  async function loadBackups() {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await authFetch("/api/backups", { credentials: "include" });
      if (!response.ok) throw new Error("load backups failed");
      const data = (await response.json()) as BackupListResponse;
      setBackups(data.backups);
      setLastBackupError(data.lastBackupError);
      setLastPruneError(data.lastPruneError);
    } catch {
      setLoadError(t("backups.management.loadError"));
    } finally {
      setLoading(false);
    }
  }

  function clearBanners() {
    setSnapshotSuccess(null);
    setUploadSuccess(null);
  }

  async function snapshotNow() {
    clearBanners();
    setSnapshotting(true);
    setSnapshotInfo(null);
    setSnapshotError(null);
    try {
      const response = await authFetch("/api/backups/snapshot", {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) {
        throw new LocalizedApiError(
          await responseMessage(response, t("backups.management.snapshotError"))
        );
      }
      const result = (await response.json()) as SnapshotResult;
      if (result.status === "already_running") {
        setSnapshotInfo(t("backups.management.snapshotAlreadyRunning"));
      } else {
        setSnapshotSuccess(
          t("backups.management.snapshotCreated").replace("{filename}", result.filename)
        );
        await loadBackups();
      }
    } catch (cause) {
      setSnapshotError(
        cause instanceof LocalizedApiError ? cause.message : t("backups.management.snapshotError")
      );
    } finally {
      setSnapshotting(false);
    }
  }

  async function deleteBackup(filename: string) {
    clearBanners();
    setDeletingFilenames((previous) => new Set(previous).add(filename));
    setDeleteError(null);
    try {
      const response = await authFetch(`/api/backups/${encodeURIComponent(filename)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) {
        throw new LocalizedApiError(
          await responseMessage(response, t("backups.management.deleteError"))
        );
      }
      await loadBackups();
    } catch (cause) {
      setDeleteError(
        cause instanceof LocalizedApiError ? cause.message : t("backups.management.deleteError")
      );
    } finally {
      setDeletingFilenames((previous) => {
        const next = new Set(previous);
        next.delete(filename);
        return next;
      });
    }
  }

  function selectForRestore(filename: string) {
    clearBanners();
    setRestoreTarget(filename);
    setRestoreConfirmInput("");
    setRestoreError(null);
    setRestoreMismatch(null);
  }

  function cancelRestore() {
    setRestoreTarget(null);
    setRestoreConfirmInput("");
    setRestoreError(null);
    setRestoreMismatch(null);
  }

  async function submitRestore() {
    if (!restoreTarget || restoring) return;
    // TYPED-CONFIRM (BACKUPS-AC-01): a mismatch is blocked HERE, client-side, before any
    // request is sent at all — the server re-validates the same rule, but this panel never
    // relies on the round-trip to catch a fat-fingered confirmation.
    if (restoreConfirmInput !== restoreTarget) {
      setRestoreMismatch(t("backups.management.restoreMismatch"));
      setRestoreError(null);
      return;
    }

    setRestoring(true);
    setRestoreError(null);
    setRestoreMismatch(null);
    try {
      const input: RestoreRequest = {
        filename: restoreTarget,
        confirmFilename: restoreConfirmInput,
      };
      const response = await authFetch("/api/backups/restore", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const result = (await response.json()) as RestoreResult;
      if (!response.ok || result.status !== "restored") {
        setRestoreError(
          Object.hasOwn(codeMessages, result.status)
            ? codeMessages[result.status]
            : t("backups.management.restoreError")
        );
        setRestoring(false);
        return;
      }
      // D8: the initiating client reloads itself immediately on a successful restore —
      // every subsequent request already hits the swapped-in database regardless, so there is
      // no in-memory state worth reconciling instead of a reload.
      window.location.reload();
    } catch {
      setRestoreError(t("backups.management.restoreError"));
      setRestoring(false);
    }
  }

  async function uploadBackupFile(file: File | undefined) {
    if (!file || uploading) return;
    clearBanners();
    setUploadError(null);
    const resetInput = () => {
      if (fileInputRef.current) fileInputRef.current.value = "";
    };
    // Client pre-flight only: the server stays the authority (SQLite header check, FR-006).
    if (!isDbFile(file.name)) {
      setUploadError(t("backups.management.uploadUnsupported"));
      resetInput();
      return;
    }
    setUploading(true);
    setUploadingName(file.name);
    try {
      const response = await authFetch("/api/backups/upload", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/octet-stream" },
        body: file,
      });
      if (!response.ok) {
        throw new LocalizedApiError(
          await responseMessage(response, t("backups.management.uploadError"))
        );
      }
      const result = (await response.json()) as UploadResult;
      setUploadSuccess(
        t("backups.management.uploadSuccess").replace("{filename}", result.filename)
      );
      await loadBackups();
    } catch (cause) {
      setUploadError(
        cause instanceof LocalizedApiError ? cause.message : t("backups.management.uploadError")
      );
    } finally {
      resetInput();
      setUploading(false);
    }
  }

  async function downloadBackup(filename: string, format: "db" | "sql") {
    const key = `${filename}|${format}`;
    if (downloading === key) return;
    clearBanners();
    setDownloadError(null);
    setDownloading(key);
    try {
      const path = `/api/backups/${encodeURIComponent(filename)}/${
        format === "db" ? "download" : "download-sql"
      }`;
      const response = await authFetch(path, { credentials: "include" });
      if (!response.ok) {
        throw new LocalizedApiError(
          await responseMessage(response, t("backups.management.downloadError"))
        );
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = format === "db" ? filename : `${filename}.sql`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setDownloadError(
        cause instanceof LocalizedApiError ? cause.message : t("backups.management.downloadError")
      );
    } finally {
      setDownloading(null);
    }
  }

  function formatCreatedAt(createdAt: number): string {
    return new Intl.DateTimeFormat(language === "es" ? "es-ES" : "en-GB", {
      timeZone: timezone,
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(new Date(createdAt));
  }

  if (loading) {
    return (
      <AdminPanel title={t("backups.management.title")} data-testid="backups-management">
        <p className="text-muted-foreground">{t("backups.management.loading")}</p>
      </AdminPanel>
    );
  }

  return (
    <AdminPanel
      title={t("backups.management.title")}
      description={t("backups.management.description")}
      data-testid="backups-management"
    >
      {loadError && (
        <div className="flex flex-wrap items-center gap-3">
          <ErrorNotice message={loadError} />
          <Button
            type="button"
            variant="secondary"
            data-testid="backups-retry"
            onClick={() => void loadBackups()}
          >
            {t("backups.management.retry")}
          </Button>
        </div>
      )}
      {lastBackupError && (
        <ErrorNotice
          message={`${t("backups.management.lastBackupErrorLabel")}: ${lastBackupError}`}
          data-testid="backups-last-backup-error"
        />
      )}
      {lastPruneError && (
        <ErrorNotice
          message={`${t("backups.management.lastPruneErrorLabel")}: ${lastPruneError}`}
          politeness="polite"
          data-testid="backups-last-prune-error"
        />
      )}

      <div className="bg-card rounded-lg p-4 shadow">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            data-testid="backups-snapshot-now"
            disabled={snapshotting}
            onClick={() => void snapshotNow()}
          >
            {snapshotting
              ? t("backups.management.snapshotting")
              : t("backups.management.snapshotNow")}
          </Button>
        </div>
        {snapshotInfo && (
          <p
            className="text-muted-foreground mt-2 text-control"
            role="status"
            aria-live="polite"
            data-testid="backups-snapshot-info"
          >
            {snapshotInfo}
          </p>
        )}
        {snapshotSuccess && (
          <p
            className={cn("mt-2", STATUS_BANNER_CLASSES)}
            role="status"
            aria-live="polite"
            data-testid="backups-snapshot-success"
          >
            {snapshotSuccess}
          </p>
        )}
        <ErrorNotice
          message={snapshotError}
          className="mt-2"
          data-testid="backups-snapshot-error"
        />
      </div>

      <ErrorNotice message={deleteError} data-testid="backups-delete-error" />
      <ErrorNotice message={downloadError} data-testid="backups-download-error" />

      {backups.length === 0 ? (
        loadError ? null : (
          <p className="text-muted-foreground" data-testid="backups-empty">
            {t("backups.management.empty")}
          </p>
        )
      ) : (
        <div className="bg-card overflow-x-auto rounded-lg shadow">
          <table className="w-full text-control" data-testid="backups-table">
            <thead>
              <tr className="border-b text-left">
                <th className="p-2">{t("backups.management.columnFilename")}</th>
                <th className="p-2">{t("backups.management.columnType")}</th>
                <th className="p-2">{t("backups.management.columnCreatedAt")}</th>
                <th className="p-2">{t("backups.management.columnSize")}</th>
                <th className="p-2">{t("backups.management.columnActions")}</th>
              </tr>
            </thead>
            <tbody>
              {backups.map((backup) => (
                <tr
                  key={backup.filename}
                  className="border-b"
                  data-testid={`backups-row-${backup.filename}`}
                >
                  <td className="p-2 align-top">{backup.filename}</td>
                  <td className="p-2 align-top">
                    <span
                      data-testid={`backups-type-${backup.filename}`}
                      className={cn(
                        "inline-block rounded-full px-2.5 py-0.5 text-xs font-medium",
                        TYPE_PILL_CLASSES[backup.type]
                      )}
                    >
                      {t(TYPE_KEYS[backup.type])}
                    </span>
                  </td>
                  <td className="p-2 align-top">
                    <time
                      dateTime={new Date(backup.createdAt).toISOString()}
                      title={formatCreatedAt(backup.createdAt)}
                    >
                      {formatRelativeAge(backup.createdAt, Date.now(), language) ??
                        formatCreatedAt(backup.createdAt)}
                    </time>
                  </td>
                  <td className="p-2 align-top">{formatBytes(backup.sizeBytes)}</td>
                  <td className="p-2 align-top">
                    <div className="flex flex-wrap items-center gap-2">
                      {(["db", "sql"] as const).map((format) => {
                        const busy = downloading === `${backup.filename}|${format}`;
                        return (
                          <Button
                            key={format}
                            type="button"
                            variant="link"
                            size="sm"
                            data-testid={
                              format === "db"
                                ? `backups-download-${backup.filename}`
                                : `backups-download-sql-${backup.filename}`
                            }
                            disabled={busy}
                            aria-busy={busy}
                            onClick={() => void downloadBackup(backup.filename, format)}
                          >
                            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                            {format === "db"
                              ? t("backups.management.download")
                              : t("backups.management.downloadSql")}
                          </Button>
                        );
                      })}
                      <Button
                        type="button"
                        variant="link"
                        size="sm"
                        data-testid={`backups-restore-select-${backup.filename}`}
                        onClick={() => selectForRestore(backup.filename)}
                        disabled={restoring}
                      >
                        {t("backups.management.restore")}
                      </Button>
                      <Button
                        type="button"
                        variant="link"
                        size="sm"
                        className="text-destructive hover:text-destructive/80"
                        data-testid={`backups-delete-${backup.filename}`}
                        disabled={deletingFilenames.has(backup.filename)}
                        onClick={() => setDeleteTarget(backup.filename)}
                      >
                        {deletingFilenames.has(backup.filename)
                          ? t("backups.management.deleting")
                          : t("backups.management.delete")}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {restoreTarget && (
        <div className="bg-card rounded-lg p-4 shadow" data-testid="backups-restore-confirm">
          <h3 className="mb-2 text-lg font-semibold">
            {t("backups.management.restoreConfirmTitle")}
          </h3>
          <p className="text-muted-foreground mb-2 text-control">
            {t("backups.management.restoreConfirmLabel")}: <strong>{restoreTarget}</strong>
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t("backups.management.restoreConfirmInputLabel")} error={restoreMismatch}>
              <Input
                type="text"
                value={restoreConfirmInput}
                data-testid="backups-restore-confirm-input"
                placeholder={t("backups.management.restoreConfirmPlaceholder")}
                onChange={(event) => setRestoreConfirmInput(event.target.value)}
              />
            </Field>
            <Button
              type="button"
              variant="destructive"
              data-testid="backups-restore-submit"
              disabled={restoring}
              onClick={() => void submitRestore()}
            >
              {restoring
                ? t("backups.management.restoring")
                : t("backups.management.restoreSubmit")}
            </Button>
            <Button
              type="button"
              variant="outline"
              data-testid="backups-restore-cancel"
              disabled={restoring}
              onClick={cancelRestore}
            >
              {t("backups.management.restoreCancel")}
            </Button>
          </div>
          <ErrorNotice
            message={restoreError}
            className="mt-2"
            data-testid="backups-restore-error"
          />
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t("backups.management.delete")}
        description={deleteTarget ?? undefined}
        confirmLabel={t("backups.management.delete")}
        cancelLabel={t("backups.management.restoreCancel")}
        confirmTestId="backups-delete-confirm"
        cancelTestId="backups-delete-cancel"
        onConfirm={() => {
          if (deleteTarget) void deleteBackup(deleteTarget);
        }}
      />

      <div
        data-testid="backups-upload-dropzone"
        data-drag-active={dragActive ? "true" : "false"}
        className={cn(
          "bg-card rounded-lg border-2 border-dashed p-4 shadow",
          dragActive ? "border-primary bg-primary/5" : "border-border"
        )}
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          setDragActive(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          void uploadBackupFile(event.dataTransfer.files[0]);
        }}
      >
        <h3 className="mb-1 text-lg font-semibold">{t("backups.management.uploadTitle")}</h3>
        <p className="text-muted-foreground mb-2 text-control">
          {t("backups.management.uploadDropHint")}
        </p>
        <Field label={t("backups.management.uploadFileLabel")}>
          <Input
            ref={fileInputRef}
            type="file"
            accept=".db"
            disabled={uploading}
            data-testid="backups-upload-input"
            onChange={(event) => void uploadBackupFile(event.target.files?.[0])}
          />
        </Field>
        {uploading && (
          <p className="text-muted-foreground mt-2 text-control" role="status" aria-live="polite">
            {t("backups.management.uploadingFile").replace("{filename}", uploadingName)}
          </p>
        )}
        <ErrorNotice message={uploadError} className="mt-2" data-testid="backups-upload-error" />
        {uploadSuccess && (
          <p
            className={cn("mt-2", STATUS_BANNER_CLASSES)}
            role="status"
            aria-live="polite"
            data-testid="backups-upload-success"
          >
            {uploadSuccess}
          </p>
        )}
      </div>
    </AdminPanel>
  );
}
