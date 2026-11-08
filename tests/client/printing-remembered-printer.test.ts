import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadRememberedPrinter,
  REMEMBERED_PRINTER_KEY,
  saveRememberedPrinter,
} from "@/printing/rememberedPrinter";

const identity = {
  deviceId: "dev-1",
  name: "Thermal X",
  serviceUuid: "49535343-fe7d-4ae5-8fa9-9fafd205e455",
  characteristicUuid: "49535343-8841-43f4-a8d4-ecbe34729bb3",
};

describe("rememberedPrinter", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("round-trips a saved identity", () => {
    saveRememberedPrinter(identity);
    expect(loadRememberedPrinter()).toEqual(identity);
  });

  it("remembers nothing for an identity without a device id", () => {
    saveRememberedPrinter({ ...identity, deviceId: "" });
    expect(window.localStorage.getItem(REMEMBERED_PRINTER_KEY)).toBeNull();
    expect(loadRememberedPrinter()).toBeNull();
  });

  it("treats malformed or incomplete entries as nothing remembered", () => {
    window.localStorage.setItem(REMEMBERED_PRINTER_KEY, "{not json");
    expect(loadRememberedPrinter()).toBeNull();
    window.localStorage.setItem(REMEMBERED_PRINTER_KEY, JSON.stringify({ deviceId: "dev-1" }));
    expect(loadRememberedPrinter()).toBeNull();
    window.localStorage.setItem(REMEMBERED_PRINTER_KEY, "null");
    expect(loadRememberedPrinter()).toBeNull();
  });

  it("degrades to nothing remembered when storage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("disabled");
    });
    expect(() => saveRememberedPrinter(identity)).not.toThrow();
    expect(loadRememberedPrinter()).toBeNull();
  });
});
