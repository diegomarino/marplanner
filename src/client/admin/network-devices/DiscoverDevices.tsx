import { useCallback, useEffect, useState } from "react";
import { authFetch } from "@/lib/credential";
import { useTranslation } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import type {
  LiveCacheState,
  LiveClient,
  LiveClientsResponse,
  RegisteredDevice,
} from "../../../shared";
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
import {
  LoadFailure,
  loadFailureMessageKey,
  parseErrorCode,
  type NetworkDevicesData,
} from "./data";

type SortKey = "name" | "mac";
type SortDir = "asc" | "desc";

/** Stable sorted copy. Unnamed clients sort LAST for both directions of the name sort. */
export function sortClients(
  clients: LiveClient[],
  key: SortKey,
  dir: SortDir,
  language: string
): LiveClient[] {
  const sign = dir === "asc" ? 1 : -1;
  const locale = language === "es" ? "es" : "en";
  return [...clients].sort((a, b) => {
    if (key === "mac") return sign * (a.mac < b.mac ? -1 : a.mac > b.mac ? 1 : 0);
    const an = a.displayName ?? "";
    const bn = b.displayName ?? "";
    if (an === "" && bn === "") return 0;
    if (an === "") return 1;
    if (bn === "") return -1;
    return sign * an.localeCompare(bn, locale);
  });
}

/** The registration dialog's alias prefill: the controller's client name, cut to the server limit. */
export function initialAlias(client: LiveClient): string {
  return (client.displayName ?? "").trim().slice(0, 80);
}

type LoadState =
  | { phase: "loading" }
  | { phase: "loadError"; key: MessageKey }
  | { phase: "ready"; state: LiveCacheState; clients: LiveClient[] };

/** Discovery table + registration Dialog. Fetches the LIVE cache and renders each of the 5 closed
 * states distinctly (FR-020).
 *
 * Kept as its own hand-rolled `<section aria-labelledby>` rather than a nested `AdminPanel`:
 * `AdminPanel`'s `headingLevel` only supports `"h1"`/`"h2"`, and this section sits one level
 * below the main panel's own `h2` — reusing `h2` would duplicate the heading level with no `h3`
 * in between. A named `<section>` is implicitly `role="region"`, so nothing is lost. */
export function DiscoverDevices({
  data,
  onRegistered,
}: {
  data: NetworkDevicesData;
  onRegistered: () => void;
}) {
  const { t, language } = useTranslation();
  const [load, setLoad] = useState<LoadState>({ phase: "loading" });
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const [selected, setSelected] = useState<LiveClient | null>(null);
  const [alias, setAlias] = useState("");
  const [memberId, setMemberId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const loadClients = useCallback(async () => {
    setLoad({ phase: "loading" });
    try {
      const response = await authFetch("/api/network-devices/live-clients", {
        credentials: "include",
      });
      if (!response.ok) throw new LoadFailure(response.status, await parseErrorCode(response));
      const body = (await response.json()) as LiveClientsResponse;
      setLoad({ phase: "ready", state: body.state, clients: body.clients });
    } catch (err) {
      setLoad({
        phase: "loadError",
        key:
          err instanceof LoadFailure
            ? loadFailureMessageKey(err.status, err.code, "networkDevices.error.pickerLoadError")
            : "networkDevices.error.pickerLoadError",
      });
    }
  }, []);

  useEffect(() => {
    void loadClients();
  }, [loadClients]);

  function select(client: LiveClient) {
    setSelected(client);
    setAlias(initialAlias(client));
    setMemberId("");
    setFormError(null);
  }

  function closeDialog() {
    setSelected(null);
    setFormError(null);
  }

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  async function submit() {
    if (selected === null) return;
    const aliasTrim = alias.trim();
    if (aliasTrim === "") {
      setFormError(t("networkDevices.error.aliasRequired"));
      return;
    }
    setSubmitting(true);
    setFormError(null);
    data.markMutation();
    try {
      const response = await authFetch("/api/network-devices", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mac: selected.mac,
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
        // The live list the user picked from is out of date: refresh the table behind the dialog.
        if (code === "reselect_required") void loadClients();
        return;
      }
      if (!response.ok) throw new Error(`register device: ${response.status}`);
      const device = (await response.json()) as RegisteredDevice;
      data.addDevice(device);
      closeDialog();
      onRegistered();
    } catch {
      setFormError(t("networkDevices.error.registerGeneric"));
    } finally {
      setSubmitting(false);
    }
  }

  const registered = new Set(data.devices.map((d) => d.mac.toLowerCase()));
  const rows =
    load.phase === "ready" && load.state === "fresh"
      ? sortClients(load.clients, sortKey, sortDir, language)
      : [];

  const columns: { key: SortKey; label: string }[] = [
    { key: "name", label: t("networkDevices.discover.columnName") },
    { key: "mac", label: t("networkDevices.discover.columnMac") },
  ];

  return (
    <section
      aria-labelledby="network-devices-picker-title"
      data-testid="network-devices-picker"
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id="network-devices-picker-title" className="font-semibold">
            {t("networkDevices.picker.title")}
          </h3>
          <p className="text-muted-foreground text-control">
            {t("networkDevices.picker.description")}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => void loadClients()}
          data-testid="network-devices-discover-refresh"
        >
          {t("networkDevices.action.refresh")}
        </Button>
      </div>

      {load.phase === "loading" && (
        <p data-testid="network-devices-picker-state">{t("networkDevices.picker.state.loading")}</p>
      )}
      {load.phase === "loadError" && (
        <div className="flex flex-col items-start gap-2">
          <ErrorNotice message={t(load.key)} data-testid="network-devices-picker-state" />
          <Button
            type="button"
            variant="secondary"
            onClick={() => void loadClients()}
            data-testid="network-devices-picker-retry"
          >
            {t("networkDevices.action.retry")}
          </Button>
        </div>
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

      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left" data-testid="network-devices-picker-clients">
            <thead>
              <tr>
                {columns.map((col) => (
                  <th
                    key={col.key}
                    scope="col"
                    aria-sort={
                      sortKey === col.key
                        ? sortDir === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => toggleSort(col.key)}
                      aria-label={t("networkDevices.discover.sortBy").replace(
                        "{column}",
                        col.label
                      )}
                      data-testid={`network-devices-sort-${col.key}`}
                    >
                      {col.label}
                      <span aria-hidden="true">
                        {sortKey === col.key ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
                      </span>
                    </Button>
                  </th>
                ))}
                <th scope="col">
                  <span className="sr-only">{t("networkDevices.picker.select")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((client) => {
                const added = registered.has(client.mac.toLowerCase());
                return (
                  <tr
                    key={client.mac}
                    data-testid={`network-devices-picker-client-${client.mac}`}
                    className={added ? "opacity-50" : undefined}
                  >
                    <td className="py-2 pr-4">
                      {client.displayName ?? t("networkDevices.picker.unnamedDevice")}
                    </td>
                    {/* Deliberate MAC render — the discovery table is the ONLY identity signal
                        before an alias exists (FR-015 scope; the one documented exception). */}
                    <td className="py-2 pr-4 font-mono">{client.mac}</td>
                    <td className="py-2 text-right">
                      {added ? (
                        <span
                          className="rounded-full border px-2 py-0.5 text-xs"
                          data-testid={`network-devices-picker-added-${client.mac}`}
                        >
                          {t("networkDevices.discover.alreadyAdded")}
                        </span>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => select(client)}
                          data-testid={`network-devices-picker-select-${client.mac}`}
                        >
                          {t("networkDevices.picker.select")}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open && !submitting) closeDialog();
        }}
      >
        <DialogContent
          closeLabel={t("networkDevices.picker.cancel")}
          data-testid="network-devices-register-dialog"
          className="sm:max-w-md"
        >
          <DialogHeader>
            <DialogTitle>{t("networkDevices.register.title")}</DialogTitle>
            <DialogDescription>{t("networkDevices.register.description")}</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <ErrorNotice message={formError} data-testid="network-devices-picker-error" />
            <Field label={t("networkDevices.picker.aliasLabel")}>
              <Input
                type="text"
                maxLength={80}
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                placeholder={t("networkDevices.picker.aliasPlaceholder")}
                data-testid="network-devices-picker-alias-input"
              />
            </Field>
            <Field label={t("networkDevices.picker.memberLabel")}>
              <select
                className={NATIVE_SELECT_CLASSES}
                value={memberId}
                onChange={(e) => setMemberId(e.target.value)}
                data-testid="network-devices-picker-member-select"
              >
                <option value="">{t("networkDevices.picker.memberNone")}</option>
                {data.members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex gap-2">
              <Button
                type="submit"
                disabled={submitting}
                data-testid="network-devices-picker-submit"
              >
                {submitting
                  ? t("networkDevices.picker.submitting")
                  : t("networkDevices.picker.submit")}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={closeDialog}
                data-testid="network-devices-picker-cancel"
              >
                {t("networkDevices.picker.cancel")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
