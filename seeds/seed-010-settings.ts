import type { SeedModule } from "../src/server/db/seeds/types";
import { writeSettingsObject } from "../src/server/modules/settings";
import { DEFAULT_PRINTER_SETTINGS } from "../src/shared/printing";

const settingsSeed: SeedModule = {
  id: "public:settings",
  run({ db }) {
    writeSettingsObject(
      "locale",
      { timezone: "Europe/Madrid", language: "en", weekStartDay: 1 },
      db
    );
    writeSettingsObject("weather", { lat: 39.7817, lon: -89.6501, label: "Springfield" }, db);
    writeSettingsObject("printer", DEFAULT_PRINTER_SETTINGS, db);
  },
};

export default settingsSeed;
