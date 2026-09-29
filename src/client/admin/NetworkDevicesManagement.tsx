import { useEffect, useState } from "react";
import { authFetch } from "@/lib/credential";
import { useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import type {
  LiveCacheState,
  LiveClient,
  LiveClientsResponse,
  Member,
  NetworkDevicesListResponse,
  RegisteredDevice,
} from "../../shared";
import { AdminPanel } from "@/components/AdminPanel";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LABEL_INLINE_CLASSES, NATIVE_SELECT_CLASSES } from "@/lib/recipes";

/** Manage curated aliases and member assignments separately from controller discovery.
 * MAC addresses identify unregistered picker entries; registered rows use household aliases.
 * Last-seen timestamps are shown for unknown/not-detected states, never as live online evidence.
 * Native selects represent an explicit unassigned value; delete retains native confirmation. */

type ApiErrorBody = { error?: unknown; code?: unknown };

async function parseErrorCode(response: Response): Promise<string | undefined> {
  const data = (await response.json().catch(() => null)) as ApiErrorBody | null;
  return typeof data?.code === "string" ? data.code : undefined;
}

/** The three 502 controller-degradation states (`NetworkDeviceControllerUnavailableError` /
 * `ControllerRejectedError` / `ControllerUnreachableError` in
 * `src/server/modules/network-devices/index.ts`) each carry their OWN machine `code`
 * (`controller_unavailable`/`controller_rejected`/`controller_unreachable`) — the route's
 * `sendError` now forwards it on 502 the same way it already does on 409 (
 * see `src/server/routes/network-devices.ts`'s error-mapping docblock). An absent or
 * unrecognized code — e.g. this endpoint 502ing for a reason this client doesn't know about
 * yet — falls back to a NEUTRAL generic message, deliberately NEVER `controllerUnavailable`:
 * the spec's unset-vs-rejected edge case ("Unset vs unset credentials") is
 * exactly the conflation an unconditional "not configured" fallback would reintroduce.
 */
function controllerErrorMessageKey(code: string | undefined): MessageKey {
  if (code === "controller_unavailable") return "networkDevices.error.controllerUnavailable";
  if (code === "controller_rejected") return "networkDevices.error.controllerRejected";
  if (code === "controller_unreachable") return "networkDevices.error.controllerUnreachable";
  return "networkDevices.error.controllerGeneric";
}

function formatLastSeen(lastSeenAt: number): string {
  return new Date(lastSeenAt).toLocaleString();
}

interface EditDraft {
  alias: string;
  memberId: string;
}

export function NetworkDevicesManagement() {
  const t = useT();

  const [devices, setDevices] = useState<RegisteredDevice[]>([]);
  const [cacheState, setCacheState] = useState<LiveCacheState | null>(null);
  const [activeMembers, setActiveMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft>({ alias: "", memberId: "" });
  const [savingEdit, setSavingEdit] = useState(false);

  // the AUTHORITATIVE target of the most recent LOCAL block/unblock action,
  // keyed by device id — set the moment a controller call succeeds, regardless of whether the
  // mirror write also succeeded. When a response arrives with `beliefDiverged: true`, the
  // controller (not the stale mirrored `isBlocked`) is the source of truth for which state to
  // render as "confirming" — this map is how the badge recovers that truth even though the
  // response body itself only carries the pre-divergence belief. A row with NO entry here
  // (e.g. it arrived already-divergent from a page LOAD, never touched locally this session)
  // has no local action to trust either direction from, so it falls back to a neutral label
  // in `DeviceStatusBadges` instead of guessing.
  const [attemptedBlockTarget, setAttemptedBlockTarget] = useState<Record<string, boolean>>({});

  const [pickerOpen, setPickerOpen] = useState(false);

  // Two INDEPENDENT reads: the members read feeds only the optional
  // assignment select — a failure there must degrade JUST that affordance (its own,
  // dedicated `membersError`), never block the registry itself from rendering. Previously
  // a single `Promise.all` meant a members-endpoint 500 made the WHOLE panel (including
  // devices that loaded fine) report "failed to load", which is strictly worse than the
  // truth: the registry read succeeded and has nothing to do with member assignment.
  useEffect(() => {
    void loadDevices();
    void loadMembers();
  }, []);

  async function loadDevices() {
    setLoading(true);
    setListError(null);
    try {
      const response = await authFetch("/api/network-devices", { credentials: "include" });
      if (!response.ok) throw new Error(`list devices: ${response.status}`);
      const data = (await response.json()) as NetworkDevicesListResponse;
      setDevices(data.devices);
      setCacheState(data.cacheState);
    } catch {
      setListError(t("networkDevices.management.loadError"));
    } finally {
      setLoading(false);
    }
  }

  async function loadMembers() {
    setMembersError(null);
    try {
      const response = await authFetch("/api/members", { credentials: "include" });
      if (!response.ok) throw new Error(`list members: ${response.status}`);
      const data = (await response.json()) as Member[];
      setActiveMembers(data.filter((m) => m.lifecycle === "active"));
    } catch {
      setMembersError(t("networkDevices.error.membersLoadError"));
    }
  }

  function setRowErr(id: string, message: string | null) {
    setRowError((prev) => {
      const next = { ...prev };
      if (message === null) delete next[id];
      else next[id] = message;
      return next;
    });
  }

  function startEdit(device: RegisteredDevice) {
    setEditingId(device.id);
    setEditDraft({ alias: device.alias, memberId: device.memberId ?? "" });
    setRowErr(device.id, null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft({ alias: "", memberId: "" });
  }

  async function saveEdit(id: string) {
    setSavingEdit(true);
    setRowErr(id, null);
    try {
      const alias = editDraft.alias.trim();
      if (alias === "") {
        setRowErr(id, t("networkDevices.error.aliasRequired"));
        return;
      }
      const response = await authFetch(`/api/network-devices/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          alias,
          memberId: editDraft.memberId === "" ? null : editDraft.memberId,
        }),
      });
      if (!response.ok) throw new Error(`edit device: ${response.status}`);
      const updated = (await response.json()) as RegisteredDevice;
      setDevices((prev) => prev.map((d) => (d.id === id ? updated : d)));
      cancelEdit();
    } catch {
      setRowErr(id, t("networkDevices.error.editGeneric"));
    } finally {
      setSavingEdit(false);
    }
  }

  async function deleteDevice(device: RegisteredDevice) {
    // `beliefDiverged` means the LOCAL mirror may be stale in EITHER direction —
    // during that window `isBlocked` alone is not trustworthy either way, so the conservative
    // choice is to assume an upstream block MAY be stranded and show the stronger warning
    // whenever a divergence is in flight, not only when the (possibly-stale) mirror says blocked.
    const confirmMessage =
      device.isBlocked || device.beliefDiverged
        ? t("networkDevices.action.deleteConfirmBlocked")
        : t("networkDevices.action.deleteConfirm");
    if (!window.confirm(confirmMessage)) return;
    setBusyId(device.id);
    setRowErr(device.id, null);
    try {
      const response = await authFetch(`/api/network-devices/${device.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`delete device: ${response.status}`);
      }
      setDevices((prev) => prev.filter((d) => d.id !== device.id));
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
      setDevices((prev) => prev.map((d) => (d.id === device.id ? updated : d)));
      // The controller call itself SUCCEEDED (we only reach here past the 502 branch above) —
      // record the target it reached, authoritatively, for the divergence badge to trust over
      // the response's own (possibly stale) `isBlocked` .
      setAttemptedBlockTarget((prev) => ({ ...prev, [device.id]: targetIsBlocked }));
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

  function onRegistered(device: RegisteredDevice) {
    setDevices((prev) => [...prev, device]);
    setPickerOpen(false);
  }

  if (loading) {
    return (
      <AdminPanel title={t("networkDevices.management.title")}>
        <p className="text-muted-foreground text-[length:var(--control-font-size)]">
          {t("networkDevices.management.loading")}
        </p>
      </AdminPanel>
    );
  }

  return (
    <AdminPanel
      title={t("networkDevices.management.title")}
      description={t("networkDevices.management.description")}
      data-testid="network-devices-management"
    >
      <ErrorNotice message={listError} data-testid="network-devices-error" />
      <ErrorNotice message={membersError} data-testid="network-devices-members-error" />

      <Button
        type="button"
        data-testid="network-devices-open-picker"
        onClick={() => setPickerOpen(true)}
        className="self-start"
      >
        {t("networkDevices.action.register")}
      </Button>

      {pickerOpen && (
        <RegistrationPicker
          t={t}
          activeMembers={activeMembers}
          onCancel={() => setPickerOpen(false)}
          onRegistered={onRegistered}
        />
      )}

      {/* The empty-state text is suppressed whenever the devices read itself failed
 — otherwise a `listError` alongside an empty `devices` array
 (its untouched initial value) rendered BOTH "failed to load" AND "no devices
 registered yet", which reads as a contradiction. */}
      {!listError && devices.length === 0 ? (
        <p
          className="text-muted-foreground text-[length:var(--control-font-size)]"
          data-testid="network-devices-empty"
        >
          {t("networkDevices.management.empty")}
        </p>
      ) : listError ? null : (
        <ul className="flex flex-col gap-2" data-testid="network-devices-list">
          {devices.map((device) => {
            const isEditing = editingId === device.id;
            const isBusy = busyId === device.id;
            const err = rowError[device.id];

            return (
              <li
                key={device.id}
                data-testid={`network-devices-row-${device.id}`}
                className="border rounded-md p-3 flex flex-col gap-2"
              >
                <ErrorNotice message={err} data-testid={`network-devices-row-error-${device.id}`} />

                {isEditing ? (
                  <div className="flex flex-col gap-2">
                    <label className={LABEL_INLINE_CLASSES}>
                      {t("networkDevices.picker.aliasLabel")}
                      <Input
                        type="text"
                        value={editDraft.alias}
                        onChange={(e) => setEditDraft((d) => ({ ...d, alias: e.target.value }))}
                        maxLength={80}
                        className="w-auto"
                        data-testid={`network-devices-edit-alias-${device.id}`}
                      />
                    </label>
                    <label className={LABEL_INLINE_CLASSES}>
                      {t("networkDevices.picker.memberLabel")}
                      <select
                        value={editDraft.memberId}
                        onChange={(e) => setEditDraft((d) => ({ ...d, memberId: e.target.value }))}
                        className={NATIVE_SELECT_CLASSES}
                        data-testid={`network-devices-edit-member-${device.id}`}
                      >
                        <option value="">{t("networkDevices.picker.memberNone")}</option>
                        {/* the currently-linked member can be INACTIVE
 (excluded from `activeMembers`) — without this option, the
 select's `value` matches no `<option>` and renders blank even
 though a member IS assigned. Disabled: it names the current
 assignment but can't be re-selected once changed away from. */}
                        {device.memberInactive && device.memberId && (
                          <option value={device.memberId} disabled>
                            {device.memberLabel} ({t("networkDevices.member.inactive")})
                          </option>
                        )}
                        {/* the members read can fail/degrade independently of
 the registry (see the note above `loadMembers`) — when it does,
 `activeMembers` is empty even though the device's assignment is an
 ACTIVE member (not covered by the `memberInactive` branch above). Without
 this option the controlled select's value matches no `<option>` and
 silently renders "No member", while the hidden `editDraft.memberId`
 still posts the real id on save — a misleading UI. Disabled: same
 reasoning as the inactive-member option, it names the current
 assignment but can't be re-selected once changed away from without a
 successful members read. */}
                        {!device.memberInactive &&
                          device.memberId &&
                          !activeMembers.some((m) => m.id === device.memberId) && (
                            <option value={device.memberId} disabled>
                              {device.memberLabel ?? t("networkDevices.member.currentAssignment")}
                            </option>
                          )}
                        {activeMembers.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.displayName}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        disabled={savingEdit}
                        onClick={() => void saveEdit(device.id)}
                        data-testid={`network-devices-save-${device.id}`}
                      >
                        {savingEdit
                          ? t("networkDevices.action.saving")
                          : t("networkDevices.action.save")}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={cancelEdit}
                        data-testid={`network-devices-cancel-edit-${device.id}`}
                      >
                        {t("networkDevices.action.cancel")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex justify-between items-start">
                    <div>
                      <strong data-testid={`network-devices-alias-${device.id}`}>
                        {device.alias}
                      </strong>
                      <DeviceStatusBadges
                        t={t}
                        device={device}
                        cacheState={cacheState}
                        attemptedBlockTarget={attemptedBlockTarget[device.id]}
                      />
                      <MemberLabel t={t} device={device} />
                    </div>
                    <div className="flex gap-2">
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
                        onClick={() => void deleteDevice(device)}
                        data-testid={`network-devices-delete-${device.id}`}
                      >
                        {t("networkDevices.action.delete")}
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </AdminPanel>
  );
}

/* ------------------------------------------------------------------ */
/* DeviceStatusBadges — liveStatus (online/notDetected/unknown) + */
/* belief-divergence affordance, never inventing a status. */
/* ------------------------------------------------------------------ */

function cacheStateMessageKey(state: LiveCacheState): MessageKey {
  if (state === "unconfigured") return "networkDevices.cacheState.unconfigured";
  if (state === "cold") return "networkDevices.cacheState.cold";
  if (state === "stale") return "networkDevices.cacheState.stale";
  if (state === "freshEmpty") return "networkDevices.cacheState.freshEmpty";
  return "networkDevices.cacheState.fresh";
}

function DeviceStatusBadges({
  t,
  device,
  cacheState,
  attemptedBlockTarget,
}: {
  t: (key: MessageKey) => string;
  device: RegisteredDevice;
  cacheState: LiveCacheState | null;
  /** the AUTHORITATIVE target of the most recent LOCAL block/unblock action for
   * this device (`true` = the action was targeting "blocked"), or `undefined` when this row
   * has no locally-attempted action to trust (e.g. arrived already-divergent from a page load).
   * See `attemptedBlockTarget` state in the parent for the full rationale. */
  attemptedBlockTarget?: boolean;
}) {
  const liveStatusKey: MessageKey =
    device.liveStatus === "online"
      ? "networkDevices.liveStatus.online"
      : device.liveStatus === "notDetected"
        ? "networkDevices.liveStatus.notDetected"
        : "networkDevices.liveStatus.unknown";

  let blockBadge: string | null = null;
  if (device.beliefDiverged) {
    // The response's OWN `isBlocked` is the pre-divergence (stale) belief, not the outcome — the
    // controller call itself is what succeeded. When THIS session attempted the action, trust
    // that authoritative target instead. When it didn't (a load-time divergent row has no local
    // action to trust either direction from), render a NEUTRAL label that names neither state —
    // guessing here would be the exact bug this fix corrects.
    blockBadge =
      attemptedBlockTarget === undefined
        ? t("networkDevices.badge.stateConfirming")
        : t(
            attemptedBlockTarget
              ? "networkDevices.badge.blockedConfirming"
              : "networkDevices.badge.unblockedConfirming"
          );
  } else if (device.isBlocked) {
    blockBadge = t("networkDevices.badge.blocked");
  }

  return (
    <div
      className="text-muted-foreground text-[length:var(--control-font-size)]"
      data-testid={`network-devices-status-${device.id}`}
    >
      <span>{t(liveStatusKey)}</span>
      {blockBadge && <span> · {blockBadge}</span>}
      {/* lastSeenAt: deliberately NEVER shown next to "online" (see module comment) — only
 for notDetected/unknown, where the observation stamp is the useful signal. */}
      {device.liveStatus !== "online" &&
        (device.lastSeenAt === null ? (
          <span> · {t("networkDevices.row.neverSeen")}</span>
        ) : (
          <span>
            {" "}
            · {t("networkDevices.row.lastSeenLabel")} {formatLastSeen(device.lastSeenAt)}
          </span>
        ))}
      {/* "unknown" is derived from a NON-fresh cache (the liveStatus derivation) — naming WHY it's unknown (cache unconfigured/cold/stale)
 is more useful than the bare word "unknown" on its own. */}
      {device.liveStatus === "unknown" && cacheState !== null && (
        <span>
          {" "}
          · {t("networkDevices.row.cacheStateLabel")} {t(cacheStateMessageKey(cacheState))}
        </span>
      )}
    </div>
  );
}

function MemberLabel({ t, device }: { t: (key: MessageKey) => string; device: RegisteredDevice }) {
  if (device.memberId === null) {
    return (
      <div className="text-muted-foreground text-[length:var(--control-font-size)]">
        {t("networkDevices.member.none")}
      </div>
    );
  }
  return (
    <div className="text-muted-foreground text-[length:var(--control-font-size)]">
      {device.memberLabel}
      {device.memberInactive && <> ({t("networkDevices.member.inactive")})</>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* RegistrationPicker — inline "modal" panel (a toggled section, not a */
/* portal-based Dialog: keeps this jsdom-testable with plain */
/* render/screen queries, matching every other admin panel's */
/* inline-form convention in this codebase). Fetches the LIVE cache */
/* and renders each of the 5 closed states distinctly (FR-020). */
/* */
/* Kept as its own hand-rolled `<section aria-labelledby>` rather than */
/* a nested `AdminPanel`: `AdminPanel`'s `headingLevel` only supports */
/* `"h1"`/`"h2"`, and this panel is nested one level below the main */
/* `AdminPanel`'s own `h2` title — reusing `h2` here would duplicate the */
/* page's heading level with no `h3` in between. The manual */
/* `aria-labelledby` pointing at its own heading already gives the same */
/* landmark/name pairing `AdminPanel` would (a named `<section>` is */
/* implicitly `role="region"`), so nothing is lost. */
/* ------------------------------------------------------------------ */

interface RegistrationPickerProps {
  t: (key: MessageKey) => string;
  activeMembers: Member[];
  onCancel: () => void;
  onRegistered: (device: RegisteredDevice) => void;
}

type PickerLoadState =
  | { phase: "loading" }
  | { phase: "loadError" }
  | { phase: "ready"; state: LiveCacheState; clients: LiveClient[] };

function RegistrationPicker({ t, activeMembers, onCancel, onRegistered }: RegistrationPickerProps) {
  const [load, setLoad] = useState<PickerLoadState>({ phase: "loading" });
  const [selectedMac, setSelectedMac] = useState<string | null>(null);
  const [alias, setAlias] = useState("");
  const [memberId, setMemberId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    void loadLiveClients();
  }, []);

  async function loadLiveClients() {
    setLoad({ phase: "loading" });
    try {
      const response = await authFetch("/api/network-devices/live-clients", {
        credentials: "include",
      });
      if (!response.ok) throw new Error(`live-clients: ${response.status}`);
      const data = (await response.json()) as LiveClientsResponse;
      setLoad({ phase: "ready", state: data.state, clients: data.clients });
    } catch {
      setLoad({ phase: "loadError" });
    }
  }

  async function submit() {
    if (selectedMac === null) return;
    const aliasTrim = alias.trim();
    if (aliasTrim === "") {
      setFormError(t("networkDevices.error.aliasRequired"));
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const response = await authFetch("/api/network-devices", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mac: selectedMac,
          alias: aliasTrim,
          memberId: memberId === "" ? null : memberId,
        }),
      });
      if (response.status === 409) {
        const code = await parseErrorCode(response);
        setFormError(
          t(
            code === "reselect_required"
              ? "networkDevices.error.reselectRequired"
              : code === "duplicate_mac"
                ? "networkDevices.error.duplicateMac"
                : "networkDevices.error.registerGeneric"
          )
        );
        return;
      }
      if (!response.ok) throw new Error(`register device: ${response.status}`);
      const device = (await response.json()) as RegisteredDevice;
      onRegistered(device);
    } catch {
      setFormError(t("networkDevices.error.registerGeneric"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section
      aria-labelledby="network-devices-picker-title"
      data-testid="network-devices-picker"
      className="border rounded-md p-4 mb-4 bg-card"
    >
      <h3 id="network-devices-picker-title" className="font-semibold mb-2">
        {t("networkDevices.picker.title")}
      </h3>
      <p className="text-muted-foreground text-[length:var(--control-font-size)] mb-2">
        {t("networkDevices.picker.description")}
      </p>

      <ErrorNotice
        message={formError}
        className="mb-2"
        data-testid="network-devices-picker-error"
      />

      {load.phase === "loading" && (
        <p data-testid="network-devices-picker-state">{t("networkDevices.picker.state.loading")}</p>
      )}
      {load.phase === "loadError" && (
        <ErrorNotice
          message={t("networkDevices.error.pickerLoadError")}
          data-testid="network-devices-picker-state"
        />
      )}
      {load.phase === "ready" && load.state !== "fresh" && (
        <p data-testid="network-devices-picker-state">
          {t(
            load.state === "unconfigured"
              ? "networkDevices.picker.state.unconfigured"
              : load.state === "cold"
                ? "networkDevices.picker.state.cold"
                : load.state === "stale"
                  ? "networkDevices.picker.state.stale"
                  : "networkDevices.picker.state.freshEmpty"
          )}
        </p>
      )}
      {load.phase === "ready" && load.state === "fresh" && load.clients.length === 0 && (
        <p data-testid="network-devices-picker-state">
          {t("networkDevices.picker.state.freshEmpty")}
        </p>
      )}

      {load.phase === "ready" &&
        load.state === "fresh" &&
        load.clients.length > 0 &&
        selectedMac === null && (
          <ul className="flex flex-col gap-1 mb-2" data-testid="network-devices-picker-clients">
            {load.clients.map((client) => (
              <li
                key={client.mac}
                className="flex justify-between items-center border rounded-md px-2 py-1"
              >
                {/* Deliberate MAC render — the picker's ONLY identity signal before an alias
 exists (see module comment for the FR-013-scope rationale). */}
                <span data-testid={`network-devices-picker-client-${client.mac}`}>
                  {client.displayName ?? t("networkDevices.picker.unnamedDevice")} — {client.mac}
                </span>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => setSelectedMac(client.mac)}
                  data-testid={`network-devices-picker-select-${client.mac}`}
                >
                  {t("networkDevices.picker.select")}
                </Button>
              </li>
            ))}
          </ul>
        )}

      {selectedMac !== null && (
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            variant="link"
            onClick={() => setSelectedMac(null)}
            data-testid="network-devices-picker-change-selection"
            className="self-start"
          >
            {t("networkDevices.picker.changeSelection")}
          </Button>
          <label className={LABEL_INLINE_CLASSES}>
            {t("networkDevices.picker.aliasLabel")}
            <Input
              type="text"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              maxLength={80}
              placeholder={t("networkDevices.picker.aliasPlaceholder")}
              data-testid="network-devices-picker-alias-input"
              className="w-auto"
            />
          </label>
          <label className={LABEL_INLINE_CLASSES}>
            {t("networkDevices.picker.memberLabel")}
            <select
              value={memberId}
              onChange={(e) => setMemberId(e.target.value)}
              data-testid="network-devices-picker-member-select"
              className={NATIVE_SELECT_CLASSES}
            >
              <option value="">{t("networkDevices.picker.memberNone")}</option>
              {activeMembers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-2">
            <Button
              type="button"
              disabled={submitting}
              onClick={() => void submit()}
              data-testid="network-devices-picker-submit"
            >
              {submitting
                ? t("networkDevices.picker.submitting")
                : t("networkDevices.picker.submit")}
            </Button>
          </div>
        </div>
      )}

      <div className="mt-2">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          data-testid="network-devices-picker-cancel"
        >
          {t("networkDevices.picker.cancel")}
        </Button>
      </div>
    </section>
  );
}
