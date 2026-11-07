import { useEffect, useRef } from "react";

import { ErrorNotice } from "@/components/ErrorNotice";
import { StatusToggle } from "@/components/StatusToggle";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import type { MessageKey } from "@/i18n/messages";
import type {
  PluginCatalogEntry,
  PluginContributionSummary,
  PluginId,
  PluginPublicErrorCode,
} from "../../shared/plugins";
import { usePluginCatalog, type PluginCatalogFeedbackCode } from "./PluginCatalogProvider";

const PLUGIN_COPY: Record<PluginId, { label: MessageKey; description: MessageKey }> = {
  "daily-briefing": {
    label: "plugins.dailyBriefing.label",
    description: "plugins.dailyBriefing.description",
  },
  printing: { label: "plugins.printing.label", description: "plugins.printing.description" },
  weather: { label: "plugins.weather.label", description: "plugins.weather.description" },
  "time-announcements": {
    label: "plugins.timeAnnouncements.label",
    description: "plugins.timeAnnouncements.description",
  },
  backups: { label: "plugins.backups.label", description: "plugins.backups.description" },
  "network-devices": {
    label: "plugins.networkDevices.label",
    description: "plugins.networkDevices.description",
  },
  "meals-recipes": {
    label: "plugins.mealsRecipes.label",
    description: "plugins.mealsRecipes.description",
  },
  reminders: { label: "plugins.reminders.label", description: "plugins.reminders.description" },
  "daily-messages": {
    label: "plugins.dailyMessages.label",
    description: "plugins.dailyMessages.description",
  },
};

const GROUP_COPY: Record<keyof PluginContributionSummary, MessageKey> = {
  routes: "plugins.group.routes",
  admin: "plugins.group.admin",
  settings: "plugins.group.settings",
  widgets: "plugins.group.widgets",
  services: "plugins.group.services",
  jobs: "plugins.group.jobs",
};

const PUBLIC_ERROR_COPY: Record<PluginPublicErrorCode, MessageKey> = {
  settings_initialization_failed: "plugins.error.settings",
  migration_failed: "plugins.error.migration",
  runtime_mount_failed: "plugins.error.mount",
  drain_failed: "plugins.error.drain",
  runtime_unmount_failed: "plugins.error.unmount",
  contribution_failed: "plugins.error.contribution",
  reconciliation_failed: "plugins.error.reconciliation",
};

const FEEDBACK_COPY: Record<PluginCatalogFeedbackCode, MessageKey> = {
  plugin_lifecycle_busy: "plugins.feedback.busy",
  plugin_lifecycle_failed: "plugins.feedback.failed",
  plugin_catalog_unavailable: "plugins.feedback.unavailable",
};

function safeSettingLabel(plugin: PluginCatalogEntry, key: string): MessageKey | null {
  if (plugin.id === "weather") {
    if (key === "weatherLat") return "weather.management.latLabel";
    if (key === "weatherLon") return "weather.management.lonLabel";
    if (key === "weatherLabel") return "weather.management.labelLabel";
  }
  if (plugin.id === "daily-briefing") {
    if (key === "dailyBriefingGenerationTime") return "dailyBriefing.admin.generationTimeLabel";
    if (key === "dailyBriefingAutoPrintTrigger") return "dailyBriefing.admin.triggerBindingLabel";
  }
  return null;
}

function CatalogRow({ plugin }: { plugin: PluginCatalogEntry }) {
  const t = useT();
  const { clearPendingActionFocus, feedback, pendingActionFocus, transition } = usePluginCatalog();
  const headingRef = useRef<HTMLHeadingElement>(null);
  // StatusToggle takes no ref, so focus goes through the box that holds it.
  const actionBoxRef = useRef<HTMLDivElement>(null);
  const copy = PLUGIN_COPY[plugin.id];
  const label = t(copy.label);
  const busy = plugin.operation !== null;
  const action = plugin.state === "active" ? "deactivate" : "activate";
  const currentFeedback = feedback[plugin.id];
  const operationMessageId = `plugin-operation-${plugin.id}`;

  useEffect(() => {
    if (window.location.hash === `#plugin-${plugin.id}`) headingRef.current?.focus();
  }, [plugin.id]);

  useEffect(() => {
    if (busy || pendingActionFocus !== plugin.id) return;
    actionBoxRef.current?.querySelector("button")?.focus();
    clearPendingActionFocus(plugin.id);
  }, [busy, clearPendingActionFocus, pendingActionFocus, plugin.id]);

  return (
    <Card
      id={`plugin-${plugin.id}`}
      data-testid={`plugin-row-${plugin.id}`}
      data-plugin-id={plugin.id}
      // An inactive plugin is greyed out so it stands apart; "needs attention" keeps the normal
      // ground and its error notice.
      className={cn(
        "min-w-0 gap-4 overflow-hidden py-4",
        plugin.state === "inactive" && "bg-muted"
      )}
    >
      <CardHeader className="min-w-0 grid-cols-1 px-4 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <CardTitle>
            <h2 ref={headingRef} tabIndex={-1} className="wrap-anywhere outline-none">
              {label}
            </h2>
          </CardTitle>
          <CardDescription className="wrap-anywhere">{t(copy.description)}</CardDescription>
        </div>
        <div ref={actionBoxRef} className="flex flex-col items-start gap-2 sm:items-end">
          <StatusToggle
            pressed={plugin.state === "active"}
            label={
              <span data-testid={`plugin-state-${plugin.id}`}>
                {t(`plugins.state.${plugin.state}`)}
              </span>
            }
            accessibleName={label}
            busy={busy}
            aria-describedby={busy ? operationMessageId : undefined}
            onPress={() => void transition(plugin.id, action)}
          />
          {busy && (
            <span
              id={operationMessageId}
              aria-live="polite"
              aria-atomic="true"
              className="text-muted-foreground text-sm"
            >
              {t(
                plugin.operation?.targetState === "inactive"
                  ? "plugins.operation.deactivating"
                  : "plugins.operation.activating"
              )}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4 px-4">
        <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
          <div>
            <dt className="font-medium">{t("plugins.trust.label")}</dt>
            <dd>{t("plugins.trust.firstParty")}</dd>
          </div>
          <div className="min-w-0">
            <dt className="font-medium">{t("plugins.requirements")}</dt>
            <dd className="wrap-anywhere">
              {plugin.requirements.length > 0 ? plugin.requirements.join(", ") : t("plugins.none")}
            </dd>
          </div>
        </dl>

        <div className="grid min-w-0 gap-2 sm:grid-cols-2">
          {(Object.keys(GROUP_COPY) as (keyof PluginContributionSummary)[]).map((group) => (
            <div key={group} className="min-w-0">
              <h3 className="font-medium">{t(GROUP_COPY[group])}</h3>
              <p className="text-muted-foreground wrap-anywhere text-sm">
                {plugin.contributions[group].length > 0
                  ? plugin.contributions[group].join(", ")
                  : t("plugins.none")}
              </p>
            </div>
          ))}
        </div>

        {plugin.settingsSchema.length > 0 && (
          <div>
            <h3 className="font-medium">{t("plugins.settingsSchema")}</h3>
            <ul className="list-disc space-y-1 pl-5">
              {plugin.settingsSchema.map((setting) => {
                const settingLabel = safeSettingLabel(plugin, setting.key);
                if (settingLabel === null) return null;
                return (
                  <li key={setting.key} className="wrap-anywhere">
                    {t(settingLabel)} · {t(`plugins.valueType.${setting.valueType}`)} ·{" "}
                    {setting.required ? t("plugins.required") : t("plugins.optional")}
                    {setting.sensitive ? ` · ${t("plugins.protectedValue")}` : ""}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {plugin.state === "errored" && plugin.error !== null && (
          <ErrorNotice message={t(PUBLIC_ERROR_COPY[plugin.error.code])} politeness="polite" />
        )}
        <ErrorNotice
          message={currentFeedback ? t(FEEDBACK_COPY[currentFeedback]) : null}
          politeness="polite"
        />
      </CardContent>
    </Card>
  );
}

export function PluginManagement() {
  const t = useT();
  const { plugins, refreshing, reload, status } = usePluginCatalog();

  if (status === "loading") return <p aria-live="polite">{t("plugins.loading")}</p>;
  if (status === "error") {
    return (
      <section className="flex min-w-0 flex-col gap-4">
        <ErrorNotice message={t("plugins.loadError")} politeness="polite" />
        <Button type="button" variant="outline" disabled={refreshing} onClick={() => void reload()}>
          {refreshing ? t("plugins.retrying") : t("plugins.retry")}
        </Button>
      </section>
    );
  }

  return (
    <section
      className="flex min-w-0 max-w-full flex-col gap-4"
      aria-labelledby="plugin-catalog-title"
    >
      <div>
        <h1 id="plugin-catalog-title" className="text-xl font-bold">
          {t("plugins.title")}
        </h1>
        <p className="text-muted-foreground">{t("plugins.description")}</p>
      </div>
      <div data-testid="plugin-catalog" className="grid min-w-0 max-w-full gap-4">
        {plugins.map((plugin) => (
          <CatalogRow key={plugin.id} plugin={plugin} />
        ))}
      </div>
    </section>
  );
}
