import { cn } from "@/lib/utils";
import type { WeatherConditionKey } from "../../shared";
import { WEATHER_ICON_PATHS, type WeatherIconName } from "../../shared/weather-icons/paths";
import { weatherConditionIconName } from "../../shared/weather-icons/conditionIcons";

type WeatherTone = "sun" | "rain" | "frost" | "storm" | "cloud";

/** Colour tone per condition key, shared by the pill, the forecast dialog and the on-screen
 * briefing. Which icon each key draws lives in `src/shared/weather-icons/conditionIcons.ts`, so
 * the printed briefing (black, no tone) draws the same glyph.
 */
const CONDITION_TONES: Record<WeatherConditionKey, WeatherTone> = {
  clear: "sun",
  mostlyClear: "sun",
  partlyCloudy: "sun",
  overcast: "cloud",
  fog: "cloud",
  drizzle: "rain",
  freezingDrizzle: "frost",
  rain: "rain",
  freezingRain: "frost",
  snow: "frost",
  snowGrains: "frost",
  rainShowers: "rain",
  snowShowers: "frost",
  thunderstorm: "storm",
  thunderstormHail: "storm",
  unknown: "cloud",
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
  return (
    <WeatherGlyph
      name={weatherConditionIconName(conditionKey, isDay)}
      className={cn(toneClassName(CONDITION_TONES[conditionKey]), className)}
    />
  );
}
