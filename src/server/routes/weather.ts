import type { FastifyInstance } from "fastify";
import { readHouseholdTimezone } from "../host-api";
import { readWeatherLocation } from "../modules/weather";
import { getForecastPort } from "../modules/weather/port";
import type { WeatherResponse } from "../../shared";

/** Location read (reconciliation with): delegates to
 * `readWeatherLocation` (`src/server/modules/weather/index.ts`) — range-validated
 * AND partial-pair-safe on read — instead of the duplicate raw `db.prepare(...).get(...)`
 * this route previously carried. `routes/weather.ts` is a core route file, not a
 * plugin-namespaced module, so importing INTO `modules/weather` is unrestricted (the
 * `import-x/no-restricted-paths` zone only fences that module's OWN outbound imports).
 * `readWeatherLocation` itself now degrades a corrupt/malformed `data` column to blank
 * (— the guard moved INTO the shared accessor so every caller,
 * this route included, is safe without a local wrapper); this route no longer needs its own
 * try/catch around it.
 */

/** `GET /api/weather` — the domain's only own surface (FR-024): a normalized forecast read,
 * never a settings endpoint. Absence (blank location, operator-disabled, failed/timed-out
 * fetch) is ALWAYS `200 { forecast: null }` — never a 5xx (WEATHER-INV-12, D3). Gated only by
 * the app-wide API-key boundary registered in `app.ts` — no capability, mirroring
 * `GET /api/settings`.
 */
export async function weatherRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/weather", async (): Promise<WeatherResponse> => {
    const location = readWeatherLocation();
    if (!location) return { forecast: null };

    const tz = readHouseholdTimezone();
    const port = getForecastPort();
    const forecast = await port(location, tz);
    return { forecast };
  });
}
