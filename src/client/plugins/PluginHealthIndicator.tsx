import { appUrl } from "@/lib/base-path";
import { Activity, CircleCheck, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { usePluginCatalog } from "./PluginCatalogProvider";

function navigateToPlugin(pluginId?: string): void {
  const hash = pluginId ? `#plugin-${pluginId}` : "";
  window.history.pushState(null, "", appUrl(`/admin/plugins${hash}`));
  window.dispatchEvent(new PopStateEvent("popstate"));
  if (pluginId) {
    requestAnimationFrame(() =>
      document.getElementById(`plugin-${pluginId}`)?.querySelector("h2")?.focus()
    );
  }
}

export function PluginHealthIndicator() {
  const t = useT();
  const { plugins, status } = usePluginCatalog();
  if (status !== "ready") return null;

  const errored = plugins.find((plugin) => plugin.state === "errored");
  const busy = plugins.some((plugin) => plugin.operation !== null);

  if (errored) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid="plugin-health-indicator"
        aria-label={t("plugins.health.attention")}
        onClick={() => navigateToPlugin(errored.id)}
      >
        <TriangleAlert aria-hidden="true" />
        {t("plugins.health.attention")}
      </Button>
    );
  }

  return (
    <span
      data-testid="plugin-health-indicator"
      className="text-muted-foreground inline-flex items-center gap-2 text-sm"
      aria-live="polite"
    >
      {busy ? <Activity aria-hidden="true" /> : <CircleCheck aria-hidden="true" />}
      {busy ? t("plugins.health.activity") : t("plugins.health.neutral")}
    </span>
  );
}
