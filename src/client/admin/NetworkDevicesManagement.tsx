import { useState } from "react";
import { useTranslation } from "@/i18n";
import { AdminPanel } from "@/components/AdminPanel";
import { Button } from "@/components/ui/button";
import { useNetworkDevicesData } from "./network-devices/data";
import { DiscoverDevices } from "./network-devices/DiscoverDevices";
import { RegisteredDevices } from "./network-devices/RegisteredDevices";

/** Manage curated aliases and member assignments separately from controller discovery.
 * Two tabs, kept as LOCAL state (not URL sub-routes): `AdminUnlockRouteReset` relocks the admin on
 * any `/admin/*` path `resolveHouseholdRoute` does not know exactly, so a sub-path per tab would
 * relock on every switch. MAC addresses identify unregistered entries in the discovery table only;
 * registered rows and both dialogs use household aliases. Last-seen timestamps are shown for
 * unknown/not-detected states, never as live online evidence. Edit and register use Dialogs and
 * delete goes through `ConfirmDialog`. */
export function NetworkDevicesManagement() {
  const { t } = useTranslation();
  const data = useNetworkDevicesData();
  const [tab, setTab] = useState<"registered" | "add">("registered");

  // The first load of the Registered tab shows only the loading text. `loading` is false once that
  // load settles (failure included), so the "Add device" control stays reachable after a 403.
  if (data.loading && tab === "registered") {
    return (
      <AdminPanel title={t("networkDevices.management.title")}>
        <p className="text-muted-foreground text-control">
          {t("networkDevices.management.loading")}
        </p>
      </AdminPanel>
    );
  }

  const tabs = [
    { id: "registered", label: t("networkDevices.tabs.registered") },
    { id: "add", label: t("networkDevices.tabs.add") },
  ] as const;

  return (
    <AdminPanel
      title={t("networkDevices.management.title")}
      description={t("networkDevices.management.description")}
      data-testid="network-devices-management"
      actions={
        tab === "registered" ? (
          <Button
            type="button"
            data-testid="network-devices-open-picker"
            onClick={() => setTab("add")}
          >
            {t("networkDevices.action.register")}
          </Button>
        ) : undefined
      }
    >
      <div
        role="tablist"
        aria-label={t("networkDevices.tabs.label")}
        className="flex w-fit gap-1 rounded-lg border bg-muted p-1"
      >
        {tabs.map((entry) => (
          <Button
            key={entry.id}
            type="button"
            role="tab"
            variant={tab === entry.id ? "default" : "ghost"}
            aria-selected={tab === entry.id}
            data-testid={`network-devices-tab-${entry.id}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </Button>
        ))}
      </div>
      {tab === "registered" ? (
        <RegisteredDevices data={data} onAdd={() => setTab("add")} />
      ) : (
        <DiscoverDevices data={data} onRegistered={() => setTab("registered")} />
      )}
    </AdminPanel>
  );
}
