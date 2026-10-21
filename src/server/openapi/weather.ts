// Code-first OpenAPI: route schemas for the weather HTTP surface.
// These zod schemas are the single source of truth for docs/api/openapi.json
// (npm run generate:openapi). They document the HTTP contract; validation stays in
// src/server/modules/* so error envelopes remain byte-compatible.
import { z } from "zod";
import { component, defineRouteSchemas, noContent } from "./zod";
import { PluginUnavailable, authenticationBackoffResponse } from "./common";

export const ConditionKey = component(
  "ConditionKey",
  z.enum([
    "clear",
    "mostlyClear",
    "partlyCloudy",
    "overcast",
    "fog",
    "drizzle",
    "freezingDrizzle",
    "rain",
    "freezingRain",
    "snow",
    "snowGrains",
    "rainShowers",
    "snowShowers",
    "thunderstorm",
    "thunderstormHail",
    "unknown",
  ]),
  { description: "Closed union from the single shared WMO map (WEATHER-INV-06)." }
);

export const ForecastCurrent = component(
  "ForecastCurrent",
  z.strictObject({
    conditionKey: ConditionKey,
    tempC: z.number(),
    rainPct: z.int().min(0).max(100),
    isDay: z.boolean().meta({ description: "Absent when the provider omits it." }).optional(),
    humidityPct: z
      .int()
      .min(0)
      .max(100)
      .meta({ description: "Relative humidity. Absent when the provider omits it." })
      .optional(),
    windKmh: z
      .number()
      .min(0)
      .meta({ description: "Absent when the provider omits it." })
      .optional(),
    sunrise: z
      .string()
      .meta({
        description:
          "Today's sunrise, ISO datetime in household tz. Absent when the provider omits it.",
      })
      .optional(),
    sunset: z
      .string()
      .meta({
        description:
          "Today's sunset, ISO datetime in household tz. Absent when the provider omits it.",
      })
      .optional(),
  })
);

export const ForecastDay = component(
  "ForecastDay",
  z.strictObject({
    date: z.string().meta({ description: "YYYY-MM-DD in household tz (WEATHER-INV-04)" }),
    conditionKey: ConditionKey,
    tempMinC: z.number(),
    tempMaxC: z.number(),
    rainPct: z.int().min(0).max(100),
  })
);

export const ForecastHour = component(
  "ForecastHour",
  z.strictObject({
    time: z.string().meta({ description: "ISO datetime in household tz" }),
    conditionKey: ConditionKey,
    tempC: z.number(),
    rainPct: z.int().min(0).max(100),
    isDay: z.boolean().meta({ description: "Absent when the provider omits it." }).optional(),
  })
);

export const WeatherConditionKey = component(
  "WeatherConditionKey",
  z.enum([
    "clear",
    "mostlyClear",
    "partlyCloudy",
    "overcast",
    "fog",
    "drizzle",
    "freezingDrizzle",
    "rain",
    "freezingRain",
    "snow",
    "snowGrains",
    "rainShowers",
    "snowShowers",
    "thunderstorm",
    "thunderstormHail",
    "unknown",
  ])
);

export const WeatherBlockPayload = component(
  "WeatherBlockPayload",
  z.strictObject({
    date: z.string().meta({ description: "YYYY-MM-DD, household tz" }),
    conditionKey: WeatherConditionKey,
    tempMinC: z.number(),
    tempMaxC: z.number(),
    rainPct: z.int().min(0).max(100),
  }),
  {
    description:
      "The `data` shape of a `BlockInstance` whose `type` is `weather` (, the Weather domain contract). Present only when the household's forecast `daily[]` covers the briefing's household-local `date` (WEATHER-INV-05); frozen once written (WEATHER-INV-09) — regeneration is the only refresh. `BlockInstance.data` stays the generic `[object, array, 'null']` schema above (untyped per-type, matching every other block type's precedent) — this schema documents what a `weather`-typed block's `data` actually contains (the route-only drift gate cannot see this body-shape change, hence the explicit ripple-edit).\n",
  }
);

export const WeatherResponse = component(
  "WeatherResponse",
  z.strictObject({
    forecast: z
      .xor([
        z.null(),
        z.strictObject({
          current: ForecastCurrent,
          hourly: z.array(ForecastHour),
          daily: z.array(ForecastDay),
        }),
      ])
      .meta({
        description:
          "null = silent absence: blank location, operator-disabled, or failed/timed-out fetch (WEATHER-INV-12). Never expressed as an HTTP error.",
      }),
  })
);

export const weatherSchemas = defineRouteSchemas({
  /** GET /api/weather */
  getWeather: {
    operationId: "getWeather",
    tags: ["weather"],
    summary: "Read the normalized forecast for the household's configured location",
    description:
      "WEATHER's only own surface (FR-024) — the location is read/written ONLY through App Settings; no weather settings endpoint exists (negative-proved via `app.hasRoute`). `forecast: null` covers every absence case alike (blank location, operator-disabled via `WEATHER_ENABLED`, or a failed/timed-out upstream fetch) — NEVER a 5xx (WEATHER-INV-12, D3). Gated only by the app-wide API-key boundary, no capability (mirrors `GET /api/settings`).\n",
    security: [{ deviceKeyCookie: [] }],
    response: {
      200: {
        description: "Always 200 — absence is expressed as `forecast: null`, never an error.",
        content: { "application/json": { schema: WeatherResponse } },
      },
      401: noContent("Missing/invalid API key."),
      429: authenticationBackoffResponse,
      503: {
        description: "The owning plugin is inactive or unavailable.",
        content: { "application/json": { schema: PluginUnavailable } },
      },
    },
  },
});
