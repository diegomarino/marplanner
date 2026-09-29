/** Raw Open-Meteo `/v1/forecast` JSON fixtures — the checked-in
 * "raw provider payload" driving `normalize.ts` in `tests/boundary/weather-forecast-port.test.ts`.
 * Field names mirror EXACTLY what `src/server/modules/weather/port.ts`'s `CURRENT_VARS` /
 * `HOURLY_VARS` / `DAILY_VARS` request (`temperature_2m`, `weather_code`,
 * `precipitation_probability`, `temperature_2m_max/min`, `precipitation_probability_max`).
 */

/** A healthy raw payload: current.time matches the first hourly entry (index-lookup path). */
export function healthyRawForecast(): unknown {
  return {
    latitude: 40.4,
    longitude: -3.7,
    timezone: "Europe/Madrid",
    current: {
      time: "2026-09-04T14:00",
      temperature_2m: 24.1,
      weather_code: 1,
    },
    hourly: {
      time: ["2026-09-04T14:00", "2026-09-04T15:00", "2026-09-04T16:00"],
      temperature_2m: [24.1, 24.8, 23.9],
      precipitation_probability: [12, 18, 30],
      weather_code: [1, 2, 61],
    },
    daily: {
      time: ["2026-09-04", "2026-09-05", "2026-09-06"],
      weather_code: [1, 61, 3],
      temperature_2m_max: [26.5, 22.0, 21.3],
      temperature_2m_min: [16.2, 15.8, 14.9],
      precipitation_probability_max: [20, 70, 40],
    },
  };
}

/** A realistic raw payload against the REAL Open-Meteo shape: `current.time` is snapped to a
 * 15-minute boundary ("2026-09-04T21:45") while `hourly.time` spans a full day on-the-hour
 * ("2026-09-04T00:00".."2026-09-04T23:00") — the exact mismatch that made the naive
 * `indexOf(current.time)` match miss ~3 of every 4 renders and silently fall back to
 * `hourly[0]` (midnight, review /). Hour 21's `precipitation_probability` (77) is
 * DELIBERATELY far from hour 0's (5) so a test asserting the hour-21 value fails loudly
 * against the old midnight-fallback code.
 */
export function quarterHourCurrentRawForecast(): unknown {
  const hours = Array.from({ length: 24 }, (_, h) => `2026-09-04T${String(h).padStart(2, "0")}:00`);
  // A simple, deterministic-but-varied series — hour 21 (index 21) = 77, hour 0 = 5.
  const rainByHour = hours.map((_, h) => (h === 21 ? 77 : h === 0 ? 5 : (h * 7) % 60));
  const tempByHour = hours.map((_, h) => 15 + h * 0.3);
  const codeByHour = hours.map(() => 1);

  return {
    latitude: 40.4,
    longitude: -3.7,
    timezone: "Europe/Madrid",
    current: {
      time: "2026-09-04T21:45",
      temperature_2m: 22.5,
      weather_code: 2,
    },
    hourly: {
      time: hours,
      temperature_2m: tempByHour,
      precipitation_probability: rainByHour,
      weather_code: codeByHour,
    },
    daily: {
      time: ["2026-09-04", "2026-09-05", "2026-09-06"],
      weather_code: [1, 61, 3],
      temperature_2m_max: [26.5, 22.0, 21.3],
      temperature_2m_min: [16.2, 15.8, 14.9],
      precipitation_probability_max: [20, 70, 40],
    },
  };
}

/** Raw payload missing the `daily` block entirely — the "missing-daily" failure mode. */
export function missingDailyRawForecast(): unknown {
  const raw = healthyRawForecast() as Record<string, unknown>;
  delete raw.daily;
  return raw;
}

/** Raw payload missing `hourly` — current.rainPct has nothing to derive from. */
export function missingHourlyRawForecast(): unknown {
  const raw = healthyRawForecast() as Record<string, unknown>;
  delete raw.hourly;
  return raw;
}

/** A payload that parses as JSON but isn't a weather shape at all (e.g. an error body). */
export function malformedRawForecast(): unknown {
  return { error: true, reason: "some upstream error" };
}

/** An unknown/out-of-table WMO code — must normalize to `"unknown"`, never throw. */
export function unknownConditionCodeRawForecast(): unknown {
  const raw = healthyRawForecast() as {
    current: Record<string, unknown>;
    hourly: { weather_code: number[] };
    daily: { weather_code: number[] };
  };
  raw.current.weather_code = 9999;
  raw.hourly.weather_code = [9999, 9999, 9999];
  raw.daily.weather_code = [9999, 9999, 9999];
  return raw;
}
