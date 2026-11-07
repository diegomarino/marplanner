import { RefreshCw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { useOptionalPluginCatalog } from "./PluginCatalogProvider";

/**
 * Explains missing or possibly outdated plugin entries in the admin sidebar while the catalog
 * cannot be fetched, and offers a manual retry alongside the automatic one.
 */
export function PluginCatalogNotice() {
  const t = useT();
  const catalog = useOptionalPluginCatalog();
  if (catalog === null || !catalog.failed) return null;
  const message =
    catalog.status === "ready"
      ? t("plugins.catalogNotice.stale")
      : t("plugins.catalogNotice.unavailable");

  return (
    <div
      data-testid="plugin-catalog-notice"
      role="status"
      className="border-destructive/40 bg-destructive/10 text-destructive flex flex-col gap-2 rounded-xl border px-3 py-2 text-sm"
    >
      <p className="flex items-start gap-2 font-medium">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        {message}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        disabled={catalog.refreshing}
        onClick={() => void catalog.reload()}
      >
        <RefreshCw aria-hidden="true" className={catalog.refreshing ? "animate-spin" : undefined} />
        {catalog.refreshing
          ? t("plugins.catalogNotice.retrying")
          : t("plugins.catalogNotice.retry")}
      </Button>
    </div>
  );
}
