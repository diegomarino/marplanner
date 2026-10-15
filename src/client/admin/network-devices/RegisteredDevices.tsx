import { useState } from "react";
import { authFetch } from "@/lib/credential";
import { useTranslation } from "@/i18n";
import type { RegisteredDevice } from "../../../shared";
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
import { NATIVE_SELECT_CLASSES } from "@/lib/recipes";
import { DeviceStatus, MemberLabel } from "./DeviceStatus";
import { controllerErrorMessageKey, parseErrorCode, type NetworkDevicesData } from "./data";

interface EditDraft {
  alias: string;
  memberId: string;
}

/** The registry list: row actions, the edit Dialog and the delete ConfirmDialog.
 * A raw MAC is never rendered here (FR-015 / NETWORK-DEVICES-INV-07): rows use household aliases. */
export function RegisteredDevices({
  data,
  onAdd,
}: {
  data: NetworkDevicesData;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  const { devices, members } = data;
  const listError = data.listErrorKey ? t(data.listErrorKey) : null;
  const membersError = data.membersErrorKey ? t(data.membersErrorKey) : null;

  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const [editing, setEditing] = useState<RegisteredDevice | null>(null);
  const [draft, setDraft] = useState<EditDraft>({ alias: "", memberId: "" });
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [deleting, setDeleting] = useState<RegisteredDevice | null>(null);

  function setRowErr(id: string, message: string | null) {
    setRowError((prev) => {
      const next = { ...prev };
      if (message === null) delete next[id];
      else next[id] = message;
      return next;
    });
  }

  function startEdit(device: RegisteredDevice) {
    setEditing(device);
    setDraft({ alias: device.alias, memberId: device.memberId ?? "" });
    setEditError(null);
    setRowErr(device.id, null);
  }

  function closeEdit() {
    setEditing(null);
    setDraft({ alias: "", memberId: "" });
    setEditError(null);
  }

  async function saveEdit() {
    if (editing === null) return;
    const id = editing.id;
    const alias = draft.alias.trim();
    if (alias === "") {
      setEditError(t("networkDevices.error.aliasRequired"));
      return;
    }
    setSavingEdit(true);
    setEditError(null);
    data.markMutation();
    try {
      const response = await authFetch(`/api/network-devices/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          alias,
          memberId: draft.memberId === "" ? null : draft.memberId,
        }),
      });
      if (!response.ok) throw new Error(`edit device: ${response.status}`);
      const updated = (await response.json()) as RegisteredDevice;
      data.applyDevice(updated);
      closeEdit();
    } catch {
      setEditError(t("networkDevices.error.editGeneric"));
    } finally {
      setSavingEdit(false);
    }
  }

  async function deleteDevice(device: RegisteredDevice) {
    setBusyId(device.id);
    setRowErr(device.id, null);
    data.markMutation();
    try {
      const response = await authFetch(`/api/network-devices/${device.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      // A 404 means it is already gone: the user's intent is satisfied.
      if (!response.ok && response.status !== 404) {
        throw new Error(`delete device: ${response.status}`);
      }
      data.removeDevice(device.id);
    } catch {
      setRowErr(device.id, t("networkDevices.error.deleteGeneric"));
    } finally {
      setBusyId(null);
    }
  }

  async function toggleBlock(device: RegisteredDevice) {
    const action = device.isBlocked ? "unblock" : "block";
    // The controller-authoritative TARGET this action is attempting to reach — "block" always
    // targets isBlocked=true, "unblock" always targets isBlocked=false, independent of whatever
    // the response body's (possibly stale, possibly diverged) `isBlocked` ends up being.
    const targetIsBlocked = action === "block";
    setBusyId(device.id);
    setRowErr(device.id, null);
    data.markMutation();
    try {
      const response = await authFetch(`/api/network-devices/${device.id}/${action}`, {
        method: "POST",
        credentials: "include",
      });
      if (response.status === 502) {
        const code = await parseErrorCode(response);
        setRowErr(device.id, t(controllerErrorMessageKey(code)));
        return;
      }
      if (!response.ok) throw new Error(`${action} device: ${response.status}`);
      const updated = (await response.json()) as RegisteredDevice;
      data.applyDevice(updated);
      // The controller call itself SUCCEEDED (we only reach here past the 502 branch above) —
      // record the target it reached, authoritatively, for the divergence badge to trust over
      // the response's own (possibly stale) `isBlocked`.
      data.setAttemptedBlockTarget(device.id, targetIsBlocked);
    } catch {
      setRowErr(
        device.id,
        t(
          action === "block"
            ? "networkDevices.error.blockGeneric"
            : "networkDevices.error.unblockGeneric"
        )
      );
    } finally {
      setBusyId(null);
    }
  }

  // `beliefDiverged` means the LOCAL mirror may be stale in EITHER direction — during that
  // window `isBlocked` alone is not trustworthy either way, so assume an upstream block MAY be
  // stranded and show the stronger warning whenever a divergence is in flight.
  const deleteDescription =
    deleting && (deleting.isBlocked || deleting.beliefDiverged)
      ? t("networkDevices.action.deleteConfirmBlocked")
      : t("networkDevices.action.deleteConfirm");

  return (
    <>
      <ErrorNotice message={listError} data-testid="network-devices-error" />
      {listError && (
        <Button
          type="button"
          variant="secondary"
          className="self-start"
          onClick={() => void data.reloadAll()}
          data-testid="network-devices-retry"
        >
          {t("networkDevices.action.retry")}
        </Button>
      )}
      <ErrorNotice message={membersError} data-testid="network-devices-members-error" />

      {/* The empty-state text is suppressed whenever the devices read itself failed — otherwise a
          list error alongside an empty array rendered BOTH "failed to load" AND "no devices
          registered yet", which reads as a contradiction. */}
      {!listError && devices.length === 0 ? (
        <div className="flex flex-col items-start gap-1">
          <p className="text-muted-foreground text-control" data-testid="network-devices-empty">
            {t("networkDevices.management.empty")}
          </p>
          <Button
            type="button"
            variant="link"
            onClick={onAdd}
            data-testid="network-devices-empty-add"
          >
            {t("networkDevices.management.emptyAdd")}
          </Button>
        </div>
      ) : listError ? null : (
        <ul className="flex flex-col gap-2" data-testid="network-devices-list">
          {devices.map((device) => {
            const isBusy = busyId === device.id;
            return (
              <li
                key={device.id}
                data-testid={`network-devices-row-${device.id}`}
                className="flex flex-col gap-2 rounded-md border p-3"
              >
                <ErrorNotice
                  message={rowError[device.id]}
                  data-testid={`network-devices-row-error-${device.id}`}
                />
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex flex-col gap-1">
                    <strong data-testid={`network-devices-alias-${device.id}`}>
                      {device.alias}
                    </strong>
                    <DeviceStatus
                      device={device}
                      cacheState={data.cacheState}
                      attemptedBlockTarget={data.attemptedBlockTarget[device.id]}
                    />
                    <MemberLabel device={device} />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => startEdit(device)}
                      data-testid={`network-devices-edit-${device.id}`}
                    >
                      {t("networkDevices.action.edit")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={isBusy}
                      onClick={() => void toggleBlock(device)}
                      data-testid={`network-devices-toggle-block-${device.id}`}
                    >
                      {isBusy
                        ? t(
                            device.isBlocked
                              ? "networkDevices.action.unblocking"
                              : "networkDevices.action.blocking"
                          )
                        : t(
                            device.isBlocked
                              ? "networkDevices.action.unblock"
                              : "networkDevices.action.block"
                          )}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={isBusy}
                      onClick={() => setDeleting(device)}
                      data-testid={`network-devices-delete-${device.id}`}
                    >
                      {t("networkDevices.action.delete")}
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open && !savingEdit) closeEdit();
        }}
      >
        <DialogContent
          closeLabel={t("networkDevices.action.cancel")}
          data-testid="network-devices-edit-dialog"
          className="sm:max-w-md"
        >
          <DialogHeader>
            <DialogTitle>{t("networkDevices.edit.title")}</DialogTitle>
            <DialogDescription className="sr-only">
              {t("networkDevices.edit.description")}
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                void saveEdit();
              }}
            >
              <ErrorNotice message={editError} data-testid="network-devices-edit-error" />
              <Field label={t("networkDevices.picker.aliasLabel")}>
                <Input
                  type="text"
                  maxLength={80}
                  value={draft.alias}
                  onChange={(e) => setDraft((d) => ({ ...d, alias: e.target.value }))}
                  data-testid={`network-devices-edit-alias-${editing.id}`}
                />
              </Field>
              <Field label={t("networkDevices.picker.memberLabel")}>
                <select
                  className={NATIVE_SELECT_CLASSES}
                  value={draft.memberId}
                  onChange={(e) => setDraft((d) => ({ ...d, memberId: e.target.value }))}
                  data-testid={`network-devices-edit-member-${editing.id}`}
                >
                  <option value="">{t("networkDevices.picker.memberNone")}</option>
                  {/* the currently-linked member can be INACTIVE (excluded from `members`) —
                      without this option, the select's `value` matches no `<option>` and renders
                      blank even though a member IS assigned. Disabled: it names the current
                      assignment but can't be re-selected once changed away from. */}
                  {editing.memberInactive && editing.memberId && (
                    <option value={editing.memberId} disabled>
                      {editing.memberLabel} ({t("networkDevices.member.inactive")})
                    </option>
                  )}
                  {/* the members read can fail/degrade independently of the registry — when it
                      does, `members` is empty even though the assignment is an ACTIVE member.
                      Without this option the controlled select silently renders "No member"
                      while the draft still posts the real id on save — a misleading UI. */}
                  {!editing.memberInactive &&
                    editing.memberId &&
                    !members.some((m) => m.id === editing.memberId) && (
                      <option value={editing.memberId} disabled>
                        {editing.memberLabel ?? t("networkDevices.member.currentAssignment")}
                      </option>
                    )}
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="flex gap-2">
                <Button
                  type="submit"
                  disabled={savingEdit}
                  data-testid={`network-devices-save-${editing.id}`}
                >
                  {savingEdit ? t("networkDevices.action.saving") : t("networkDevices.action.save")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={closeEdit}
                  data-testid={`network-devices-cancel-edit-${editing.id}`}
                >
                  {t("networkDevices.action.cancel")}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={t("networkDevices.delete.title")}
        description={deleteDescription}
        confirmLabel={t("networkDevices.action.delete")}
        cancelLabel={t("networkDevices.action.cancel")}
        confirmTestId="network-devices-delete-confirm"
        onConfirm={() => {
          if (deleting) void deleteDevice(deleting);
        }}
      />
    </>
  );
}
