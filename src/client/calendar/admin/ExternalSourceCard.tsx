import { useState } from "react";
import { RefreshCcw, Trash2 } from "lucide-react";
import type { ExternalSourcePublic, SynchronizationPhase } from "../../../shared";
import { useTranslation } from "@/i18n";
import { useHouseholdSettings } from "@/lib/householdSettings";
import type { MessageKey } from "@/i18n/messages";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorNotice } from "@/components/ErrorNotice";

const providerKeys = {
  ics_generic: "calendar.admin.providerGeneric",
  google: "calendar.admin.providerGoogle",
  microsoft: "calendar.admin.providerMicrosoft",
  apple: "calendar.admin.providerApple",
} as const satisfies Record<ExternalSourcePublic["provider"], MessageKey>;

const phaseKeys: Record<SynchronizationPhase, MessageKey> = {
  requesting: "calendar.admin.phase.requesting",
  downloading: "calendar.admin.phase.downloading",
  parsing: "calendar.admin.phase.parsing",
  reconciling: "calendar.admin.phase.reconciling",
  succeeded: "calendar.admin.phase.succeeded",
  failed: "calendar.admin.phase.failed",
};

const errorKeys: Record<NonNullable<ExternalSourcePublic["lastErrorCode"]>, MessageKey> = {
  unsafe_url: "calendar.admin.error.unsafeUrl",
  unavailable: "calendar.admin.error.unavailable",
  timeout: "calendar.admin.error.timeout",
  too_large: "calendar.admin.error.tooLarge",
  invalid_calendar: "calendar.admin.error.invalidCalendar",
  parse_failed: "calendar.admin.error.parseFailed",
  reconcile_failed: "calendar.admin.error.reconcileFailed",
};

export function ExternalSourceCard({
  source,
  busy,
  onToggle,
  onSync,
  onDelete,
}: {
  source: ExternalSourcePublic;
  busy: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onSync: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { t, language } = useTranslation();
  const { timezone } = useHouseholdSettings();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const active = ["requesting", "downloading", "parsing", "reconciling"].includes(
    source.phase ?? ""
  );
  const errorKey = source.lastErrorCode && errorKeys[source.lastErrorCode];

  return (
    <article
      className="space-y-3 rounded-2xl border bg-card p-4 shadow-sm"
      data-testid={`external-source-${source.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium">{source.name}</h3>
          <p className="truncate text-sm text-muted-foreground">{source.maskedUrl}</p>
          <p className="text-sm text-muted-foreground">
            {t(providerKeys[source.provider] ?? providerKeys.ics_generic)}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={t("calendar.admin.syncNow")}
            disabled={!source.enabled || busy || active}
            onClick={() => onSync(source.id)}
          >
            <RefreshCcw aria-hidden="true" className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("calendar.admin.deleteSource")}
            disabled={busy}
            onClick={() => setConfirmOpen(true)}
          >
            <Trash2 aria-hidden="true" className="size-4" />
          </Button>
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={source.enabled}
          disabled={busy}
          onChange={(event) => onToggle(source.id, event.target.checked)}
        />
        {t("calendar.admin.enabled")}
      </label>
      {source.phase && (
        <p role="status" className="text-sm">
          {t(phaseKeys[source.phase])}
        </p>
      )}
      {errorKey && <ErrorNotice message={t(errorKey)} />}
      {source.lastSuccessAt !== null && (
        <p className="text-sm text-muted-foreground">
          {t("calendar.admin.lastSuccess")}{" "}
          {new Intl.DateTimeFormat(language === "es" ? "es-ES" : "en-GB", {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: timezone ?? "UTC",
          }).format(source.lastSuccessAt)}
        </p>
      )}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("calendar.admin.deleteConfirm").replace("{name}", source.name)}
        description={t("calendar.admin.deleteDescription")}
        confirmLabel={t("calendar.admin.delete")}
        cancelLabel={t("calendar.admin.cancel")}
        onConfirm={() => onDelete(source.id)}
      />
    </article>
  );
}
