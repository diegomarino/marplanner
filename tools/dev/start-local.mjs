import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import {
  formatLocalReadyBanner,
  formatSeedWarning,
  inspectLocalSeedStatus,
  resolveCdpPort,
  resolveDatabaseFile,
  writeLocalReady,
} from "./chrome-dev-shared.mjs";


try {
  loadEnvFile(".env.local");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

function port(name) {
  const value = process.env[name] ?? "0";
  if (!/^\d+$/.test(value) || Number(value) > 65535)
    throw new Error(`${name} must be an integer from 0 to 65535`);
  return Number(value);
}
let child;
let vite;
let stopping = false;
let api;
const proxies = new Map();
let readyTimer;
let resolveReady;
let rejectReady;
const ready = new Promise((done, fail) => {
  resolveReady = done;
  rejectReady = fail;
});
// Startup rejection can precede the await while Vite is being imported.
ready.catch(() => {});

async function stop(code) {
  if (stopping) return;
  stopping = true;
  clearTimeout(readyTimer);
  try {
    await vite?.close();
  } catch {
    console.error("Local development failed: Frontend shutdown failed");
    code = 1;
  }
  if (child?.pid) {
    // The watch leader can die first; its descendants still own the process group.
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") code = 1;
    }
    const deadline = Date.now() + 7000;
    while (true) {
      try {
        process.kill(-child.pid, 0);
      } catch (error) {
        if (error.code !== "ESRCH") code = 1;
        break;
      }
      if (Date.now() >= deadline) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The owned group may disappear between the probe and signal.
        }
        console.error("Local development failed: API shutdown timed out");
        code = 1;
        break;
      }
      await new Promise((done) => setTimeout(done, 25));
    }
  }
  process.exit(code);
}
function fail(message) {
  if (stopping) return;
  console.error(`Local development failed: ${message}`);
  rejectReady(new Error(message));
  void stop(1);
}
function armTimeout() {
  clearTimeout(readyTimer);
  readyTimer = setTimeout(
    () => fail("API readiness timed out"),
    Number(process.env.MP_LOCAL_READY_TIMEOUT_MS ?? 30000)
  );
}
process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));

try {
  const apiPort = port("PORT");
  const webPort = port("WEB_PORT");
  const host = process.env.HOST ?? "127.0.0.1";
  if (apiPort && apiPort === webPort) throw new Error("PORT and WEB_PORT must be different");
  armTimeout();
  child = spawn(process.execPath, ["--import", "tsx", "--watch", "src/server/index.ts"], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: host,
      PORT: String(apiPort),
      DATA_DIR: process.env.DATA_DIR ?? resolve(".data"),
      MP_LOCAL_READINESS: "1",
    },
  });
  child.on("error", () => fail("API process could not start"));
  child.on("exit", () => fail("API process exited"));
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on("line", (line) => {
      // Forward only the protocol, never arbitrary application logs or credentials.
      if (line.startsWith("MP_LOCAL_READY ")) {
        let event;
        try {
          event = JSON.parse(line.slice("MP_LOCAL_READY ".length));
        } catch {
          fail("Invalid API readiness signal");
          return;
        }
        if (!event || (event.type !== "stopping" && event.type !== "ready")) {
          fail("Invalid API readiness signal");
          return;
        }
        if (event.type === "stopping") {
          api = undefined;
          armTimeout();
          return;
        }
        if (
          event.type !== "ready" ||
          !Number.isInteger(event.port) ||
          event.port < 1 ||
          event.port > 65535
        ) {
          fail("Invalid API readiness signal");
          return;
        }
        clearTimeout(readyTimer);
        api = `http://${host.includes(":") ? `[${host}]` : host}:${event.port}`;
        for (const proxy of proxies.values()) proxy.options.target = api;
        console.log(`API: ${api}`);
        console.log(JSON.stringify({ type: "api-ready", api }));
        resolveReady();
      } else if (line.startsWith("Failed to start server:")) {
        const detail = line.slice("Failed to start server:".length).trim();
        fail(
          detail
            ? `API startup failed: ${detail}`
            : "API startup failed; run npm run dev:server for diagnostics"
        );
      } else if (line.includes("Failed running")) {
        fail("API startup failed; run npm run dev:server for diagnostics");
      }
    });
  }
  await ready;
  process.env.VITE_API_PORT = new URL(api).port;
  const { createServer, createLogger } = await import("vite");
  const proxyOptions = {
    target: api,
    bypass(_req, res) {
      if (!api) {
        res.writeHead(503).end("API restarting");
        return "";
      }
    },
  };
  const options = {
    host,
    port: webPort,
    strictPort: true,
    open: process.argv.includes("--open"),
    // Defense in depth with vite.config.ts: Chrome profile + SQLite under DATA_DIR
    // must not trigger full-page reloads while the CDP browser is active.
    watch: {
      ignored: ["**/.data/**", "**/chrome-cdp/**", "**/*.db", "**/*.db-*"],
    },
    proxy: Object.fromEntries(
      ["/api", "/health", "/gate"].map((path) => [
        path,
        {
          ...proxyOptions,
          configure(instance) {
            proxies.set(path, instance);
            instance.options.target = api;
          },
        },
      ])
    ),
  };
  const logger = createLogger();
  const logError = logger.error.bind(logger);
  logger.error = (message, details) => {
    logError(message, details);
    if (message.includes("server restart failed")) fail("Frontend restart failed");
  };

  vite = await createServer({ server: options, customLogger: logger });
  await vite.listen();
  const address = vite.httpServer.address();
  // Vite reuses this inline configuration on config/env reloads: retain the real origin.
  options.port = address.port;
  vite.config.server.port = address.port;
  const frontend = `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`;
  let cdpPort = null;
  try {
    cdpPort = resolveCdpPort();
  } catch {
    cdpPort = null;
  }
  writeLocalReady({ api, frontend, cdpPort }, process.env.DATA_DIR ?? resolve(".data"));
  for (const line of formatLocalReadyBanner({ api, frontend, cdpPort })) {
    console.log(line);
  }
  const seedWarning = formatSeedWarning(
    inspectLocalSeedStatus(
      resolveDatabaseFile()
    )
  );
  if (seedWarning) {
    console.warn(seedWarning);
    console.log(JSON.stringify({ type: "seed-warning", message: seedWarning }));
  }
  console.log(JSON.stringify({ type: "local-ready", api, frontend, cdpPort }));
} catch (error) {
  fail(error.message);
}
