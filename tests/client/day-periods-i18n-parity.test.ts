import { describe, expect, it } from "vitest";
import { messages } from "@/i18n/messages";

describe("day-periods-i18n-parity", () => {
  it("en and es catalogs have identical keys (both directions)", () => {
    const enKeys = Object.keys(messages.en);
    const esKeys = Object.keys(messages.es);

    expect(enKeys).toHaveLength(esKeys.length);

    for (const key of enKeys) {
      expect(esKeys).toContain(key);
    }

    for (const key of esKeys) {
      expect(enKeys).toContain(key);
    }
  });

  it("four dayPeriod label keys resolve in both languages", () => {
    expect(messages.en["dayPeriod.morning"]).toBe("Morning");
    expect(messages.en["dayPeriod.afternoon"]).toBe("Afternoon");
    expect(messages.en["dayPeriod.evening"]).toBe("Evening");
    expect(messages.en["dayPeriod.night"]).toBe("Night");

    expect(messages.es["dayPeriod.morning"]).toBe("Mañana");
    expect(messages.es["dayPeriod.afternoon"]).toBe("Mediodía");
    expect(messages.es["dayPeriod.evening"]).toBe("Tarde");
    expect(messages.es["dayPeriod.night"]).toBe("Noche");
  });
});

it("shared day period labels resolve without importing a feature view", async () => {
  const { DAY_PERIOD_LABEL_KEYS } = await import("@/lib/day-period-labels");
  expect(Object.values(DAY_PERIOD_LABEL_KEYS).map((key) => messages.en[key])).toEqual([
    "Morning",
    "Afternoon",
    "Evening",
    "Night",
  ]);
});
