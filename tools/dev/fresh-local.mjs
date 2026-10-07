#!/usr/bin/env node
/**
 * DEV-only: disposable local playground.
 * 1) Wipe/create a fresh DATA_DIR (default .data-fresh)
 * 2) Run public (generic) seed then private seed
 * 3) Start the coordinated API+Vite launcher on that store
 *
 * Does not touch the default .data playground unless DATA_DIR points there explicitly
 * with --force-data-dir.
 */
import { spawn } from "node:child_process";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { isAbsolute, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");

try {
  loadEnvFile(resolve(ROOT, ".env.local"));
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") throw error;
}

function usage() {
  return `Usage: node tools/dev/fresh-local.mjs [--data-dir <path>] [--force-data-dir]

Creates a disposable SQLite store, optionally syncs private seed overlays,
runs seed:public then seed:private, then starts npm run dev.


Default data dir: .data-fresh (under the project root).
Refuses to wipe .data unless --force-data-dir is passed with an explicit --data-dir .data.
`;
}

function parseArgs(argv) {
  let dataDir = process.env.MP_FRESH_DATA_DIR?.trim() || ".data-fresh";
  let forceDataDir = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--force-data-dir") {
      forceDataDir = true;
      continue;
    }
    if (arg.startsWith("--data-dir=")) {
      dataDir = arg.slice("--data-dir=".length);
      continue;
    }
    if (arg === "--data-dir") {
      const value = argv[++i];
      if (!value) throw new Error("--data-dir requires a path");
      dataDir = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { help: false, dataDir, forceDataDir };
}

function resolveDataDir(raw) {
  return isAbsolute(raw) ? raw : resolve(ROOT, raw);
}

function isDefaultPlayground(absPath) {
  return absPath === resolve(ROOT, ".data");
}

function run(command, args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) reject(new Error(`${command} ${args.join(" ")} killed by ${signal}`));
      else if (code !== 0) reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
      else resolvePromise();
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const dataDir = resolveDataDir(options.dataDir);
  if (isDefaultPlayground(dataDir) && !options.forceDataDir) {
    throw new Error(
      `Refusing to wipe the default playground ${dataDir}. Pass a disposable --data-dir or --force-data-dir with an explicit path.`
    );
  }

  if (existsSync(dataDir)) {
    console.log(`Removing disposable store: ${dataDir}`);
    rmSync(dataDir, { recursive: true, force: true });
  }
  mkdirSync(dataDir, { recursive: true });
  console.log(`Fresh DATA_DIR: ${dataDir}`);

  const env = {
    ...process.env,
    DATA_DIR: dataDir,
    // Keep relative DB name under DATA_DIR (same as .env.example).
    DATABASE_PATH: process.env.DATABASE_PATH ?? "marplanner.db",
  };
  console.log("Syncing private seed overlays (if any)…");
  try {
    await run("npm", ["run", "seed:sync-private"], env);
  } catch {
    console.log("No private seed source available; continuing with public seed only.");
  }
  console.log("Seeding public demo profile…");
  await run("npm", ["run", "seed:public"], env);
  console.log("Seeding private overlays…");
  await run("npm", ["run", "seed:private"], env);

  console.log("Starting local launcher…");

  const child = spawn("npm", ["run", "dev"], {
    cwd: ROOT,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  const shutdown = (signal) => {
    if (child.pid) child.kill(signal);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  const code = await new Promise((resolvePromise) => {
    child.on("exit", (exitCode, signal) => {
      if (signal) resolvePromise(1);
      else resolvePromise(exitCode ?? 1);
    });
  });
  process.exit(code);
}

main().catch((error) => {
  console.error(`dev:fresh failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
