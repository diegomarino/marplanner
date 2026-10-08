// ─────────────────────────────────────────────────────────────────────
// Structural-copy label map (P1):
// DAILY-BRIEFING-INV-06 — "Structural copy (labels/templates) always renders
// in the household language via keys (ADR-015)". ported several v1
// render-defs with hardcoded English structural strings (meals'
// Lunch/Snack/Dinner, on-this-day's Events/Births/Deaths, birthday's "No
// upcoming birthdays", weatherText's Min/Max/Rain, weather's condition
// labels, streak's single-letter weekday strip) — a v1-parity shortcut that
// silently violated INV-06 for an "es" household on PAPER (the print path
// has no client-side i18n layer to catch it). This is NOT a full i18n
// catalog (deliberately, per the fold instruction) — a small typed
// {es:{...}, en:{...}} map is exactly right for the ~10 structural strings
// the render layer owns, plus the two GENERATOR-emitted snapshot strings
// (streak's `label`, birthday's `ownLabel`) included here.
//
// Also consumed by the block GENERATORS (../blocks/streak.ts,
//../blocks/birthday.ts) — those stamp their `label`/`ownLabel` strings at
// GENERATION time (frozen into the snapshot per INV-01: the label freezes
// in the language of generation, which is correct), so `getLabels` is a
// plain, DB-free, pure lookup importable from either the render defs or the
// domain block generators (both live under this same plugin subtree).
// ─────────────────────────────────────────────────────────────────────
import type { RenderContext } from "pressedslip";
import type { WeatherConditionKey } from "../../../../shared";
import type { BlockRegistryType } from "../corpora/index";

export type HouseholdLanguage = "es" | "en";

/** Mirrors `settings.ts`'s `LOCALE_DEFAULTS.language` / `day-periods.ts`'s `DEFAULT_LOCALE.language`
 * — the same system-wide default every other "locale" settings-object reader in this codebase
 * falls back to. */
const DEFAULT_LANGUAGE: HouseholdLanguage = "en";

/** The 21 block types `index.ts#titleFor` (below, fold) stamps a server-side ordinal title
 * for at generation time. Derived (not duplicated —) from
 * `corpora/block-types.ts#ALL_BLOCK_TYPES`, the codebase's OWN documented "single source of
 * truth for 'known block type'" — a hand-maintained copy here would silently drift the day a
 * 22nd type is registered there (it would compile green and fall through to an unlocalized
 * English camelCase-split title, reintroducing exactly the bug fixes). `corpora/block-types
 *.ts` has no imports of its own, so this type-only import carries no runtime/circularity cost:
 * `index.ts` already imports `getLabels` (a value) from this module, and `corpora/index.ts`
 * never imports back from `render/`. */
export type DailyBriefingBlockType = BlockRegistryType;

export interface DailyBriefingLabels {
  meals: { lunch: string; snack: string; dinner: string };
  onThisDay: { events: string; births: string; deaths: string };
  birthday: {
    /** render/blocks/birthday.ts's empty-payload fallback line. */
    noUpcoming: string;
    /** blocks/birthday.ts generator: `ownLabel` when `daysUntil === 0`. */
    happyBirthday: string;
    /** blocks/birthday.ts generator: `ownLabel` when `daysUntil > 0`. */
    daysUntil: (days: number) => string;
  };
  weatherText: { min: string; max: string; rain: string };
  weather: { conditions: Record<WeatherConditionKey, string> };
  streak: {
    /** render/blocks/streak.ts's day-of-week strip, indexed like `Date#getUTCDay` (0 = Sunday). */
    dayLetters: readonly [string, string, string, string, string, string, string];
    /** blocks/streak.ts generator: `label` when `days === 0` (no leading digit — rendered as-is). */
    startToday: string;
    /** blocks/streak.ts generator: `label` when `days > 0` (leading digit — render/blocks/streak.ts
     * strips that leading number before display, so this template's leading `${days}` is REQUIRED
     * for that strip to have something to remove). */
    daysStrong: (days: number) => string;
  };
  /** `index.ts#titleFor`'s display name per block type (DAILY-BRIEFING-INV-06) — the
   * ordinal template ("NN " prefix) and full-order numbering-with-gaps stay in `index.ts`
   * unchanged; only this label text localizes. */
  titles: Record<DailyBriefingBlockType, string>;
}

const EN: DailyBriefingLabels = {
  meals: { lunch: "Lunch", snack: "Snack", dinner: "Dinner" },
  onThisDay: { events: "Events", births: "Births", deaths: "Deaths" },
  birthday: {
    noUpcoming: "No upcoming birthdays",
    happyBirthday: "HAPPY BIRTHDAY",
    daysUntil: (days) => `${days} days to your birthday`,
  },
  weatherText: { min: "Min", max: "Max", rain: "Rain" },
  // Exact uppercased mirror of `src/client/i18n/messages.ts`'s "weather.condition.*" en keys
  // (WEATHER-INV-06's shared condition table) — fenced by
  // `tests/client/weather-i18n-parity.test.ts`'s mirror-fence test ("unknown"
  // drifted from the catalog's "Weather unknown" before that fence existed).
  weather: {
    conditions: {
      clear: "CLEAR",
      mostlyClear: "MOSTLY CLEAR",
      partlyCloudy: "PARTLY CLOUDY",
      overcast: "OVERCAST",
      fog: "FOG",
      drizzle: "DRIZZLE",
      freezingDrizzle: "FREEZING DRIZZLE",
      rain: "RAIN",
      freezingRain: "FREEZING RAIN",
      snow: "SNOW",
      snowGrains: "SNOW GRAINS",
      rainShowers: "RAIN SHOWERS",
      snowShowers: "SNOW SHOWERS",
      thunderstorm: "THUNDERSTORM",
      thunderstormHail: "THUNDERSTORM WITH HAIL",
      unknown: "WEATHER UNKNOWN",
    },
  },
  streak: {
    dayLetters: ["S", "M", "T", "W", "T", "F", "S"],
    startToday: "Start your streak today!",
    daysStrong: (days) => `${days} days strong`,
  },
  // fold: identical to the PRE- `titleFor`'s own algorithmic output (a camelCase split,
  // uppercased, with 4 literal overrides) — v1-parity behavior is preserved exactly for "en",
  // only re-homed here as a lookup instead of computed. `quoteOfDay`/`wordOfDay`/`wordSearch`/
  // `wouldYouRather` are the 4 overrides.
  titles: {
    shotgun: "SHOTGUN",
    message: "MESSAGE",
    streak: "STREAK",
    today: "TODAY",
    weather: "WEATHER",
    meals: "MEALS",
    birthday: "BIRTHDAY",
    reminders: "REMINDERS",
    dadJoke: "DAD JOKE",
    wordOfDay: "WORD OF THE DAY",
    animalFact: "ANIMAL FACT",
    numberFact: "NUMBER FACT",
    onThisDay: "ON THIS DAY",
    quoteOfDay: "QUOTE OF THE DAY",
    trivia: "TRIVIA",
    riddle: "RIDDLE",
    wouldYouRather: "WOULD YOU RATHER...?",
    wordSearch: "WORD SEARCH",
    drawingPrompt: "DRAWING PROMPT",
    streakText: "STREAK TEXT",
    weatherText: "WEATHER TEXT",
  },
};

/** Mirrors `src/client/i18n/messages.ts`'s existing "meals.slot.*" es keys ("Comida"/"Merienda"/
 * "Cena") and "chores.board.streakLabel" ("Racha:") for household-vocabulary consistency; every
 * other string here has no existing client parallel (the per-type client renderers haven't
 * landed on this branch's base) and is a fresh, natural es translation. */
const ES: DailyBriefingLabels = {
  meals: { lunch: "Comida", snack: "Merienda", dinner: "Cena" },
  onThisDay: { events: "Sucesos", births: "Nacimientos", deaths: "Fallecimientos" },
  birthday: {
    noUpcoming: "No hay cumpleaños próximos",
    happyBirthday: "FELIZ CUMPLEAÑOS",
    daysUntil: (days) => `Faltan ${days} días para tu cumpleaños`,
  },
  weatherText: { min: "Mín", max: "Máx", rain: "Lluvia" },
  // Exact uppercased mirror of `src/client/i18n/messages.ts`'s "weather.condition.*" es keys —
  // see the `en` set's comment above for the fence that proves it.
  weather: {
    conditions: {
      clear: "DESPEJADO",
      mostlyClear: "MAYORMENTE DESPEJADO",
      partlyCloudy: "PARCIALMENTE NUBLADO",
      overcast: "NUBLADO",
      fog: "NIEBLA",
      drizzle: "LLOVIZNA",
      freezingDrizzle: "LLOVIZNA HELADA",
      rain: "LLUVIA",
      freezingRain: "LLUVIA HELADA",
      snow: "NIEVE",
      snowGrains: "NIEVE GRANULADA",
      rainShowers: "CHUBASCOS",
      snowShowers: "CHUBASCOS DE NIEVE",
      thunderstorm: "TORMENTA",
      thunderstormHail: "TORMENTA CON GRANIZO",
      unknown: "TIEMPO DESCONOCIDO",
    },
  },
  streak: {
    // Indexed like `Date#getUTCDay`: 0=domingo, 1=lunes, 2=martes, 3=miércoles, 4=jueves,
    // 5=viernes, 6=sábado.
    dayLetters: ["D", "L", "M", "X", "J", "V", "S"],
    startToday: "¡Empieza tu racha hoy!",
    daysStrong: (days) => `${days} días de racha`,
  },
  // fold: "weather"/"meals"/"reminders"/"streak" mirror `src/client/i18n/messages.ts`'s es
  // strings ("Meteorología", "Gestión de Comidas" -> "Comidas", "Gestión de Recordatorios" ->
  // "Recordatorios", `chores.board.streakLabel` "Racha:") for household-vocabulary consistency;
  // every other title here has no existing client parallel and is a fresh, natural es
  // translation. `wouldYouRather` keeps the same "...?" ellipsis-question override shape as en.
  titles: {
    shotgun: "COPILOTO",
    message: "MENSAJE",
    streak: "RACHA",
    today: "HOY",
    weather: "METEOROLOGÍA",
    meals: "COMIDAS",
    birthday: "CUMPLEAÑOS",
    reminders: "RECORDATORIOS",
    dadJoke: "CHISTE MALO",
    wordOfDay: "PALABRA DEL DÍA",
    animalFact: "DATO ANIMAL",
    numberFact: "DATO NUMÉRICO",
    onThisDay: "TAL DÍA COMO HOY",
    quoteOfDay: "CITA DEL DÍA",
    trivia: "TRIVIA",
    riddle: "ACERTIJO",
    wouldYouRather: "¿QUÉ PREFIERES...?",
    wordSearch: "SOPA DE LETRAS",
    drawingPrompt: "PROPUESTA DE DIBUJO",
    streakText: "RACHA TEXTO",
    weatherText: "METEOROLOGÍA TEXTO",
  },
};

const BY_LANGUAGE: Record<HouseholdLanguage, DailyBriefingLabels> = { en: EN, es: ES };

/** Resolve structural copy in the configured household language, or English when unset or
 * unsupported. A configured Spanish household keeps Spanish labels. */
export function getLabels(language: string | undefined): DailyBriefingLabels {
  if (language === "en" || language === "es") return BY_LANGUAGE[language];
  return BY_LANGUAGE[DEFAULT_LANGUAGE];
}

/** Convenience wrapper for pressedslip render-defs: reads the household language threaded through
 * `render/bridge.ts#buildComposition`'s `composition.meta.language` (set once per render from
 * `index.ts#renderAndPackBriefing`'s household-settings read) and resolves its label set. */
export function labelsFromCtx(ctx: RenderContext): DailyBriefingLabels {
  const meta = ctx.composition.meta as { language?: unknown } | undefined;
  const language = typeof meta?.language === "string" ? meta.language : undefined;
  return getLabels(language);
}
