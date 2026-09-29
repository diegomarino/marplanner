import { stopWeatherFixtureServer } from "./weather-fixture-server";
import { stopQuoteOnThisDayFixtureServer } from "./quote-onthisday-fixture-server";
import { cleanupE2eDataDir } from "../../tools/e2e-data-dir.mjs";

/** docs/features/weather.md — pairs with `global-setup.ts`: stops the weather fixture
 * provider once the whole e2e run finishes.
 * pairs with the quote/onThisDay fixture provider started there too.
 */
export default async function globalTeardown(): Promise<void> {
  try {
    await stopWeatherFixtureServer();
    await stopQuoteOnThisDayFixtureServer();
  } finally {
    const ownedDataDir = process.env.MP_E2E_OWNED_DATA_DIR;
    if (ownedDataDir) {
      cleanupE2eDataDir({ dataDir: ownedDataDir, owned: true });
    }
  }
}
