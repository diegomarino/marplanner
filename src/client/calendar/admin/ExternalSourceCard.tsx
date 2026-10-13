import { PillToggle } from "@/components/PillToggle";
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
      className="bg-card flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border px-4 py-3 shadow-sm"
      data-testid={`external-source-${source.id}`}
    >
      <div className="min-w-0 flex-1 basis-56">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="min-w-0 truncate font-medium">{source.name}</h3>
          <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-xs font-medium">
            {t(providerKeys[source.provider] ?? providerKeys.ics_generic)}
          </span>
        </div>
        <p className="text-muted-foreground flex min-w-0 flex-wrap gap-x-2 text-sm">
          <span className="min-w-0 truncate">{source.maskedUrl}</span>
          {source.lastSuccessAt !== null && (
            <span className="shrink-0 whitespace-nowrap">
              {t("calendar.admin.lastSuccess")}{" "}
              {new Intl.DateTimeFormat(language === "es" ? "es-ES" : "en-GB", {
                dateStyle: "medium",
                timeStyle: "short",
                timeZone: timezone ?? "UTC",
              }).format(source.lastSuccessAt)}
            </span>
          )}
        </p>
        {source.phase && (
          <p role="status" className="text-sm">
            {t(phaseKeys[source.phase])}
          </p>
        )}
        {errorKey && <ErrorNotice message={t(errorKey)} />}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <PillToggle
          checked={source.enabled}
          disabled={busy}
          onChange={(checked) => onToggle(source.id, checked)}
          label={t("calendar.admin.enabled")}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={t("calendar.admin.syncNow")}
          title={t("calendar.admin.syncNow")}
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
          title={t("calendar.admin.deleteSource")}
          disabled={busy}
          onClick={() => setConfirmOpen(true)}
        >
          <Trash2 aria-hidden="true" className="size-4" />
        </Button>
      </div>
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
