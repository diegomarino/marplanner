/** Printer settings (FR-017): plugin and auto-print state, paper width, and the Bluetooth printer
 * this household uses. Reads/writes the existing `printer` and `printerTransport` settings objects
 * one object per PUT. Pairing (shared printer session) fills the printer fields; Save persists
 * them. Auto-print belongs to Daily Briefing (Printing FR-006): shown read-only with a link. */
import { useCallback, useEffect, useRef, useState } from "react";

import { ErrorNotice } from "@/components/ErrorNotice";
import { Field } from "@/components/Field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/i18n";
import { LocalizedApiError, responseMessage } from "@/lib/api-error";
import { appUrl } from "@/lib/base-path";
import { authFetch } from "@/lib/credential";
import { usePluginActive } from "@/plugins/contributions";
import { usePrinterSession } from "@/printing/PrinterSession";
import { navigateHousehold } from "@/shell/routes";
import type { EffectiveSettings, PrinterTransportSettings } from "../../../shared";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMPTY_TRANSPORT: PrinterTransportSettings = {
  deviceId: "",
  name: "",
  serviceUuid: "",
  characteristicUuid: "",
};
const DEFAULT_PAPER_WIDTH = 576;

/** Mirrors the server's `printerTransport` rule (settings/index.ts): all four empty, or a named
 * device with two RFC-4122 (version 1-5) UUIDs. */
export function isTransportValid(transport: PrinterTransportSettings): boolean {
  const { deviceId, name, serviceUuid, characteristicUuid } = transport;
  if ([deviceId, name, serviceUuid, characteristicUuid].every((value) => value.length === 0)) {
    return true;
  }
  return (
    deviceId.trim().length > 0 &&
    name.trim().length > 0 &&
    UUID_PATTERN.test(serviceUuid) &&
    UUID_PATTERN.test(characteristicUuid)
  );
}

/** A whole number of dots greater than zero, or null. */
export function parsePaperWidth(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function sameTransport(a: PrinterTransportSettings, b: PrinterTransportSettings): boolean {
  return (
    a.deviceId === b.deviceId &&
    a.name === b.name &&
    a.serviceUuid === b.serviceUuid &&
    a.characteristicUuid === b.characteristicUuid
  );
}

/** An in-app admin link (the `PluginUnavailable` pattern; `navigateAdmin` would be an import cycle). */
function AdminLink({
  path,
  testId,
  children,
}: {
  path: "/admin/plugins" | "/admin/daily-briefing";
  testId: string;
  children: string;
}) {
  return (
    <Button asChild variant="outline" className="w-fit">
      <a
        href={appUrl(path)}
        data-testid={testId}
        onClick={(event) => {
          event.preventDefault();
          navigateHousehold(path);
        }}
      >
        {children}
      </a>
    </Button>
  );
}

function AutoPrintLine() {
  const t = useT();
  const [state, setState] = useState<"loading" | "on" | "off" | "error">("loading");

  const load = useCallback(() => {
    authFetch("/api/daily-briefing/settings", { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`briefing settings: ${response.status}`);
        const data = (await response.json()) as { autoPrintTrigger: "morning_complete" | null };
        setState(data.autoPrintTrigger === "morning_complete" ? "on" : "off");
      })
      .catch(() => setState("error"));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="font-medium">{t("admin.printer.autoPrint.title")}</span>
      {state === "error" ? (
        <>
          <ErrorNotice
            message={t("admin.printer.autoPrint.loadError")}
            data-testid="printer-autoprint-error"
            politeness="polite"
          />
          <Button
            type="button"
            variant="outline"
            data-testid="printer-autoprint-retry"
            onClick={() => {
              setState("loading");
              load();
            }}
          >
            {t("admin.printer.retry")}
          </Button>
        </>
      ) : state === "loading" ? null : (
        <span data-testid="printer-autoprint-state">
          {t(state === "on" ? "admin.printer.autoPrint.on" : "admin.printer.autoPrint.off")}
        </span>
      )}
      <AdminLink path="/admin/daily-briefing" testId="printer-autoprint-link">
        {t("admin.printer.autoPrint.manage")}
      </AdminLink>
    </div>
  );
}

export function PrinterSettingsTab(): React.JSX.Element {
  const t = useT();
  const session = usePrinterSession();
  const briefingActive = usePluginActive("daily-briefing");
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [reloadToken, setReloadToken] = useState(0);
  const [paperWidth, setPaperWidth] = useState("");
  const [transport, setTransport] = useState<PrinterTransportSettings>(EMPTY_TRANSPORT);
  const [baseline, setBaseline] = useState<{
    paperWidthDots: number;
    transport: PrinterTransportSettings;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pairedUnsaved, setPairedUnsaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function apply(settings: EffectiveSettings): void {
    const paperWidthDots = settings.printer?.paperWidthDots ?? DEFAULT_PAPER_WIDTH;
    const nextTransport = settings.printerTransport ?? EMPTY_TRANSPORT;
    setPaperWidth(String(paperWidthDots));
    setTransport(nextTransport);
    setBaseline({ paperWidthDots, transport: nextTransport });
  }

  useEffect(() => {
    let cancelled = false;
    authFetch("/api/settings", { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`settings: ${response.status}`);
        const data = (await response.json()) as EffectiveSettings;
        if (cancelled) return;
        apply(data);
        setLoadState("ready");
      })
      .catch(() => {
        if (!cancelled) setLoadState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  // A pairing that completes while this tab is open fills the printer fields (never on mount:
  // a session paired earlier must not overwrite what is stored).
  const pairedDevice = session?.pairedDevice ?? null;
  const seenPairedDevice = useRef(pairedDevice);
  useEffect(() => {
    if (!pairedDevice || pairedDevice === seenPairedDevice.current) return;
    seenPairedDevice.current = pairedDevice;
    const fallbackName = t("admin.printer.defaultName");
    setTransport((current) => ({
      deviceId: pairedDevice.deviceId,
      serviceUuid: pairedDevice.serviceUuid,
      characteristicUuid: pairedDevice.characteristicUuid,
      name:
        current.deviceId === pairedDevice.deviceId && current.name.trim()
          ? current.name
          : pairedDevice.name.trim() || fallbackName,
    }));
    setPairedUnsaved(true);
    setSaved(false);
  }, [pairedDevice, t]);

  const width = parsePaperWidth(paperWidth);
  const transportValid = isTransportValid(transport);
  const widthChanged = baseline !== null && width !== null && width !== baseline.paperWidthDots;
  const transportChanged = baseline !== null && !sameTransport(transport, baseline.transport);
  const canSave = !saving && width !== null && transportValid && (widthChanged || transportChanged);

  function editTransport(patch: Partial<PrinterTransportSettings>): void {
    setTransport((current) => ({ ...current, ...patch }));
    setSaved(false);
  }

  async function put(object: "printer" | "printerTransport", settings: unknown) {
    const response = await authFetch("/api/settings", {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ object, settings }),
    });
    if (!response.ok) {
      throw new LocalizedApiError(await responseMessage(response, t("admin.printer.saveError")));
    }
    return (await response.json()) as EffectiveSettings;
  }

  async function save(): Promise<void> {
    if (!canSave || width === null || baseline === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (widthChanged) {
        const afterWidth = await put("printer", { paperWidthDots: width });
        const savedWidth = afterWidth.printer?.paperWidthDots ?? width;
        setBaseline((current) => (current ? { ...current, paperWidthDots: savedWidth } : current));
        setPaperWidth(String(savedWidth));
      }
      if (transportChanged) {
        const afterTransport = await put("printerTransport", transport);
        const savedTransport = afterTransport.printerTransport ?? transport;
        setBaseline((current) => (current ? { ...current, transport: savedTransport } : current));
        setTransport(savedTransport);
      }
      setSaved(true);
      setPairedUnsaved(false);
    } catch (cause) {
      setSaveError(
        cause instanceof LocalizedApiError ? cause.message : t("admin.printer.saveError")
      );
    } finally {
      setSaving(false);
    }
  }

  if (loadState === "loading") {
    return (
      <p className="text-muted-foreground text-sm" data-testid="printer-settings">
        {t("admin.printer.settings.loading")}
      </p>
    );
  }
  if (loadState === "error") {
    return (
      <div className="flex flex-col items-start gap-3" data-testid="printer-settings">
        <ErrorNotice
          message={t("admin.printer.settings.loadError")}
          data-testid="printer-settings-error"
        />
        <Button
          type="button"
          variant="outline"
          data-testid="printer-settings-retry"
          onClick={() => {
            setLoadState("loading");
            setReloadToken((token) => token + 1);
          }}
        >
          {t("admin.printer.retry")}
        </Button>
      </div>
    );
  }

  const connected =
    session !== null &&
    pairedDevice !== null &&
    (session.displayState === "paired" ||
      session.displayState === "printing" ||
      session.displayState === "error");
  const statusText =
    connected && pairedDevice
      ? t("admin.printer.connectedTo").replace("{name}", pairedDevice.name || pairedDevice.deviceId)
      : t(session?.stateLabelKey ?? "printing.executor.state.unpaired");
  const pluginActive = session?.active ?? true;

  return (
    <div className="flex flex-col gap-6" data-testid="printer-settings">
      <section className="bg-card flex flex-col gap-3 rounded-lg p-4 shadow">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-medium">{t("admin.printer.plugin.title")}</span>
          <span data-testid="printer-plugin-state">
            {t(pluginActive ? "plugins.state.active" : "plugins.state.inactive")}
          </span>
          <AdminLink path="/admin/plugins" testId="printer-plugin-link">
            {t("admin.printer.plugin.manage")}
          </AdminLink>
        </div>
        {briefingActive && <AutoPrintLine />}
      </section>

      <section className="bg-card flex flex-col gap-4 rounded-lg p-4 shadow">
        <Field
          label={t("admin.printer.paperWidth")}
          hint={t("admin.printer.paperWidth.hint")}
          error={width === null ? t("admin.printer.paperWidth.invalid") : null}
        >
          <Input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            className="w-40"
            data-testid="printer-paper-width"
            value={paperWidth}
            onChange={(event) => {
              setPaperWidth(event.target.value);
              setSaved(false);
            }}
          />
        </Field>
      </section>

      <section className="bg-card flex flex-col gap-4 rounded-lg p-4 shadow">
        <div className="flex flex-col gap-1">
          <h3 className="text-lg font-semibold">{t("admin.printer.bluetooth.title")}</h3>
          <p className="text-muted-foreground text-sm">
            {t("admin.printer.bluetooth.description")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-medium">{t("admin.printer.connection")}</span>
          <span data-testid="printer-connection-status" role="status" aria-live="polite">
            {statusText}
          </span>
          {session?.canPair && (
            <Button
              type="button"
              variant="outline"
              data-testid="printing-management-pair"
              onClick={() =>
                session.pair({
                  serviceUuid: transport.serviceUuid || undefined,
                  characteristicUuid: transport.characteristicUuid || undefined,
                })
              }
            >
              {t(
                session.displayState === "disconnected"
                  ? "printing.executor.repairButton"
                  : "printing.executor.pairButton"
              )}
            </Button>
          )}
        </div>
        {pairedUnsaved && (
          <p className="text-sm" data-testid="printer-paired-unsaved" role="status">
            {t("admin.printer.pairedUnsaved")}
          </p>
        )}
        <Field label={t("admin.printer.name")}>
          <Input
            data-testid="printer-name"
            value={transport.name}
            onChange={(event) => editTransport({ name: event.target.value })}
          />
        </Field>
        <Field label={t("admin.printer.deviceId")}>
          <Input data-testid="printer-device-id" value={transport.deviceId} readOnly />
        </Field>
        <details data-testid="printer-advanced">
          <summary className="cursor-pointer font-semibold">{t("admin.printer.advanced")}</summary>
          <div className="mt-3 flex flex-col gap-3">
            <Field label={t("admin.printer.serviceUuid")}>
              <Input
                className="font-mono"
                data-testid="printer-service-uuid"
                value={transport.serviceUuid}
                onChange={(event) => editTransport({ serviceUuid: event.target.value.trim() })}
              />
            </Field>
            <Field label={t("admin.printer.characteristicUuid")}>
              <Input
                className="font-mono"
                data-testid="printer-characteristic-uuid"
                value={transport.characteristicUuid}
                onChange={(event) =>
                  editTransport({ characteristicUuid: event.target.value.trim() })
                }
              />
            </Field>
          </div>
        </details>
        {!transportValid && (
          <ErrorNotice
            message={t("admin.printer.transport.invalid")}
            data-testid="printer-transport-error"
            politeness="polite"
          />
        )}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          data-testid="printer-settings-save"
          disabled={!canSave}
          onClick={() => void save()}
        >
          {saving ? t("admin.printer.saving") : t("admin.printer.save")}
        </Button>
        {saved && (
          <p
            className="text-muted-foreground text-sm"
            data-testid="printer-settings-saved"
            role="status"
          >
            {t("admin.printer.saved")}
          </p>
        )}
      </div>
      <ErrorNotice message={saveError} data-testid="printer-settings-save-error" />
    </div>
  );
}
