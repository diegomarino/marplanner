#!/usr/bin/env node
/**
 * Run public then private seed profiles, forwarding every CLI argument to both.
 *
 * Nested `npm run A && npm run B` cannot forward `npm run seed -- --as-of …`
 * correctly (npm appends extras only to the final command and may treat flags
 * as npm config). This wrapper is the seed / seed:all entry so operator flags
 * reach both modes, and a second `--mode` collides with the baked-in mode.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const CLI = resolve(ROOT, "src/server/db/seeds/cli.ts");
const extraArgs = process.argv.slice(2);

function runMode(mode) {
  const result = spawnSync(
    process.execPath,
    ["--env-file-if-exists=.env.local", "--import", "tsx", CLI, "--mode", mode, ...extraArgs],
    {
      cwd: ROOT,
      env: process.env,
      stdio: "inherit",
    }
  );
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

runMode("public");
runMode("private");
