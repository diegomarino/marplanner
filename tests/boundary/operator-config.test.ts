import { describe, it, expect, afterEach, vi } from "vitest";
import { getOperatorConfig } from "../../src/server/host-api";

/** Operator-config accessor:
 * PLUGIN-SYSTEM-INV-09). Set/unset env behavior, absent-safety for unrecognized keys, and
 * the never-log guarantee (a resolved value must never reach console output).
 */
describe("getOperatorConfig", () => {
  const ORIGINAL_ENDPOINT = process.env.WEATHER_ENDPOINT;
  const ORIGINAL_ENABLED = process.env.WEATHER_ENABLED;

  afterEach(() => {
    if (ORIGINAL_ENDPOINT === undefined) delete process.env.WEATHER_ENDPOINT;
    else process.env.WEATHER_ENDPOINT = ORIGINAL_ENDPOINT;
    if (ORIGINAL_ENABLED === undefined) delete process.env.WEATHER_ENABLED;
    else process.env.WEATHER_ENABLED = ORIGINAL_ENABLED;
  });

  it("returns undefined when the underlying env var is unset", () => {
    delete process.env.WEATHER_ENDPOINT;
    expect(getOperatorConfig("weather.endpoint")).toBeUndefined();
  });

  it("resolves 'weather.endpoint' to WEATHER_ENDPOINT", () => {
    process.env.WEATHER_ENDPOINT = "https://proxy.example.internal";
    expect(getOperatorConfig("weather.endpoint")).toBe("https://proxy.example.internal");
  });

  it("resolves 'weather.enabled' to WEATHER_ENABLED", () => {
    process.env.WEATHER_ENABLED = "false";
    expect(getOperatorConfig("weather.enabled")).toBe("false");

    process.env.WEATHER_ENABLED = "true";
    expect(getOperatorConfig("weather.enabled")).toBe("true");
  });

  it("an unrecognized key returns undefined and never throws (absent-safe)", () => {
    expect(() => getOperatorConfig("bogus.key")).not.toThrow();
    expect(getOperatorConfig("bogus.key")).toBeUndefined();
    expect(() => getOperatorConfig("")).not.toThrow();
    expect(getOperatorConfig("")).toBeUndefined();
  });

  it("never logs the resolved value to any console method", () => {
    process.env.WEATHER_ENDPOINT = "https://secret-proxy.example.internal";
    const methods = ["log", "warn", "error", "info", "debug"] as const;
    const spies = methods.map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      const value = getOperatorConfig("weather.endpoint");
      expect(value).toBe("https://secret-proxy.example.internal");
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
