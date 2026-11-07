/** Which Weather Icon draws each condition key, shared by the client (home pill, forecast dialog,
 * on-screen briefing) and the server's printed briefing so every surface shows the same glyph.
 * `night` is set only where the day icon shows the sun, so it has a moon counterpart. Colour is
 * the client's business (`src/client/home/WeatherIcon.tsx`); the print is black.
 */
import type { WeatherConditionKey } from "../weather.js";
import type { WeatherIconName } from "./paths.js";

export const WEATHER_CONDITION_ICONS: Record<
  WeatherConditionKey,
  { day: WeatherIconName; night?: WeatherIconName }
> = {
  clear: { day: "wi-day-sunny", night: "wi-night-clear" },
  mostlyClear: { day: "wi-day-sunny-overcast", night: "wi-night-alt-partly-cloudy" },
  partlyCloudy: { day: "wi-day-cloudy", night: "wi-night-alt-cloudy" },
  overcast: { day: "wi-cloudy" },
  fog: { day: "wi-fog" },
  drizzle: { day: "wi-sprinkle" },
  freezingDrizzle: { day: "wi-rain-mix" },
  rain: { day: "wi-rain" },
  freezingRain: { day: "wi-sleet" },
  snow: { day: "wi-snow" },
  snowGrains: { day: "wi-snowflake-cold" },
  rainShowers: { day: "wi-day-showers", night: "wi-night-alt-showers" },
  snowShowers: { day: "wi-snow-wind" },
  thunderstorm: { day: "wi-thunderstorm" },
  thunderstormHail: { day: "wi-hail" },
  unknown: { day: "wi-na" },
};

/** The icon for a condition. `isDay === false` selects the moon variant where one exists; an
 * unknown day/night state (or a whole-day forecast) reads as day.
 */
export function weatherConditionIconName(
  conditionKey: WeatherConditionKey,
  isDay?: boolean
): WeatherIconName {
  const icon = WEATHER_CONDITION_ICONS[conditionKey];
  return isDay === false && icon.night ? icon.night : icon.day;
}
