import { describe, expect, it } from "vitest";
import { messages } from "@/i18n/messages";
import { WMO_CONDITION_MAP } from "../../src/shared/weather";
import type { WeatherConditionKey } from "../../src/shared/weather";
// Tests MAY cross the client/server boundary — the daily-briefing PRINT path hand-mirrors
// messages.ts's "weather.condition.*" strings (uppercased) into its own `render/labels.ts` map
// (it cannot import the client i18n catalog at runtime — the print path has no client-side i18n
// layer), so this is the fence that reds when the server's copy drifts from the client's source
// of truth (same "hand-mirror + fence test" shape as
// `tests/client/daily-briefing-admin-mirror-fence.test.tsx`).
import { getLabels } from "../../src/server/modules/daily-briefing/render/labels";

/** — weather i18n parity (per-domain template, see e.g.
 * `tests/client/time-announcements-i18n-parity.test.ts`).
 * Locks en/es catalog parity for every `weather.*` key: both locales must define the exact
 * same key set, and every value must be a non-empty string. Also asserts every
 * `WeatherConditionKey` the shared closed union can produce (`src/shared/weather.ts`)
 * has a `weather.condition.<key>` translation in BOTH languages — the union is closed, so
 * "unknown" must be covered too (a WMO code the table doesn't recognize still renders
 * localized text, never raw English/a crash).
 * (Traces: WEATHER-AC-07, WEATHER-INV-08 — panel half; I18N-LOCALIZATION-INV-11)
 */
describe("weather-i18n-parity", () => {
  const isWeatherKey = (key: string) => key.startsWith("weather.");

  it("en and es catalogs have identical keys (both directions)", () => {
    const enKeys = Object.keys(messages.en);
    const esKeys = Object.keys(messages.es);

    expect(enKeys).toHaveLength(esKeys.length);
    for (const key of enKeys) expect(esKeys).toContain(key);
    for (const key of esKeys) expect(enKeys).toContain(key);
  });

  it("weather.* keys have identical coverage in en and es (both directions, non-vacuous)", () => {
    const enKeys = Object.keys(messages.en).filter(isWeatherKey);
    const esKeys = Object.keys(messages.es).filter(isWeatherKey);

    expect(enKeys.length).toBeGreaterThan(0);
    expect(enKeys).toHaveLength(esKeys.length);

    for (const key of enKeys) expect(esKeys).toContain(key);
    for (const key of esKeys) expect(enKeys).toContain(key);
  });

  it("weather.* keys resolve to a non-empty string in both languages", () => {
    const enKeys = Object.keys(messages.en).filter(isWeatherKey);

    for (const key of enKeys) {
      const enValue = messages.en[key as keyof typeof messages.en];
      const esValue = messages.es[key as keyof typeof messages.es];

      expect(typeof enValue).toBe("string");
      expect(typeof esValue).toBe("string");
      expect((enValue as string).length).toBeGreaterThan(0);
      expect((esValue as string).length).toBeGreaterThan(0);
    }
  });

  it("every WeatherConditionKey the WMO map can produce has a weather.condition.<key> translation, both languages", () => {
    const producedKeys = new Set<string>([...Object.values(WMO_CONDITION_MAP), "unknown"]);

    for (const conditionKey of producedKeys) {
      const messageKey = `weather.condition.${conditionKey}` as keyof typeof messages.en;
      expect(messages.en[messageKey]).toBeTruthy();
      expect(messages.es[messageKey]).toBeTruthy();
    }
  });

  it("admin.nav.weather resolves in both languages (exact strings, per admin-nav-i18n-parity precedent)", () => {
    expect(messages.en["admin.nav.weather"]).toBe("Weather");
    expect(messages.es["admin.nav.weather"]).toBe("Meteorología");
  });

  // /: `render/labels.ts`'s `weather.conditions` map claims (in its own
  // comment) to mirror this catalog's "weather.condition.*" values uppercased — this fence
  // proves it, for all 16 `WeatherConditionKey`s in both languages, so a future edit to either
  // side reds instead of silently drifting (the "unknown" key drifted exactly this way before
  // this fold: labels.ts had "UNKNOWN"/"DESCONOCIDO" against the catalog's "WEATHER UNKNOWN"/
  // "TIEMPO DESCONOCIDO").
  it("render/labels.ts's weather.conditions is an exact uppercased mirror of weather.condition.*, all 16 keys, both languages", () => {
    const conditionKeys = [
      ...new Set<WeatherConditionKey>([...Object.values(WMO_CONDITION_MAP), "unknown"]),
    ];
    expect(conditionKeys).toHaveLength(16);

    for (const language of ["en", "es"] as const) {
      const catalog = messages[language];
      const labels = getLabels(language);
      for (const key of conditionKeys) {
        const messageKey = `weather.condition.${key}` as keyof typeof catalog;
        const expected = (catalog[messageKey] as string).toUpperCase();
        expect(labels.weather.conditions[key], `${language}.${key}`).toBe(expected);
      }
    }
  });
});
