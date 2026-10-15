/** Printer admin page (FR-012/FR-013/FR-016/FR-017). Two local-state tabs — never URL sub-routes:
 * `resolveHouseholdRoute` only matches exact admin paths, so a sub-path would relock admin on every
 * switch. Settings is the default (reference parity); only the open tab is mounted, so each tab
 * reads fresh data when opened. */
import { useState } from "react";

import { AdminPanel } from "@/components/AdminPanel";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { PrinterDiagnosticsTab } from "./printer/PrinterDiagnosticsTab";
import { PrinterSettingsTab } from "./printer/PrinterSettingsTab";

type PrinterTab = "settings" | "diagnostics";

export function PrintingManagement(): React.JSX.Element {
  const t = useT();
  const [tab, setTab] = useState<PrinterTab>("settings");
  const tabs: Array<{ id: PrinterTab; label: string }> = [
    { id: "settings", label: t("admin.printer.tab.settings") },
    { id: "diagnostics", label: t("admin.printer.tab.diagnostics") },
  ];

  return (
    <AdminPanel
      title={t("admin.sidebar.printer")}
      description={t("admin.printer.description")}
      data-testid="printing-management"
    >
      <div
        role="tablist"
        aria-label={t("admin.printer.tabs")}
        className="bg-muted flex w-fit gap-1 rounded-lg border p-1"
      >
        {tabs.map((entry) => (
          <Button
            key={entry.id}
            type="button"
            role="tab"
            variant={tab === entry.id ? "default" : "ghost"}
            aria-selected={tab === entry.id}
            data-testid={`printing-tab-${entry.id}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </Button>
        ))}
      </div>
      <div role="tabpanel" aria-label={tabs.find((entry) => entry.id === tab)?.label}>
        {tab === "settings" ? <PrinterSettingsTab /> : <PrinterDiagnosticsTab />}
      </div>
    </AdminPanel>
  );
}
