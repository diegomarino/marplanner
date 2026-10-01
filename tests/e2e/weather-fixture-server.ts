import http from "node:http";
import type { Server } from "node:http";

/** docs/features/weather.md — the e2e "fixture provider" (quickstart
 * scenario 9): a tiny local HTTP server standing in for Open-Meteo, so the e2e run performs
 * zero real egress (D4's "no test tier performs real egress" applies here too — the
 * production port factory's `isTestRuntime` throw only guards vitest; this fixture is how
 * the REAL built server's `openMeteoPort` gets a controlled response instead of a live call).
 * Repo FIRST (trap-sweep): every other e2e spec that needs its own server reserves an
 * OS-assigned ephemeral port (`app.listen({ port: 0 })` — critical-flow.spec.ts,
 * backups-restore.spec.ts, host-api-skeleton.spec.ts). This one can't: Playwright's runner
 * starts `webServer` (the plugin-setup task) BEFORE it runs `globalSetup`
 * (`createPluginSetupTasks` precedes `createGlobalSetupTask` in the task pipeline), so the
 * `webServer.env.WEATHER_ENDPOINT` value baked into playwright.config.ts must already be
 * known — a port only this globalSetup discovers at runtime can't reach it. The port is
 * therefore a fixed constant both `playwright.config.ts` and this module import, bound ONLY
 * to loopback (127.0.0.1) for the lifetime of the whole e2e run (globalSetup ->
 * globalTeardown), not per-worker/per-test.
 */
// Override per isolated validation lane; runner and provider import the same value.
export const WEATHER_FIXTURE_PORT = Number(process.env.MP_E2E_WEATHER_FIXTURE_PORT ?? "41837");
export const WEATHER_FIXTURE_ORIGIN = `http://127.0.0.1:${WEATHER_FIXTURE_PORT}`;

/** Builds an Open-Meteo-shaped `/v1/forecast` response whose integer temperature IS the
 * (rounded) requested latitude — quickstart scenario 9 ("change location -> no stale
 * render") needs two coordinates that render VISIBLY different pill temperatures, and this
 * removes the need for a separate "known coordinate -> profile" lookup table the spec's
 * chosen coordinates would otherwise have to stay in sync with. Field names mirror exactly
 * what `src/server/modules/weather/port.ts`'s `CURRENT_VARS`/`HOURLY_VARS`/`DAILY_VARS`
 * request (same shape as `tests/helpers/weather-fixtures.ts`'s `healthyRawForecast`).
 */
function forecastPayloadForLatitude(latitude: number): unknown {
  const now = new Date();
  const hourIso = `${now.toISOString().slice(0, 13)}:00`;
  const dayIso = now.toISOString().slice(0, 10);
  const tempC = Math.round(latitude);

  return {
    latitude,
    longitude: 0,
    timezone: "UTC",
    current: { time: hourIso, temperature_2m: tempC, weather_code: 0 },
    hourly: {
      time: [hourIso],
      temperature_2m: [tempC],
      precipitation_probability: [20],
      weather_code: [0],
    },
    daily: {
      time: [dayIso],
      weather_code: [0],
      temperature_2m_max: [tempC + 5],
      temperature_2m_min: [tempC - 5],
      precipitation_probability_max: [20],
    },
  };
}

let server: Server | undefined;

/** Total `/v1/forecast` hits since the fixture started (never reset mid-run) — exposed over
 * HTTP via `/__fixture/count` rather than an in-process export, because the kill-switch e2e
 * scenario (`weather.spec.ts`, its OWN spawned server process) runs in a Playwright WORKER
 * process, a different OS process from the one running `global-setup.ts`/this module. A
 * plain in-process counter export would silently read as "0, always" from that worker —
 * an HTTP round-trip to the already-listening fixture is the only channel that actually
 * crosses the process boundary.
 */
let forecastRequestCount = 0;

/** Starts the fixture server on the fixed port above. Idempotent no-op if already running. */
export function startWeatherFixtureServer(): Promise<void> {
  if (server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", WEATHER_FIXTURE_ORIGIN);
      if (url.pathname === "/__fixture/count") {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ count: forecastRequestCount }));
        return;
      }
      if (url.pathname !== "/v1/forecast") {
        res.writeHead(404, { "content-type": "application/json" }).end("{}");
        return;
      }
      forecastRequestCount += 1;
      const latitude = Number(url.searchParams.get("latitude") ?? "0");
      const body = JSON.stringify(forecastPayloadForLatitude(latitude));
      res.writeHead(200, { "content-type": "application/json" }).end(body);
    });
    s.once("error", (err) => {
      reject(
        new Error(
          `weather e2e fixture could not bind 127.0.0.1:${WEATHER_FIXTURE_PORT} — is another run active?`,
          { cause: err }
        )
      );
    });
    s.listen(WEATHER_FIXTURE_PORT, "127.0.0.1", () => {
      server = s;
      resolve();
    });
  });
}

/** Stops the fixture server. Idempotent no-op if not running. */
export function stopWeatherFixtureServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    const s = server;
    server = undefined;
    s.close(() => resolve());
  });
}

/** Reads the current `/v1/forecast` hit count over real HTTP — see `forecastRequestCount`'s * docblock for why this can't just be an in-process export. */
export async function fetchFixtureRequestCount(): Promise<number> {
  const res = await fetch(`${WEATHER_FIXTURE_ORIGIN}/__fixture/count`);
  const body = (await res.json()) as { count: number };
  return body.count;
}
