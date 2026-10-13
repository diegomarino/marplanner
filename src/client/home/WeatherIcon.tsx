import { cn } from "@/lib/utils";
import type { WeatherConditionKey } from "../../shared";
import { WEATHER_ICON_PATHS, type WeatherIconName } from "./weather-icons/paths";

type WeatherTone = "sun" | "rain" | "frost" | "storm" | "cloud";

/** One icon per condition key, shared by the pill and the forecast dialog. `night` is set only
 * where the icon itself shows the sun, so it has a moon counterpart.
 */
const CONDITION_ICONS: Record<
  WeatherConditionKey,
  { day: WeatherIconName; night?: WeatherIconName; tone: WeatherTone }
> = {
  clear: { day: "wi-day-sunny", night: "wi-night-clear", tone: "sun" },
  mostlyClear: { day: "wi-day-sunny-overcast", night: "wi-night-alt-partly-cloudy", tone: "sun" },
  partlyCloudy: { day: "wi-day-cloudy", night: "wi-night-alt-cloudy", tone: "sun" },
  overcast: { day: "wi-cloudy", tone: "cloud" },
  fog: { day: "wi-fog", tone: "cloud" },
  drizzle: { day: "wi-sprinkle", tone: "rain" },
  freezingDrizzle: { day: "wi-rain-mix", tone: "frost" },
  rain: { day: "wi-rain", tone: "rain" },
  freezingRain: { day: "wi-sleet", tone: "frost" },
  snow: { day: "wi-snow", tone: "frost" },
  snowGrains: { day: "wi-snowflake-cold", tone: "frost" },
  rainShowers: { day: "wi-day-showers", night: "wi-night-alt-showers", tone: "rain" },
  snowShowers: { day: "wi-snow-wind", tone: "frost" },
  thunderstorm: { day: "wi-thunderstorm", tone: "storm" },
  thunderstormHail: { day: "wi-hail", tone: "storm" },
  unknown: { day: "wi-na", tone: "cloud" },
};

function toneClassName(tone: WeatherTone): string {
  switch (tone) {
    case "sun":
      return "text-weather-sun";
    case "rain":
      return "text-weather-rain";
    case "frost":
      return "text-weather-frost";
    case "storm":
      return "text-weather-storm";
    case "cloud":
      return "text-weather-cloud";
  }
}

/** A decorative glyph sized by the surrounding font size; the caller supplies the text label. */
export function WeatherGlyph({
  name,
  className,
}: {
  name: WeatherIconName;
  className?: string;
}): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 30 30"
      aria-hidden="true"
      focusable="false"
      data-weather-icon={name}
      className={cn("size-[1em] shrink-0 fill-current", className)}
    >
      <path d={WEATHER_ICON_PATHS[name]} />
    </svg>
  );
}

/** Condition icon, tinted by kind of weather. `isDay === false` selects the moon variant;
 * an unknown day/night state reads as day.
 */
export function WeatherConditionIcon({
  conditionKey,
  isDay,
  className,
}: {
  conditionKey: WeatherConditionKey;
  isDay?: boolean;
  className?: string;
}): React.JSX.Element {
  const icon = CONDITION_ICONS[conditionKey];
  const name = isDay === false && icon.night ? icon.night : icon.day;
  return <WeatherGlyph name={name} className={cn(toneClassName(icon.tone), className)} />;
}
