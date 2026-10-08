import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../src/server/db/client";
import type { ForecastResult } from "../../src/shared";
import { createDailyBlockCache } from "../../src/server/modules/daily-briefing/external/shared-cache";
import type {
  OnThisDayData,
  OnThisDaySource,
  QuoteOfDayData,
  QuoteSource,
} from "../../src/server/modules/daily-briefing/external/ports";
import {
  wikipediaOnThisDaySource,
  zenQuotesSource,
} from "../../src/server/modules/daily-briefing/external/ports";
import { generateQuoteOfDayBlock } from "../../src/server/modules/daily-briefing/blocks/quoteOfDay";
import { generateOnThisDayBlock } from "../../src/server/modules/daily-briefing/blocks/onThisDay";
import {
  generateWeatherBlock,
  readWeatherBlockInputs,
} from "../../src/server/modules/daily-briefing/blocks/weather";
import { generateWeatherTextBlock } from "../../src/server/modules/daily-briefing/blocks/weatherText";
import { adaptBlockData } from "../../src/server/modules/daily-briefing/render/adapter";
import { renderBriefingBitmap } from "../../src/server/modules/daily-briefing/render/bridge";
import type { RenderEnvelope } from "../../src/server/modules/daily-briefing/render/types";
import { useIsolatedDb } from "../helpers/db";

/** docs/features/daily-briefing.md (FR-019, trap-sweep row) —
 * the three EXTERNAL-source blocks (`weather`, `quoteOfDay`, `onThisDay`/`weatherText`) plus the
 * shared daily block cache they run through. Fake ports only — workers have no network egress,
 * so every fetch is a scriptable in-memory function, never a real `fetch` call.
 */
describe("daily-briefing EXTERNAL blocks + shared cache", () => {
  useIsolatedDb();

  const DATE = "2026-09-08";
  // Household-local "2026-09-08" under the default tz (Europe/Madrid, no `locale` row seeded) —
  // i.e. "DATE is today" for every existing weather test below.
  const NOW = Date.UTC(2026, 8, 8, 10, 0, 0);

  afterEach(async () => {
    const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
    __setForecastPortForTests(undefined);
    delete process.env.WEATHER_ENABLED;
    delete process.env.WEATHER_ENDPOINT;
    delete process.env.QUOTE_ENDPOINT;
    delete process.env.ONTHISDAY_ENDPOINT;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function seedWeatherLocation(lat = 40.4, lon = -3.7): void {
    getDb()
      .prepare(
        "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('weather', ?, ?)"
      )
      .run(JSON.stringify({ lat, lon }), Date.now());
  }

  function forecastWithDaily(daily: ForecastResult["daily"]): ForecastResult {
    return { current: { conditionKey: "clear", tempC: 20, rainPct: 5 }, hourly: [], daily };
  }

  describe("quoteOfDay", () => {
    it("skip-on-failure: a rejecting source resolves the block to null, never throws", async () => {
      const cache = createDailyBlockCache(DATE);
      const source: QuoteSource = async () => {
        throw new Error("boom");
      };
      await expect(generateQuoteOfDayBlock(cache, source)).resolves.toBeNull();
    });

    it("one call per source per date across two members (cache hit proven by call count)", async () => {
      const fetchSpy = vi.fn(async (): Promise<QuoteOfDayData | null> => ({
        text: "Be kind.",
        author: "Anon",
      }));
      const cacheA = createDailyBlockCache(DATE); // member 1's generation pass
      const resultA = await generateQuoteOfDayBlock(cacheA, fetchSpy);
      const cacheB = createDailyBlockCache(DATE); // member 2's generation pass — fresh instance
      const resultB = await generateQuoteOfDayBlock(cacheB, fetchSpy);

      expect(resultA).toEqual({ text: "Be kind.", author: "Anon" });
      expect(resultB).toEqual(resultA);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("cache survives a fresh cache-instance construction (persisted row reused — restart simulation)", async () => {
      const fetchSpy = vi.fn(async (): Promise<QuoteOfDayData | null> => ({
        text: "Persisted.",
        author: "V1",
      }));
      const first = createDailyBlockCache(DATE);
      await generateQuoteOfDayBlock(first, fetchSpy);

      // Simulate a process restart: a brand-new cache instance, same date, no shared Map.
      const restarted = createDailyBlockCache(DATE);
      expect(restarted.get<QuoteOfDayData>("quoteOfDay")).toEqual({
        text: "Persisted.",
        author: "V1",
      });

      const resultAfterRestart = await generateQuoteOfDayBlock(restarted, fetchSpy);
      expect(resultAfterRestart).toEqual({ text: "Persisted.", author: "V1" });
      expect(fetchSpy).toHaveBeenCalledTimes(1); // never re-fetched after the restart
    });

    it("persist-failure is swallowed with a warning; the in-memory value still serves", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const cache = createDailyBlockCache(DATE);
      getDb().exec("DROP TABLE daily_briefing_block_cache");

      const source: QuoteSource = async () => ({ text: "Ephemeral.", author: "Gone" });
      const result = await generateQuoteOfDayBlock(cache, source);

      expect(result).toEqual({ text: "Ephemeral.", author: "Gone" });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [message] = warnSpy.mock.calls[0] as [string];
      expect(message).toMatch(/persist-failed/);
      expect(/^[ -~]*$/.test(message)).toBe(true); // English/ASCII only (printable range)

      // Still served from memory — the dropped table proves no DB fallback is in play.
      expect(cache.get<QuoteOfDayData>("quoteOfDay")).toEqual({
        text: "Ephemeral.",
        author: "Gone",
      });
    });

    it("no negative caching: a failed fetch does not cache; the next generation retries", async () => {
      const cache = createDailyBlockCache(DATE);
      let attempt = 0;
      const source: QuoteSource = async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("transient");
        return { text: "Recovered.", author: "Retry" };
      };

      expect(await generateQuoteOfDayBlock(cache, source)).toBeNull();
      expect(await generateQuoteOfDayBlock(cache, source)).toEqual({
        text: "Recovered.",
        author: "Retry",
      });
      expect(attempt).toBe(2); // the second call actually re-invoked the source
    });
  });

  describe("onThisDay", () => {
    it("skip-on-failure: a rejecting source resolves the block to null, never throws", async () => {
      const cache = createDailyBlockCache(DATE);
      const source: OnThisDaySource = async () => {
        throw new Error("timeout");
      };
      await expect(generateOnThisDayBlock(cache, source, DATE)).resolves.toBeNull();
    });

    it("one call per source per date across two members (cache hit proven by call count)", async () => {
      const data: OnThisDayData = { events: ["1969: Moon landing"] };
      const fetchSpy = vi.fn(async (): Promise<OnThisDayData | null> => data);
      const cacheA = createDailyBlockCache(DATE);
      const resultA = await generateOnThisDayBlock(cacheA, fetchSpy, DATE);
      const cacheB = createDailyBlockCache(DATE);
      const resultB = await generateOnThisDayBlock(cacheB, fetchSpy, DATE);

      expect(resultA).toEqual(data);
      expect(resultB).toEqual(data);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("passes languagePrefix through to the source (default 'en')", async () => {
      const cache = createDailyBlockCache(DATE);
      let capturedPrefix: string | undefined;
      const source: OnThisDaySource = async (_date, languagePrefix) => {
        capturedPrefix = languagePrefix;
        return { events: ["x"] };
      };
      await generateOnThisDayBlock(cache, source, DATE);
      expect(capturedPrefix).toBe("en");

      const cache2 = createDailyBlockCache("2026-09-09");
      await generateOnThisDayBlock(cache2, source, "2026-09-09", "es");
      expect(capturedPrefix).toBe("es");
    });

    it("no negative caching: a failed fetch does not cache; the next generation retries", async () => {
      const cache = createDailyBlockCache(DATE);
      let attempt = 0;
      const source: OnThisDaySource = async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("network");
        return { events: ["recovered"] };
      };

      expect(await generateOnThisDayBlock(cache, source, DATE)).toBeNull();
      expect(await generateOnThisDayBlock(cache, source, DATE)).toEqual({ events: ["recovered"] });
      expect(attempt).toBe(2);
    });
  });

  it("captured weather input failures omit without poisoning the external cache", async () => {
    seedWeatherLocation();
    getDb()
      .prepare("UPDATE settings_objects SET data = 'null' WHERE object_name = 'weather'")
      .run();
    const inputs = readWeatherBlockInputs(NOW);
    expect(inputs).toBeNull();
    const cache = createDailyBlockCache(DATE);
    expect(await generateWeatherBlock(cache, DATE, NOW, inputs)).toBeNull();
    expect(cache.get("weather")).toBeUndefined();
  });

  describe("weather (via the 016 weather seam — readWeatherLocation/getForecastPort)", () => {
    it("skip-on-failure: a forecast-port failure (resolves null) resolves the block to null, never throws", async () => {
      seedWeatherLocation();
      const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
      __setForecastPortForTests(async () => null);

      const cache = createDailyBlockCache(DATE);
      await expect(generateWeatherBlock(cache, DATE, NOW)).resolves.toBeNull();
    });

    it("no location configured resolves null without calling the port", async () => {
      const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
      const portSpy = vi.fn(async () =>
        forecastWithDaily([
          { date: DATE, conditionKey: "clear", tempMinC: 10, tempMaxC: 20, rainPct: 5 },
        ])
      );
      __setForecastPortForTests(portSpy);

      const cache = createDailyBlockCache(DATE);
      const result = await generateWeatherBlock(cache, DATE, NOW);
      expect(result).toBeNull();
      expect(portSpy).not.toHaveBeenCalled();
    });

    // (D3): weather/port.ts's operator kill-switch and its
    // invalid-endpoint guard are STABLE deploy-time config, not transient failures — this
    // block detects both itself and caches their null, exactly like the blank-location case.
    it("operator kill-switch (weather.enabled=false) resolves null and IS cached — the port is never called", async () => {
      seedWeatherLocation();
      process.env.WEATHER_ENABLED = "false";
      const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
      const portSpy = vi.fn(async () =>
        forecastWithDaily([
          { date: DATE, conditionKey: "clear", tempMinC: 10, tempMaxC: 20, rainPct: 5 },
        ])
      );
      __setForecastPortForTests(portSpy);

      const cache = createDailyBlockCache(DATE);
      expect(await generateWeatherBlock(cache, DATE, NOW)).toBeNull();
      expect(await generateWeatherBlock(cache, DATE, NOW)).toBeNull(); // in-memory cache hit, not re-derived
      expect(portSpy).not.toHaveBeenCalled();

      // A FRESH cache instance (restart simulation) still serves the null from the DB — proof
      // it was genuinely PERSISTED as a stable-config skip, not just an in-memory short-circuit.
      const restarted = createDailyBlockCache(DATE);
      expect(restarted.get("weather")).toBeNull();
    });

    it("an invalid operator-configured WEATHER_ENDPOINT resolves null and IS cached — the port is never called", async () => {
      seedWeatherLocation();
      process.env.WEATHER_ENDPOINT = "not a url";
      const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
      const portSpy = vi.fn(async () =>
        forecastWithDaily([
          { date: DATE, conditionKey: "clear", tempMinC: 10, tempMaxC: 20, rainPct: 5 },
        ])
      );
      __setForecastPortForTests(portSpy);

      const cache = createDailyBlockCache(DATE);
      expect(await generateWeatherBlock(cache, DATE, NOW)).toBeNull();
      expect(portSpy).not.toHaveBeenCalled();

      const restarted = createDailyBlockCache(DATE);
      expect(restarted.get("weather")).toBeNull();
    });

    it("one call per source per date across two members (cache hit proven by call count)", async () => {
      seedWeatherLocation();
      const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
      const portSpy = vi.fn(async () =>
        forecastWithDaily([
          { date: DATE, conditionKey: "rain", tempMinC: 8, tempMaxC: 14, rainPct: 70 },
        ])
      );
      __setForecastPortForTests(portSpy);

      const cacheA = createDailyBlockCache(DATE); // member 1
      const resultA = await generateWeatherBlock(cacheA, DATE, NOW);
      const cacheB = createDailyBlockCache(DATE); // member 2, fresh instance
      const resultB = await generateWeatherBlock(cacheB, DATE, NOW);

      expect(resultA).toEqual({
        date: DATE,
        conditionKey: "rain",
        tempMinC: 8,
        tempMaxC: 14,
        rainPct: 70,
      });
      expect(resultB).toEqual(resultA);
      expect(portSpy).toHaveBeenCalledTimes(1);
    });

    it("cache survives a fresh cache-instance construction (persisted row reused — restart simulation)", async () => {
      seedWeatherLocation();
      const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
      const portSpy = vi.fn(async () =>
        forecastWithDaily([
          { date: DATE, conditionKey: "snow", tempMinC: -2, tempMaxC: 2, rainPct: 60 },
        ])
      );
      __setForecastPortForTests(portSpy);

      const first = createDailyBlockCache(DATE);
      await generateWeatherBlock(first, DATE, NOW);

      const restarted = createDailyBlockCache(DATE);
      const result = await generateWeatherBlock(restarted, DATE, NOW);
      expect(result).toEqual({
        date: DATE,
        conditionKey: "snow",
        tempMinC: -2,
        tempMaxC: 2,
        rainPct: 60,
      });
      expect(portSpy).toHaveBeenCalledTimes(1);
    });

    it("no negative caching: a port failure does not cache; the next generation retries", async () => {
      seedWeatherLocation();
      const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
      let attempt = 0;
      __setForecastPortForTests(async () => {
        attempt += 1;
        if (attempt === 1) return null;
        return forecastWithDaily([
          { date: DATE, conditionKey: "clear", tempMinC: 12, tempMaxC: 22, rainPct: 0 },
        ]);
      });

      const cache = createDailyBlockCache(DATE);
      expect(await generateWeatherBlock(cache, DATE, NOW)).toBeNull();
      expect(await generateWeatherBlock(cache, DATE, NOW)).toEqual({
        date: DATE,
        conditionKey: "clear",
        tempMinC: 12,
        tempMaxC: 22,
        rainPct: 0,
      });
      expect(attempt).toBe(2);
    });

    it("a successful forecast with no matching daily[] entry for TODAY resolves null and IS cached (not a failure)", async () => {
      seedWeatherLocation();
      const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
      const portSpy = vi.fn(async () =>
        forecastWithDaily([
          { date: "2026-09-20", conditionKey: "clear", tempMinC: 1, tempMaxC: 2, rainPct: 0 },
        ])
      );
      __setForecastPortForTests(portSpy);

      // DATE ("2026-09-08") <= household-today (NOW resolves to the same date) — a
      // today-or-earlier horizon miss is stable and cacheable.
      const cache = createDailyBlockCache(DATE);
      expect(await generateWeatherBlock(cache, DATE, NOW)).toBeNull();
      expect(await generateWeatherBlock(cache, DATE, NOW)).toBeNull();
      expect(portSpy).toHaveBeenCalledTimes(1); // the horizon-miss null WAS cached
    });

    //: a horizon miss for a FUTURE target date (an
    // admin generating ahead of the household's scheduled day) must NOT be cached — the miss is
    // transient (the date simply hasn't entered the provider's horizon yet), and
    // `daily_briefing_block_cache` has no eviction, so caching it would permanently starve the
    // scheduled 06:00 pass once that date actually arrives.
    it("a horizon miss for a FUTURE date is NOT cached — a fresh cache instance re-fetches", async () => {
      seedWeatherLocation();
      const FUTURE_DATE = "2026-09-20"; // strictly after NOW's household-today ("2026-09-08")
      const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
      const portSpy = vi.fn(async () =>
        forecastWithDaily([
          { date: DATE, conditionKey: "clear", tempMinC: 10, tempMaxC: 18, rainPct: 5 },
        ])
      );
      __setForecastPortForTests(portSpy);

      const first = createDailyBlockCache(FUTURE_DATE);
      expect(await generateWeatherBlock(first, FUTURE_DATE, NOW)).toBeNull();

      // A fresh cache instance for the SAME future date re-invokes the port — the miss was
      // never persisted.
      const second = createDailyBlockCache(FUTURE_DATE);
      expect(await generateWeatherBlock(second, FUTURE_DATE, NOW)).toBeNull();
      expect(portSpy).toHaveBeenCalledTimes(2);
      expect(second.get("weather")).toBeUndefined(); // no row was ever persisted
    });
  });

  describe("weatherText", () => {
    it("delegates to weather's data — one shared call serves both block types", async () => {
      seedWeatherLocation();
      const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
      const portSpy = vi.fn(async () =>
        forecastWithDaily([
          { date: DATE, conditionKey: "overcast", tempMinC: 5, tempMaxC: 9, rainPct: 40 },
        ])
      );
      __setForecastPortForTests(portSpy);

      const cache = createDailyBlockCache(DATE);
      const visual = await generateWeatherBlock(cache, DATE, NOW);
      const text = await generateWeatherTextBlock(cache, DATE, NOW);

      expect(text).toEqual(visual);
      expect(portSpy).toHaveBeenCalledTimes(1);
    });
  });

  // the adapter/render-def pair previously expected v1's shape
  // (`condition`/`tempMin`/`tempMax`/`rainProbability`/`hourly`), which `generateWeatherBlock`/
  // `generateWeatherTextBlock` never emit — every REAL weather payload threw `AdapterError` and
  // both blocks landed in `failedRenderBlocks` on every print for weather-configured households.
  // Same live-fixture pattern the other block types use elsewhere (e.g.
  // `daily-briefing-blocks-domain.test.ts`'s `adaptBlockData(...)` non-throw assertions): drive
  // the REAL generator, then the REAL adapter, then the REAL render bridge — never a hand-typed
  // fixture that could silently drift from what the generator actually produces.
  describe("weather/weatherText adapter + render conformance (#711 P0 fold)", () => {
    it("a REAL generated weather payload adapts without throwing and renders through the bridge", async () => {
      seedWeatherLocation();
      const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
      __setForecastPortForTests(async () =>
        forecastWithDaily([
          { date: DATE, conditionKey: "rain", tempMinC: 8, tempMaxC: 14, rainPct: 70 },
        ])
      );

      const cache = createDailyBlockCache(DATE);
      const weatherData = await generateWeatherBlock(cache, DATE, NOW);
      expect(weatherData).not.toBeNull();
      expect(() => adaptBlockData("weather", weatherData)).not.toThrow();

      const envelope: RenderEnvelope = {
        memberId: "m1",
        memberName: "Member",
        date: DATE,
        blocks: [{ type: "weather", title: "01 WEATHER", data: weatherData }],
      };
      const rendered = await renderBriefingBitmap(envelope);
      expect(rendered.bitmapPng).not.toBeNull();
      expect(rendered.failedRenderBlocks).toEqual([]);
      expect(rendered.unrenderedBlocks).toEqual([]);
    });

    it("a REAL generated weatherText payload adapts without throwing and renders through the bridge", async () => {
      seedWeatherLocation();
      const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
      __setForecastPortForTests(async () =>
        forecastWithDaily([
          { date: DATE, conditionKey: "clear", tempMinC: 12, tempMaxC: 22, rainPct: 0 },
        ])
      );

      const cache = createDailyBlockCache(DATE);
      const weatherTextData = await generateWeatherTextBlock(cache, DATE, NOW);
      expect(weatherTextData).not.toBeNull();
      expect(() => adaptBlockData("weatherText", weatherTextData)).not.toThrow();

      const envelope: RenderEnvelope = {
        memberId: "m1",
        memberName: "Member",
        date: DATE,
        blocks: [{ type: "weatherText", title: "01 WEATHER TEXT", data: weatherTextData }],
      };
      const rendered = await renderBriefingBitmap(envelope);
      expect(rendered.bitmapPng).not.toBeNull();
      expect(rendered.failedRenderBlocks).toEqual([]);
      expect(rendered.unrenderedBlocks).toEqual([]);
    });
  });

  //: two overlapping generations for the SAME date
  // (different members) can each construct their own cache instance and both observe a memory
  // miss before either persists. `getOrFetchOnceDaily` re-reads the DB right before invoking the
  // fetcher to close the common sequential-overlap window.
  describe("shared cache concurrency (FOLD-2, Codex #704 review)", () => {
    it("a stale cache instance re-checks the DB before fetching, adopting a just-persisted row instead of re-fetching", async () => {
      const cacheA = createDailyBlockCache(DATE);
      // Constructed at the same moment as A — its in-memory Map has already eager-loaded (empty,
      // nothing persisted yet) and stays stale once A persists below.
      const cacheB = createDailyBlockCache(DATE);

      const fetchSpyA = vi.fn(async (): Promise<QuoteOfDayData | null> => ({
        text: "From A",
        author: "A",
      }));
      const resultA = await generateQuoteOfDayBlock(cacheA, fetchSpyA);
      expect(resultA).toEqual({ text: "From A", author: "A" });

      const fetchSpyB = vi.fn(async (): Promise<QuoteOfDayData | null> => ({
        text: "From B",
        author: "B",
      }));
      const resultB = await generateQuoteOfDayBlock(cacheB, fetchSpyB);

      // B adopts A's already-persisted row via the DB re-check — never invokes its own fetcher.
      expect(resultB).toEqual({ text: "From A", author: "A" });
      expect(fetchSpyB).not.toHaveBeenCalled();
    });
  });

  // (on, P1 TOCTOU): `evictWeatherCache` deletes the
  // persisted row AND bumps a module-level epoch (`external/shared-cache.ts`) so an in-flight
  // fetch started BEFORE the eviction can never resurrect stale data by persisting after it.
  describe("eviction epoch (FOLD-1, Codex #707 review)", () => {
    it("a weather eviction mid-fetch discards the stale write: not persisted, not served by a fresh instance", async () => {
      seedWeatherLocation(40.4, -3.7);
      const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
      const { evictWeatherCache } =
        await import("../../src/server/modules/daily-briefing/external/shared-cache");

      let releaseFetch: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseFetch = resolve;
      });
      __setForecastPortForTests(async () => {
        await gate;
        return forecastWithDaily([
          { date: DATE, conditionKey: "clear", tempMinC: 18, tempMaxC: 26, rainPct: 5 },
        ]);
      });

      const cache = createDailyBlockCache(DATE);
      // Kicks off the fetch — synchronously runs up to `await gate` inside the mocked port,
      // which is where it genuinely suspends (see this describe block's own doc comment for why
      // the epoch is captured BEFORE this line returns control here).
      const resultPromise = generateWeatherBlock(cache, DATE, NOW);

      // Simulates an admin changing the location WHILE the above fetch is still in flight.
      evictWeatherCache();
      releaseFetch?.();

      const result = await resultPromise;
      // The IN-FLIGHT caller still gets its own already-computed result — harmless, since it's
      // this one generation's own snapshot, not a future reader (see `getOrFetchOnceDaily`'s own
      // doc comment on why only the WRITE is discarded, not the return value).
      expect(result).toEqual({
        date: DATE,
        conditionKey: "clear",
        tempMinC: 18,
        tempMaxC: 26,
        rainPct: 5,
      });

      // The stale value must NOT have been persisted.
      const row = getDb()
        .prepare(
          "SELECT payload FROM daily_briefing_block_cache WHERE date = ? AND block_type = 'weather'"
        )
        .get(DATE);
      expect(row).toBeUndefined();

      // A FRESH cache instance (a later member's generation, or a later date-scoped pass) must
      // observe a genuine miss, never the discarded stale value.
      const freshCache = createDailyBlockCache(DATE);
      expect(freshCache.get("weather")).toBeUndefined();
    });
  });

  // (D3): the production fetch-based adapters had zero coverage —
  // `vi.stubGlobal("fetch",...)` only, never a real network call.
  describe("production adapters (zenQuotesSource / wikipediaOnThisDaySource)", () => {
    function stubFetch(response: { ok: boolean; status: number; json: () => Promise<unknown> }) {
      const fetchMock = vi.fn(
        async (_url: string, _init?: { signal?: AbortSignal }) => response as Response
      );
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    describe("zenQuotesSource", () => {
      it("requests the ZenQuotes endpoint with a bounded AbortSignal and returns the stripped quote", async () => {
        const fetchMock = stubFetch({
          ok: true,
          status: 200,
          json: async () => [{ q: '"Be kind."', a: "Anon" }],
        });

        const result = await zenQuotesSource();

        expect(result).toEqual({ text: "Be kind.", author: "Anon" });
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe("https://zenquotes.io/api/today");
        expect(init?.signal).toBeInstanceOf(AbortSignal);
      });

      it("strips Unicode curly quotes and falls back the author to 'Unknown'; a quote-less response resolves null", async () => {
        stubFetch({ ok: true, status: 200, json: async () => [{ q: "“Hi there.”" }] });
        expect(await zenQuotesSource()).toEqual({ text: "Hi there.", author: "Unknown" });

        stubFetch({ ok: true, status: 200, json: async () => [{}] });
        expect(await zenQuotesSource()).toBeNull();
      });

      it("a non-2xx response throws (never resolves silently)", async () => {
        stubFetch({ ok: false, status: 500, json: async () => [] });
        await expect(zenQuotesSource()).rejects.toThrow(/zenquotes 500/);
      });

      // (the WEATHER_ENDPOINT precedent): operator-overridable endpoint —
      // otherwise a Playwright-driven `npm start` process would always hit the real
      // zenquotes.io host with no way to point it at an e2e fixture.
      it("honors an operator-overridden endpoint (QUOTE_ENDPOINT)", async () => {
        process.env.QUOTE_ENDPOINT = "https://quote-fixture.internal";
        const fetchMock = stubFetch({
          ok: true,
          status: 200,
          json: async () => [{ q: "Fixture quote.", a: "Fixture Author" }],
        });

        const result = await zenQuotesSource();

        expect(result).toEqual({ text: "Fixture quote.", author: "Fixture Author" });
        const [url] = fetchMock.mock.calls[0];
        expect(url).toBe("https://quote-fixture.internal/api/today");
      });
    });

    describe("wikipediaOnThisDaySource", () => {
      it("sends a bounded, language-prefixed, zero-padded mm/dd request (default 'en' and a custom prefix)", async () => {
        const fetchMock = stubFetch({
          ok: true,
          status: 200,
          json: async () => ({ events: [{ year: 1969, text: "Moon landing" }] }),
        });

        await wikipediaOnThisDaySource("2026-09-08");
        const [defaultUrl, defaultInit] = fetchMock.mock.calls[0];
        expect(defaultUrl).toBe("https://en.wikipedia.org/api/rest_v1/feed/onthisday/all/09/08");
        expect(defaultInit?.signal).toBeInstanceOf(AbortSignal);

        await wikipediaOnThisDaySource("2026-01-05", "es");
        const [customUrl] = fetchMock.mock.calls[1];
        expect(customUrl).toBe("https://es.wikipedia.org/api/rest_v1/feed/onthisday/all/01/05");
      });

      it("a non-2xx response throws", async () => {
        stubFetch({ ok: false, status: 404, json: async () => ({}) });
        await expect(wikipediaOnThisDaySource("2026-09-08")).rejects.toThrow(/onthisday 404/);
      });

      // (the WEATHER_ENDPOINT precedent): operator-overridable endpoint,
      // replacing the whole language-prefixed origin — otherwise a Playwright-driven
      // `npm start` process would always hit the real *.wikipedia.org host.
      it("honors an operator-overridden endpoint (ONTHISDAY_ENDPOINT), replacing the language-prefixed origin", async () => {
        process.env.ONTHISDAY_ENDPOINT = "https://onthisday-fixture.internal";
        const fetchMock = stubFetch({
          ok: true,
          status: 200,
          json: async () => ({ events: [{ year: 1969, text: "Moon landing" }] }),
        });

        const result = await wikipediaOnThisDaySource("2026-09-08", "es");

        expect(result).toEqual({ events: ["1969: Moon landing"] });
        const [url] = fetchMock.mock.calls[0];
        expect(url).toBe("https://onthisday-fixture.internal/api/rest_v1/feed/onthisday/all/09/08");
      });

      it("pickThirds: fewer than 6 items returns all of them; six or more returns the recent/middle/old trio", async () => {
        const few = [
          { year: 2001, text: "a" },
          { year: 2002, text: "b" },
          { year: 2003, text: "c" },
        ];
        stubFetch({ ok: true, status: 200, json: async () => ({ events: few }) });
        const fewResult = await wikipediaOnThisDaySource("2026-09-08");
        expect(fewResult?.events).toEqual(["2001: a", "2002: b", "2003: c"]);

        // length 9: floor(9/6)=1, floor(9/2)=4, floor(9*5/6)=7 — recent/middle/old thirds.
        const many = Array.from({ length: 9 }, (_, i) => ({ year: 2000 + i, text: `item-${i}` }));
        stubFetch({ ok: true, status: 200, json: async () => ({ events: many }) });
        const manyResult = await wikipediaOnThisDaySource("2026-09-08");
        expect(manyResult?.events).toEqual(["2001: item-1", "2004: item-4", "2007: item-7"]);
      });

      it("empty categories are omitted from the result entirely (all-empty resolves null)", async () => {
        stubFetch({
          ok: true,
          status: 200,
          json: async () => ({ events: [], births: [], deaths: [] }),
        });
        expect(await wikipediaOnThisDaySource("2026-09-08")).toBeNull();

        stubFetch({
          ok: true,
          status: 200,
          json: async () => ({ births: [{ year: 1900, text: "x" }] }),
        });
        const result = await wikipediaOnThisDaySource("2026-09-08");
        expect(result).toEqual({ births: ["1900: x"] });
        expect(result?.events).toBeUndefined();
        expect(result?.deaths).toBeUndefined();
      });
    });
  });
});
