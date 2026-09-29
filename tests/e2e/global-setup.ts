import { startWeatherFixtureServer } from "./weather-fixture-server";
import { startQuoteOnThisDayFixtureServer } from "./quote-onthisday-fixture-server";

/** docs/features/weather.md — repo-FIRST Playwright `globalSetup`:
 * starts the local weather fixture provider once for the whole e2e run, before any spec
 * file runs. Paired with `global-teardown.ts`. See `weather-fixture-server.ts` for why the
 * port is a fixed constant rather than an OS-assigned ephemeral one.
 * the quote/onThisDay fixture provider follows the SAME rationale (started here, before
 * `webServer`'s `npm start` boots, so `QUOTE_ENDPOINT`/`ONTHISDAY_ENDPOINT` in
 * `playwright.config.ts`'s `webServer.env` already point somewhere live).
 */
export default async function globalSetup(): Promise<void> {
  await startWeatherFixtureServer();
  await startQuoteOnThisDayFixtureServer();
}
