import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/i18n";
import {
  PrinterSettingsTab,
  isTransportValid,
  parsePaperWidth,
} from "@/admin/printer/PrinterSettingsTab";
import { PrinterSessionProvider, usePrinterSession } from "@/printing/PrinterSession";
import { createFakePrintTransport, FAKE_PRINTER_IDENTITY } from "@/printing/transport";
import { json, stubFetchRoutes, type RouteHandler } from "./helpers/fetchRoutes";

vi.mock("@/lib/householdSettings", () => ({
  useHouseholdSettingsContext: () => ({
    timezone: "Europe/Madrid",
    language: "en",
    weekStartDay: 1,
    weatherLat: null,
    weatherLon: null,
    weatherLabel: null,
  }),
}));
vi.mock("@/printing/pluginStatus", () => ({ usePrintingPluginActive: () => true }));

const EMPTY = { deviceId: "", name: "", serviceUuid: "", characteristicUuid: "" };
const KITCHEN = {
  deviceId: "dev-kitchen",
  name: "Kitchen",
  serviceUuid: "000018f0-0000-1000-8000-00805f9b34fb",
  characteristicUuid: "00002af1-0000-1000-8000-00805f9b34fb",
};

function settings(printerTransport = EMPTY, paperWidthDots = 576) {
  return {
    locale: { timezone: "Europe/Madrid", language: "en", weekStartDay: 1 },
    printer: { paperWidthDots },
    printerTransport,
  };
}

async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function baseRoutes(extra: Record<string, RouteHandler> = {}) {
  return stubFetchRoutes({
    "GET /api/settings": () => json(settings()),
    "GET /api/daily-briefing/settings": () => json({ autoPrintTrigger: "morning_complete" }),
    "POST /api/printing/capability": () => json({ registered: true }),
    "POST /api/printing/claim": () => new Response(null, { status: 204 }),
    ...extra,
  });
}

function renderTab(withSession = false) {
  const tab = <PrinterSettingsTab />;
  return render(
    <LanguageProvider>
      {withSession ? (
        <PrinterSessionProvider transport={createFakePrintTransport()} pollIntervalMs={60_000}>
          {tab}
        </PrinterSessionProvider>
      ) : (
        tab
      )}
    </LanguageProvider>
  );
}

function putBodies(mock: ReturnType<typeof stubFetchRoutes>) {
  return mock.mock.calls
    .filter(([, init]) => init?.method === "PUT")
    .map(([, init]) => JSON.parse(String(init?.body)));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("printer settings helpers", () => {
  it("parsePaperWidth accepts whole numbers > 0 only", () => {
    expect(parsePaperWidth("576")).toBe(576);
    expect(parsePaperWidth(" 384 ")).toBe(384);
    for (const raw of ["", "0", "-1", "1.5", "abc"]) expect(parsePaperWidth(raw)).toBeNull();
  });

  it("isTransportValid mirrors the server rule", () => {
    expect(isTransportValid(EMPTY)).toBe(true);
    expect(isTransportValid(KITCHEN)).toBe(true);
    expect(isTransportValid({ ...EMPTY, name: "Kitchen" })).toBe(false);
    // any well-formed 128-bit UUID is accepted, whatever its version nibble (vendor GATT ids)
    expect(
      isTransportValid({ ...KITCHEN, serviceUuid: "49535343-fe7d-fae5-8fa9-9fafd205e455" })
    ).toBe(true);
    // a malformed UUID is rejected, like the server does
    expect(isTransportValid({ ...KITCHEN, serviceUuid: "49535343-fe7d-4ae5-8fa9" })).toBe(false);
  });
});

describe("PrinterSettingsTab", () => {
  it("shows plugin state, auto-print state, paper width and the stored printer", async () => {
    baseRoutes({ "GET /api/settings": () => json(settings(KITCHEN, 576)) });
    renderTab();
    await flush();
    expect(screen.getByTestId("printer-plugin-state")).toHaveTextContent("Active");
    expect(screen.getByTestId("printer-autoprint-state")).toHaveTextContent("On");
    expect(screen.getByTestId("printer-paper-width")).toHaveValue(576);
    expect(screen.getByTestId("printer-name")).toHaveValue("Kitchen");
    expect(screen.getByTestId("printer-device-id")).toHaveValue("dev-kitchen");
    expect(screen.getByTestId("printer-device-id")).toHaveAttribute("readonly");
    expect(screen.getByTestId("printer-service-uuid")).toHaveValue(KITCHEN.serviceUuid);
    expect(screen.getByTestId("printer-settings-save")).toBeDisabled(); // nothing changed
  });

  it("offers Retry when the settings cannot be loaded", async () => {
    let fail = true;
    baseRoutes({
      "GET /api/settings": () => (fail ? json({ error: "x" }, 500) : json(settings())),
    });
    renderTab();
    await flush();
    expect(screen.getByTestId("printer-settings-error")).toHaveTextContent(
      "The printer settings could not be loaded."
    );
    fail = false;
    fireEvent.click(screen.getByTestId("printer-settings-retry"));
    await flush();
    expect(screen.getByTestId("printer-paper-width")).toBeInTheDocument();
  });

  it("auto-print read failure shows its own Retry and does not block the form", async () => {
    let fail = true;
    baseRoutes({
      "GET /api/daily-briefing/settings": () =>
        fail ? json({ error: "x" }, 500) : json({ autoPrintTrigger: null }),
    });
    renderTab();
    await flush();
    expect(screen.getByTestId("printer-autoprint-error")).toBeInTheDocument();
    expect(screen.getByTestId("printer-paper-width")).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByTestId("printer-autoprint-retry"));
    await flush();
    expect(screen.getByTestId("printer-autoprint-state")).toHaveTextContent("Off");
  });

  it("saves only the changed object and shows Saved", async () => {
    const mock = baseRoutes({ "PUT /api/settings": () => json(settings(EMPTY, 384)) });
    renderTab();
    await flush();
    fireEvent.change(screen.getByTestId("printer-paper-width"), { target: { value: "384" } });
    fireEvent.click(screen.getByTestId("printer-settings-save"));
    await flush();
    expect(putBodies(mock)).toEqual([{ object: "printer", settings: { paperWidthDots: 384 } }]);
    expect(screen.getByTestId("printer-settings-saved")).toHaveTextContent("Saved.");
  });

  it("blocks Save on an invalid width or a half-filled printer", async () => {
    baseRoutes();
    renderTab();
    await flush();
    fireEvent.change(screen.getByTestId("printer-paper-width"), { target: { value: "0" } });
    expect(screen.getByText("Enter a whole number greater than 0.")).toBeInTheDocument();
    expect(screen.getByTestId("printer-settings-save")).toBeDisabled();
    fireEvent.change(screen.getByTestId("printer-paper-width"), { target: { value: "576" } });
    fireEvent.change(screen.getByTestId("printer-name"), { target: { value: "Kitchen" } });
    expect(screen.getByTestId("printer-transport-error")).toBeInTheDocument();
    expect(screen.getByTestId("printer-settings-save")).toBeDisabled();
  });

  it("keeps the edits and shows the error when the transport save fails after the width saved", async () => {
    const mock = baseRoutes({
      "GET /api/settings": () => json(settings(KITCHEN)),
      "PUT /api/settings": (init) =>
        JSON.parse(String(init?.body)).object === "printer"
          ? json(settings(KITCHEN, 384))
          : json({ error: "invalid_settings" }, 400),
    });
    renderTab();
    await flush();
    fireEvent.change(screen.getByTestId("printer-paper-width"), { target: { value: "384" } });
    fireEvent.change(screen.getByTestId("printer-name"), { target: { value: "Hall" } });
    fireEvent.click(screen.getByTestId("printer-settings-save"));
    await flush();
    expect(putBodies(mock).map((body) => body.object)).toEqual(["printer", "printerTransport"]);
    expect(screen.getByTestId("printer-settings-save-error")).toHaveTextContent(
      "The printer settings could not be saved."
    );
    expect(screen.getByTestId("printer-name")).toHaveValue("Hall");
  });

  it("pairing fills the printer fields, keeps an unsaved width edit, and Save persists them", async () => {
    const mock = baseRoutes({
      "PUT /api/settings": (init) => {
        const body = JSON.parse(String(init?.body));
        return json(
          body.object === "printer"
            ? settings(EMPTY, body.settings.paperWidthDots)
            : settings(body.settings, 384)
        );
      },
    });
    renderTab(true);
    await flush();
    expect(screen.getByTestId("printer-connection-status")).toHaveTextContent("Not paired");
    fireEvent.change(screen.getByTestId("printer-paper-width"), { target: { value: "384" } });
    fireEvent.click(screen.getByTestId("printing-management-pair"));
    await flush();

    expect(screen.getByTestId("printer-device-id")).toHaveValue(FAKE_PRINTER_IDENTITY.deviceId);
    expect(screen.getByTestId("printer-name")).toHaveValue(FAKE_PRINTER_IDENTITY.name);
    expect(screen.getByTestId("printer-paper-width")).toHaveValue(384);
    expect(screen.getByTestId("printer-paired-unsaved")).toBeInTheDocument();
    expect(screen.getByTestId("printer-connection-status")).toHaveTextContent(
      `Connected to ${FAKE_PRINTER_IDENTITY.name}`
    );

    fireEvent.click(screen.getByTestId("printer-settings-save"));
    await flush();
    expect(putBodies(mock)).toEqual([
      { object: "printer", settings: { paperWidthDots: 384 } },
      { object: "printerTransport", settings: FAKE_PRINTER_IDENTITY },
    ]);
    expect(screen.queryByTestId("printer-paired-unsaved")).not.toBeInTheDocument();
  });

  it("passes the stored UUIDs as the pairing preference", async () => {
    baseRoutes({ "GET /api/settings": () => json(settings(KITCHEN)) });
    const transport = createFakePrintTransport();
    const pairSpy = vi.spyOn(transport, "pair");
    render(
      <LanguageProvider>
        <PrinterSessionProvider transport={transport} pollIntervalMs={60_000}>
          <PrinterSettingsTab />
        </PrinterSessionProvider>
      </LanguageProvider>
    );
    await flush();
    fireEvent.click(screen.getByTestId("printing-management-pair"));
    await flush();
    expect(pairSpy).toHaveBeenCalledWith({
      serviceUuid: KITCHEN.serviceUuid,
      characteristicUuid: KITCHEN.characteristicUuid,
    });
    // a different device id: the device's own name replaces the stored one
    expect(screen.getByTestId("printer-name")).toHaveValue(FAKE_PRINTER_IDENTITY.name);
  });

  it("a pairing that completes while the settings are still loading is not overwritten", async () => {
    let releaseSettings: (() => void) | undefined;
    baseRoutes({
      "GET /api/settings": () =>
        new Promise<Response>((resolve) => {
          releaseSettings = () => resolve(json(settings(KITCHEN)));
        }),
    });
    function PairElsewhere() {
      const session = usePrinterSession();
      return (
        <button type="button" data-testid="pair-elsewhere" onClick={() => session?.pair()}>
          pair
        </button>
      );
    }
    render(
      <LanguageProvider>
        <PrinterSessionProvider transport={createFakePrintTransport()} pollIntervalMs={60_000}>
          <PairElsewhere />
          <PrinterSettingsTab />
        </PrinterSessionProvider>
      </LanguageProvider>
    );
    await flush();
    fireEvent.click(screen.getByTestId("pair-elsewhere"));
    await flush();
    releaseSettings?.();
    await flush();

    expect(screen.getByTestId("printer-device-id")).toHaveValue(FAKE_PRINTER_IDENTITY.deviceId);
    expect(screen.getByTestId("printer-paired-unsaved")).toBeInTheDocument();
    expect(screen.getByTestId("printer-settings-save")).not.toBeDisabled();
  });
});
