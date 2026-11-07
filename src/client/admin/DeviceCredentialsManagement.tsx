import { useCallback, useEffect, useState } from "react";

import { AdminPanel } from "@/components/AdminPanel";
import { CheckboxField } from "@/components/CheckboxField";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Field } from "@/components/Field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { authFetch, reportCredentialLoss } from "@/lib/credential";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { cn } from "@/lib/utils";
import type {
  DeviceCredential,
  DeviceCredentialList,
  DeviceCredentialRevokeResult,
} from "../../shared";

const KIND_KEYS: Record<DeviceCredential["kind"], MessageKey> = {
  device: "accessKeys.kind.device",
  bootstrap: "accessKeys.kind.bootstrap",
  integration: "accessKeys.kind.integration",
};

const STATE_KEYS: Record<DeviceCredential["state"], MessageKey> = {
  active: "accessKeys.state.active",
  revoked: "accessKeys.state.revoked",
  expired: "accessKeys.state.expired",
};

async function readErrorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { code?: unknown } | null;
    return typeof body?.code === "string" ? body.code : null;
  } catch {
    return null;
  }
}

/** List, label and revoke the API credentials (`/api/auth/credentials`), the HTTP counterpart of
 * `npm run devices`. Minting stays on the bootstrap provisioning flow. Revoked rows are hidden
 * behind a filter and dimmed when shown. The configured MP_BOOTSTRAP_KEY row cannot be revoked
 * (startup re-activates it), so its button is disabled and the row says how to rotate it.
 * Revoking the credential this screen uses logs it out: the dialog says so, and on success the
 * shell is told the credential is gone instead of waiting for the next request to fail. */
export function DeviceCredentialsManagement() {
  const { t, language } = useTranslation();
  const locale = language === "es" ? "es-ES" : "en-GB";
  // Household timezone when known; the browser's own otherwise (`undefined`).
  const timeZone = useHouseholdSettings().timezone ?? undefined;
  const [credentials, setCredentials] = useState<DeviceCredential[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const [renaming, setRenaming] = useState<DeviceCredential | null>(null);
  const [draft, setDraft] = useState("");
  const [savingLabel, setSavingLabel] = useState(false);
  const [labelError, setLabelError] = useState<string | null>(null);

  const [revoking, setRevoking] = useState<DeviceCredential | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await authFetch("/api/auth/credentials", { credentials: "include" });
      if (!response.ok) throw new Error(`credentials: ${response.status}`);
      const body = (await response.json()) as Partial<DeviceCredentialList> | null;
      if (!Array.isArray(body?.credentials)) throw new Error("credentials: unexpected body");
      setCredentials(body.credentials);
    } catch {
      setLoadError(t("accessKeys.error.load"));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  function setRowErr(id: string, message: string | null) {
    setRowError((prev) => {
      const next = { ...prev };
      if (message === null) delete next[id];
      else next[id] = message;
      return next;
    });
  }

  function apply(updated: DeviceCredential) {
    setCredentials((prev) => prev?.map((c) => (c.id === updated.id ? updated : c)) ?? prev);
  }

  const nameOf = (credential: DeviceCredential) => credential.label ?? t("accessKeys.row.unnamed");
  const formatDate = (ms: number) =>
    new Date(ms).toLocaleDateString(locale, {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone,
    });
  /** Down to the minute, so keys provisioned on the same day can be told apart. */
  const formatDateTime = (ms: number) =>
    new Date(ms).toLocaleString(locale, {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone,
    });

  function startRename(credential: DeviceCredential) {
    setRenaming(credential);
    setDraft(credential.label ?? "");
    setLabelError(null);
  }

  async function saveLabel() {
    if (renaming === null) return;
    const label = draft.trim();
    if (label === "") {
      setLabelError(t("accessKeys.error.labelRequired"));
      return;
    }
    setSavingLabel(true);
    setLabelError(null);
    try {
      const response = await authFetch(`/api/auth/credentials/${renaming.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label }),
      });
      if (!response.ok) throw new Error(`label credential: ${response.status}`);
      apply((await response.json()) as DeviceCredential);
      setRenaming(null);
    } catch {
      setLabelError(t("accessKeys.error.label"));
    } finally {
      setSavingLabel(false);
    }
  }

  async function revoke(credential: DeviceCredential) {
    setBusyId(credential.id);
    setRowErr(credential.id, null);
    try {
      const response = await authFetch(`/api/auth/credentials/${credential.id}/revoke`, {
        method: "POST",
        credentials: "include",
      });
      if (response.status === 409 && (await readErrorCode(response)) === "configured_bootstrap") {
        setRowErr(credential.id, t("accessKeys.row.configuredBootstrap"));
        return;
      }
      if (!response.ok) throw new Error(`revoke credential: ${response.status}`);
      const result = (await response.json()) as DeviceCredentialRevokeResult;
      apply(result.credential);
      if (credential.current) reportCredentialLoss();
    } catch {
      setRowErr(credential.id, t("accessKeys.error.revoke"));
    } finally {
      setBusyId(null);
    }
  }

  if (credentials === null && loadError === null) {
    return (
      <AdminPanel title={t("accessKeys.title")}>
        <p className="text-muted-foreground text-control">{t("accessKeys.loading")}</p>
      </AdminPanel>
    );
  }

  const all = credentials ?? [];
  const revokedCount = all.filter((c) => c.state === "revoked").length;
  const visible = showRevoked ? all : all.filter((c) => c.state !== "revoked");

  return (
    <AdminPanel
      title={t("accessKeys.title")}
      description={t("accessKeys.description")}
      data-testid="access-keys-management"
    >
      <ErrorNotice message={loadError} data-testid="access-keys-error" />
      {loadError && (
        <Button
          type="button"
          variant="secondary"
          className="self-start"
          onClick={() => void load()}
          data-testid="access-keys-retry"
        >
          {t("accessKeys.action.retry")}
        </Button>
      )}

      {revokedCount > 0 && (
        <CheckboxField
          className="self-start"
          checked={showRevoked}
          onChange={setShowRevoked}
          label={t("accessKeys.filter.showRevoked").replace("{count}", String(revokedCount))}
          data-testid="access-keys-show-revoked"
        />
      )}

      {credentials !== null && visible.length === 0 ? (
        <p className="text-muted-foreground text-control" data-testid="access-keys-empty">
          {t("accessKeys.empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="access-keys-list">
          {visible.map((credential) => {
            const isRevoked = credential.state === "revoked";
            const isBusy = busyId === credential.id;
            return (
              <li
                key={credential.id}
                data-testid={`access-keys-row-${credential.id}`}
                data-state={credential.state}
                className={cn(
                  "flex flex-col gap-2 rounded-md border p-3",
                  isRevoked && "bg-muted/40 opacity-60",
                  credential.current && !isRevoked && "border-primary"
                )}
              >
                <ErrorNotice
                  message={rowError[credential.id]}
                  data-testid={`access-keys-row-error-${credential.id}`}
                />
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong
                        className={cn(credential.label === null && "text-muted-foreground italic")}
                        data-testid={`access-keys-name-${credential.id}`}
                      >
                        {nameOf(credential)}
                      </strong>
                      {credential.current && (
                        <span
                          className={cn(
                            "rounded-full border px-2 py-0.5 text-xs",
                            "border-primary bg-primary/10 font-semibold"
                          )}
                          data-testid={`access-keys-current-${credential.id}`}
                        >
                          {t("accessKeys.row.thisDevice")}
                        </span>
                      )}
                      <span className={"rounded-full border px-2 py-0.5 text-xs"}>
                        {t(KIND_KEYS[credential.kind])}
                      </span>
                      <span
                        className={cn(
                          "rounded-full border px-2 py-0.5 text-xs",
                          credential.state === "active" && "border-success text-success"
                        )}
                        data-testid={`access-keys-state-${credential.id}`}
                      >
                        {t(STATE_KEYS[credential.state])}
                      </span>
                    </div>
                    <p className="text-muted-foreground text-control">
                      <span data-testid={`access-keys-created-${credential.id}`}>
                        {t("accessKeys.row.created").replace(
                          "{date}",
                          formatDateTime(credential.createdAt)
                        )}
                      </span>
                      {credential.expiresAt !== null && (
                        <>
                          {" · "}
                          {t(
                            credential.state === "expired"
                              ? "accessKeys.row.expired"
                              : "accessKeys.row.expires"
                          ).replace("{date}", formatDate(credential.expiresAt))}
                        </>
                      )}
                    </p>
                    {credential.configuredBootstrap && (
                      <p
                        className="text-muted-foreground text-control"
                        data-testid={`access-keys-bootstrap-note-${credential.id}`}
                      >
                        {t("accessKeys.row.configuredBootstrap")}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => startRename(credential)}
                      data-testid={`access-keys-rename-${credential.id}`}
                    >
                      {t("accessKeys.action.rename")}
                    </Button>
                    {!isRevoked && (
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={isBusy || credential.configuredBootstrap}
                        onClick={() => setRevoking(credential)}
                        data-testid={`access-keys-revoke-${credential.id}`}
                      >
                        {isBusy ? t("accessKeys.action.revoking") : t("accessKeys.action.revoke")}
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog
        open={renaming !== null}
        onOpenChange={(open) => {
          if (!open && !savingLabel) setRenaming(null);
        }}
      >
        <DialogContent
          closeLabel={t("accessKeys.action.cancel")}
          data-testid="access-keys-rename-dialog"
          className="sm:max-w-md"
        >
          <DialogHeader>
            <DialogTitle>{t("accessKeys.rename.title")}</DialogTitle>
            <DialogDescription>{t("accessKeys.rename.description")}</DialogDescription>
          </DialogHeader>
          {renaming && (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void saveLabel();
              }}
            >
              <ErrorNotice message={labelError} data-testid="access-keys-rename-error" />
              <Field label={t("accessKeys.rename.label")}>
                <Input
                  type="text"
                  maxLength={80}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  data-testid="access-keys-rename-input"
                />
              </Field>
              <div className="flex gap-2">
                <Button type="submit" disabled={savingLabel} data-testid="access-keys-rename-save">
                  {savingLabel ? t("accessKeys.action.saving") : t("accessKeys.action.save")}
                </Button>
                <Button type="button" variant="outline" onClick={() => setRenaming(null)}>
                  {t("accessKeys.action.cancel")}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={revoking ? t("accessKeys.revoke.title").replace("{name}", nameOf(revoking)) : ""}
        description={
          revoking?.current
            ? t("accessKeys.revoke.currentDescription")
            : t("accessKeys.revoke.description")
        }
        confirmLabel={
          revoking?.current ? t("accessKeys.action.revokeCurrent") : t("accessKeys.action.revoke")
        }
        cancelLabel={t("accessKeys.action.cancel")}
        confirmTestId="access-keys-revoke-confirm"
        cancelTestId="access-keys-revoke-cancel"
        onConfirm={() => {
          if (revoking) void revoke(revoking);
        }}
      />
    </AdminPanel>
  );
}
