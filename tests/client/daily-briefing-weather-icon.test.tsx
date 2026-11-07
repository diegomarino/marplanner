import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { WeatherBlock, WeatherTextBlock } from "@/daily-briefing/blockRenderers";
import { LanguageProvider } from "@/i18n";
import type { ForecastDay } from "../../src/shared";

afterEach(cleanup);

const STORM: ForecastDay = {
  date: "2026-11-09",
  conditionKey: "thunderstorm",
  tempMinC: 9,
  tempMaxC: 17,
  rainPct: 80,
};

/** The on-screen weather block leads with the condition's Weather Icon, decorative: the
 * condition label stays the text that names it. */
it("renders the condition icon before the text, hidden from assistive tech", () => {
  render(
    <LanguageProvider>
      <WeatherBlock data={STORM} />
    </LanguageProvider>
  );

  const block = screen.getByText(/Thunderstorm/).closest("p")!;
  const icon = block.querySelector("svg");
  expect(icon).not.toBeNull();
  expect(icon).toHaveAttribute("data-weather-icon", "wi-thunderstorm");
  expect(icon).toHaveAttribute("aria-hidden", "true");
  expect(block.firstElementChild).toBe(icon);
  expect(screen.queryByRole("img")).toBeNull();
});

/** `weatherText` is the text-variant twin (FR-023 Clarifications): same text, no icon. */
it("renders weatherText as text only", () => {
  const { container } = render(
    <LanguageProvider>
      <WeatherTextBlock data={STORM} />
    </LanguageProvider>
  );

  expect(container).toHaveTextContent("Thunderstorm");
  expect(container).toHaveTextContent("80%");
  expect(container.querySelector("svg")).toBeNull();
});
