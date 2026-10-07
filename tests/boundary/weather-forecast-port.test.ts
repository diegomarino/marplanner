import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";
import {
  healthyRawForecast,
  malformedRawForecast,
  missingDailyRawForecast,
  missingHourlyRawForecast,
  quarterHourCurrentRawForecast,
  unknownConditionCodeRawForecast,
} from "../helpers/weather-fixtures";

/** docs/features/weather.md — forecast port boundary tests (* FR-011/012/013/015/021). BLACK-BOX against `buildForecastPort`/`createOpenMeteoPort` with a
 * stubbed global `fetch` — no real egress, ever (D4).
 */
describe("weather forecast port", () => {
  useIsolatedDb();

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function clientLogRows(): Array<{
    component: string;
    message: string;
    level: string;
    data: string | null;
  }> {
    return getDb()
      .prepare("SELECT component, message, level, data FROM client_log")
      .all() as Array<{ component: string; message: string; level: string; data: string | null }>;
  }

  describe("createOpenMeteoPort — test-flag throw (research D4)", () => {
    it("throws immediately when constructed under the test runtime, never falling through to a real fetch", async () => {
      const { createOpenMeteoPort } = await import("../../src/server/modules/weather/port");
      expect(() => createOpenMeteoPort()).toThrow(/test runtime/i);
    });
  });

  describe("buildForecastPort — operator kill-switch", () => {
    it("weather.enabled === 'false' -> null-port with ZERO fetch calls", async () => {
      const { buildForecastPort } = await import("../../src/server/modules/weather/port");
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const port = buildForecastPort({ endpoint: undefined, enabled: "false" });
      const result = await port({ lat: 40.4, lon: -3.7 }, "Europe/Madrid");

      expect(result).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(clientLogRows()).toHaveLength(0);
    });
  });

  describe("buildForecastPort — invalid operator endpoint (Codex review on #656, P2)", () => {
    it("a non-empty but INVALID WEATHER_ENDPOINT -> null + exactly one telemetry row, never a throw/500", async () => {
      const { buildForecastPort } = await import("../../src/server/modules/weather/port");
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const port = buildForecastPort({ endpoint: "not a url", enabled: undefined });
      const result = await port({ lat: 40.4, lon: -3.7 }, "Europe/Madrid");

      expect(result).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
      const rows = clientLogRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].message).toBe("forecast_fetch_failed");
      const data = JSON.parse(rows[0].data!);
      expect(data.reason).toBe("invalid_endpoint");
    });
  });

  describe("buildForecastPort — request shape", () => {
    it("carries the household timezone explicitly, never 'auto', plus lat/lon", async () => {
      const { buildForecastPort } = await import("../../src/server/modules/weather/port");
      let capturedUrl: URL | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn((url: URL) => {
          capturedUrl = url;
          return Promise.resolve(
            new Response(JSON.stringify(healthyRawForecast()), { status: 200 })
          );
        })
      );

      const port = buildForecastPort({ endpoint: "https://fixture.example", enabled: undefined });
      await port({ lat: 40.4, lon: -3.7 }, "Pacific/Auckland");

      expect(capturedUrl).toBeDefined();
      expect(capturedUrl!.searchParams.get("timezone")).toBe("Pacific/Auckland");
      expect(capturedUrl!.searchParams.get("timezone")).not.toBe("auto");
      expect(capturedUrl!.searchParams.get("latitude")).toBe("40.4");
      expect(capturedUrl!.searchParams.get("longitude")).toBe("-3.7");
      // The fixed variable-selector constants — without them the provider
      // returns no weather fields (649-review class finding).
      expect(capturedUrl!.searchParams.get("current")).toContain("weather_code");
      expect(capturedUrl!.searchParams.get("hourly")).toContain("precipitation_probability");
      expect(capturedUrl!.searchParams.get("daily")).toContain("precipitation_probability_max");
    });

    it("defaults the base URL to https://api.open-meteo.com when no operator endpoint is set", async () => {
      const { buildForecastPort } = await import("../../src/server/modules/weather/port");
      let capturedUrl: URL | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn((url: URL) => {
          capturedUrl = url;
          return Promise.resolve(
            new Response(JSON.stringify(healthyRawForecast()), { status: 200 })
          );
        })
      );

      const port = buildForecastPort({ endpoint: undefined, enabled: undefined });
      await port({ lat: 0, lon: 0 }, "UTC");

      expect(capturedUrl!.origin).toBe("https://api.open-meteo.com");
    });

    it("honors an operator-overridden endpoint (WEATHER_ENDPOINT)", async () => {
      const { buildForecastPort } = await import("../../src/server/modules/weather/port");
      let capturedUrl: URL | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn((url: URL) => {
          capturedUrl = url;
          return Promise.resolve(
            new Response(JSON.stringify(healthyRawForecast()), { status: 200 })
          );
        })
      );

      const port = buildForecastPort({ endpoint: "https://proxy.internal", enabled: undefined });
      await port({ lat: 0, lon: 0 }, "UTC");

      expect(capturedUrl!.origin).toBe("https://proxy.internal");
    });
  });

  describe("buildForecastPort — healthy fetch", () => {
    it("normalizes a healthy response", async () => {
      const { buildForecastPort } = await import("../../src/server/modules/weather/port");
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(new Response(JSON.stringify(healthyRawForecast()), { status: 200 }))
        )
      );

      const port = buildForecastPort({ endpoint: "https://fixture.example", enabled: undefined });
      const result = await port({ lat: 40.4, lon: -3.7 }, "Europe/Madrid");

      expect(result).not.toBeNull();
      expect(result!.current).toEqual({ conditionKey: "mostlyClear", tempC: 24.1, rainPct: 12 });
      expect(result!.hourly).toHaveLength(3);
      expect(result!.daily).toHaveLength(3);
      expect(result!.daily[0]).toEqual({
        date: "2026-09-04",
        conditionKey: "mostlyClear",
        tempMaxC: 26.5,
        tempMinC: 16.2,
        rainPct: 20,
      });
      expect(clientLogRows()).toHaveLength(0);
    });

    it("PR review P1-1: current.rainPct matches the CURRENT hour, not midnight — current.time is 15-min-snapped while hourly.time is on-the-hour", async () => {
      const { buildForecastPort } = await import("../../src/server/modules/weather/port");
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(
            new Response(JSON.stringify(quarterHourCurrentRawForecast()), { status: 200 })
          )
        )
      );

      const port = buildForecastPort({ endpoint: "https://fixture.example", enabled: undefined });
      const result = await port({ lat: 40.4, lon: -3.7 }, "Europe/Madrid");

      expect(result).not.toBeNull();
      // Fixture: current.time = "2026-09-04T21:45" (15-min-snapped); hourly[21] (hour 21:00)
      // carries rainPct 77, hourly[0] (midnight) carries 5 — the naive `indexOf` exact-string
      // match never finds "21:45" in an on-the-hour array and falls back to hourly[0]the 5. A
      // fix that matches on the hour prefix instead picks up hour 21's 77.
      expect(result!.current.rainPct).toBe(77);
    });

    it("an unrecognized WMO code normalizes to 'unknown' — never a crash", async () => {
      const { buildForecastPort } = await import("../../src/server/modules/weather/port");
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(
            new Response(JSON.stringify(unknownConditionCodeRawForecast()), { status: 200 })
          )
        )
      );

      const port = buildForecastPort({ endpoint: "https://fixture.example", enabled: undefined });
      const result = await port({ lat: 0, lon: 0 }, "UTC");

      expect(result).not.toBeNull();
      expect(result!.current.conditionKey).toBe("unknown");
      expect(result!.daily.every((d) => d.conditionKey === "unknown")).toBe(true);
    });
  });

  describe("buildForecastPort — failure matrix (WEATHER-INV-10/12, one telemetry row each)", () => {
    it("a hang aborts at the 5-second budget -> null + exactly one telemetry row", async () => {
      const { buildForecastPort } = await import("../../src/server/modules/weather/port");
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: URL, opts: { signal: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              opts.signal.addEventListener("abort", () => {
                reject(new DOMException("The operation was aborted.", "TimeoutError"));
              });
            })
        )
      );

      const port = buildForecastPort({ endpoint: "https://fixture.example", enabled: undefined });
      const start = Date.now();
      const result = await port({ lat: 0, lon: 0 }, "UTC");
      const elapsed = Date.now() - start;

      expect(result).toBeNull();
      // The real AbortSignal.timeout(5000) budget — generous lower bound to absorb timer jitter.
      expect(elapsed).toBeGreaterThanOrEqual(4500);

      const rows = clientLogRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].component).toBe("weather");
      expect(rows[0].level).toBe("warn");
      expect(rows[0].message).toBe("forecast_fetch_failed");
      const data = JSON.parse(rows[0].data!);
      expect(data.reason).toBe("timeout");
      expect(data.endpointHost).toBe("fixture.example");
    }, 8000);

    it("a 500 response -> null + exactly one telemetry row with the status", async () => {
      const { buildForecastPort } = await import("../../src/server/modules/weather/port");
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(new Response("server error", { status: 500 })))
      );

      const port = buildForecastPort({ endpoint: "https://fixture.example", enabled: undefined });
      const result = await port({ lat: 0, lon: 0 }, "UTC");

      expect(result).toBeNull();
      const rows = clientLogRows();
      expect(rows).toHaveLength(1);
      const data = JSON.parse(rows[0].data!);
      expect(data.reason).toBe("http_status");
      expect(data.status).toBe(500);
    });

    it("a malformed (non-JSON) body -> null + exactly one telemetry row", async () => {
      const { buildForecastPort } = await import("../../src/server/modules/weather/port");
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(new Response("not json{{{", { status: 200 })))
      );

      const port = buildForecastPort({ endpoint: "https://fixture.example", enabled: undefined });
      const result = await port({ lat: 0, lon: 0 }, "UTC");

      expect(result).toBeNull();
      const rows = clientLogRows();
      expect(rows).toHaveLength(1);
      const data = JSON.parse(rows[0].data!);
      expect(data.reason).toBe("malformed_response");
    });

    it("a JSON body that parses but isn't a weather shape -> null + exactly one telemetry row", async () => {
      const { buildForecastPort } = await import("../../src/server/modules/weather/port");
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(new Response(JSON.stringify(malformedRawForecast()), { status: 200 }))
        )
      );

      const port = buildForecastPort({ endpoint: "https://fixture.example", enabled: undefined });
      const result = await port({ lat: 0, lon: 0 }, "UTC");

      expect(result).toBeNull();
      expect(clientLogRows()).toHaveLength(1);
    });

    it("missing `daily` -> null + exactly one telemetry row with reason missing_daily", async () => {
      const { buildForecastPort } = await import("../../src/server/modules/weather/port");
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(new Response(JSON.stringify(missingDailyRawForecast()), { status: 200 }))
        )
      );

      const port = buildForecastPort({ endpoint: "https://fixture.example", enabled: undefined });
      const result = await port({ lat: 0, lon: 0 }, "UTC");

      expect(result).toBeNull();
      const rows = clientLogRows();
      expect(rows).toHaveLength(1);
      const data = JSON.parse(rows[0].data!);
      expect(data.reason).toBe("missing_daily");
    });

    it("missing `hourly` -> null + exactly one telemetry row with reason missing_hourly", async () => {
      const { buildForecastPort } = await import("../../src/server/modules/weather/port");
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(new Response(JSON.stringify(missingHourlyRawForecast()), { status: 200 }))
        )
      );

      const port = buildForecastPort({ endpoint: "https://fixture.example", enabled: undefined });
      const result = await port({ lat: 0, lon: 0 }, "UTC");

      expect(result).toBeNull();
      const rows = clientLogRows();
      expect(rows).toHaveLength(1);
      const data = JSON.parse(rows[0].data!);
      expect(data.reason).toBe("missing_hourly");
    });

    it("a network-level fetch rejection (not an abort) -> null + exactly one telemetry row, reason network_error (P3-1, distinct from timeout)", async () => {
      const { buildForecastPort } = await import("../../src/server/modules/weather/port");
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.reject(new Error("ECONNREFUSED")))
      );

      const port = buildForecastPort({ endpoint: "https://fixture.example", enabled: undefined });
      const result = await port({ lat: 0, lon: 0 }, "UTC");

      expect(result).toBeNull();
      const rows = clientLogRows();
      expect(rows).toHaveLength(1);
      const data = JSON.parse(rows[0].data!);
      expect(data.reason).toBe("network_error");
    });

    it("an AbortError (not a TimeoutError) also reports reason timeout (P3-1)", async () => {
      const { buildForecastPort } = await import("../../src/server/modules/weather/port");
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.reject(new DOMException("The operation was aborted.", "AbortError")))
      );

      const port = buildForecastPort({ endpoint: "https://fixture.example", enabled: undefined });
      const result = await port({ lat: 0, lon: 0 }, "UTC");

      expect(result).toBeNull();
      const rows = clientLogRows();
      expect(rows).toHaveLength(1);
      const data = JSON.parse(rows[0].data!);
      expect(data.reason).toBe("timeout");
    });
  });

  describe("__setForecastPortForTests / getForecastPort (logger.ts __setTransportForTests precedent)", () => {
    afterEach(async () => {
      const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
      __setForecastPortForTests(undefined);
    });

    it("getForecastPort() returns the injected test port, bypassing createOpenMeteoPort()'s throw", async () => {
      const { __setForecastPortForTests, getForecastPort } =
        await import("../../src/server/modules/weather/port");
      const stub = vi.fn(async () => null);
      __setForecastPortForTests(stub);

      const port = getForecastPort();
      await port({ lat: 0, lon: 0 }, "UTC");

      expect(stub).toHaveBeenCalledOnce();
    });

    it("getForecastPort() falls through to createOpenMeteoPort() (and throws) once no injection is set", async () => {
      const { __setForecastPortForTests, getForecastPort } =
        await import("../../src/server/modules/weather/port");
      __setForecastPortForTests(undefined);

      expect(() => getForecastPort()).toThrow(/test runtime/i);
    });
  });
});
