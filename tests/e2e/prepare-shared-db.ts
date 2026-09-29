import { prepareActivePlugins } from "./plugin-fixture-db";

const dataDir = process.env.DATA_DIR;
if (!dataDir) throw new Error("Playwright shared DATA_DIR is required");

prepareActivePlugins(dataDir);
