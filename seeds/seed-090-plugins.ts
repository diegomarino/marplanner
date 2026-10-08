import { PLUGIN_IDS } from "../src/shared/plugins";
import type { SeedModule } from "../src/server/db/seeds/types";
import { createServerPluginLifecycle } from "../src/server/plugins/http";

const pluginsSeed: SeedModule = {
  id: "plugins:demo",
  async run() {
    const lifecycle = createServerPluginLifecycle();
    for (const pluginId of PLUGIN_IDS) {
      await lifecycle.activate(pluginId);
    }
  },
};

export default pluginsSeed;
