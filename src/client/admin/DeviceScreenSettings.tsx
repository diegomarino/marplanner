import { useState } from "react";

import { AdminPanel } from "@/components/AdminPanel";
import { ChoicePills } from "@/components/ChoicePills";
import { useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import {
  loadScreenAwakePreferences,
  saveScreenAwakePreferences,
  screenAwakeSupport,
  type ScreenAwakeNight,
  type ScreenAwakePreferences,
} from "@/shell/screenAwakePreferences";

const SUPPORT_KEYS: Record<ReturnType<typeof screenAwakeSupport>, MessageKey> = {
  supported: "admin.device.screenAwake.supported",
  "insecure-context": "admin.device.screenAwake.insecure",
  unsupported: "admin.device.screenAwake.unsupported",
};

/** "This device" settings: browser-local, saved the moment they change (no Save button, no
 * server write) and applied by the always-mounted `ScreenAwake` service. */
export function DeviceScreenSettings(): React.JSX.Element {
  const t = useT();
  const [preferences, setPreferences] = useState(loadScreenAwakePreferences);
  const [support] = useState(screenAwakeSupport);

  const update = (next: ScreenAwakePreferences) => {
    setPreferences(next);
    saveScreenAwakePreferences(next);
  };

  const enabledLabel = t("admin.device.screenAwake.label");
  const nightLabel = t("admin.device.screenAwake.night");

  return (
    <AdminPanel
      title={t("admin.device.title")}
      description={t("admin.device.description")}
      data-testid="device-screen-settings"
    >
      <div className="bg-card flex flex-col gap-6 rounded-lg p-4 shadow">
        <div className="flex flex-col gap-1">
          <span className="text-control font-semibold">{enabledLabel}</span>
          <p className="text-muted-foreground text-control">
            {t("admin.device.screenAwake.description")}
          </p>
          <ChoicePills
            value={preferences.enabled ? "on" : "off"}
            groupLabel={enabledLabel}
            onChange={(value) => update({ ...preferences, enabled: value === "on" })}
            options={[
              {
                value: "on",
                label: t("admin.device.screenAwake.on"),
                "data-testid": "device-screen-awake-on",
              },
              {
                value: "off",
                label: t("admin.device.screenAwake.off"),
                "data-testid": "device-screen-awake-off",
              },
            ]}
          />
          <p
            className="text-muted-foreground text-control"
            data-support={support}
            data-testid="device-screen-awake-support"
          >
            {t(SUPPORT_KEYS[support])}
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-control font-semibold">{nightLabel}</span>
          <p className="text-muted-foreground text-control">
            {t("admin.device.screenAwake.nightDescription")}
          </p>
          <ChoicePills<ScreenAwakeNight>
            value={preferences.night}
            groupLabel={nightLabel}
            disabled={!preferences.enabled}
            onChange={(night) => update({ ...preferences, night })}
            options={[
              {
                value: "dim",
                label: t("admin.device.screenAwake.nightDim"),
                "data-testid": "device-screen-awake-night-dim",
              },
              {
                value: "off",
                label: t("admin.device.screenAwake.nightOff"),
                "data-testid": "device-screen-awake-night-off",
              },
            ]}
          />
        </div>
      </div>
    </AdminPanel>
  );
}
