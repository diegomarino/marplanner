import { loadEnvFile } from "node:process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";

const ROOT = resolve(import.meta.dirname, "../..");

export const DENSITY_STORAGE_KEY = "marplanner:density";
export const COMFORTABLE_DENSITY = "comfortable";
export const KIOSK_DENSITY = "kiosk";
export const LOCAL_READY_FILE = "local-ready.json";
export const DEFAULT_CDP_PORT = 9222;

/** Load `.env.local` once for CLI tooling. Exported env wins. */
export function loadProjectEnv(cwd = ROOT) {
  try {
    loadEnvFile(resolve(cwd, ".env.local"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT")
      throw error;
  }
}

export function projectRoot() {
  return ROOT;
}

export function resolveDataDir(cwd = ROOT) {
  const raw = process.env.DATA_DIR ?? ".data";
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

export function localReadyPath(dataDir = resolveDataDir()) {
  return resolve(dataDir, LOCAL_READY_FILE);
}

/** Resolve the SQLite file the local API uses (`DATA_DIR` + `DATABASE_PATH`). */
export function resolveDatabaseFile(cwd = ROOT) {
  const file = process.env.DATABASE_PATH ?? "marplanner.db";
  if (isAbsolute(file)) return file;
  return resolve(resolveDataDir(cwd), file);
}

/**
 * @param {string} value
 * @param {string} name
 */
export function parsePort(value, name) {
  if (value == null || value === "") return null;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  return Number(value);
}

export function resolveCdpPort() {
  return parsePort(process.env.CHROME_CDP_PORT ?? String(DEFAULT_CDP_PORT), "CHROME_CDP_PORT");
}

export function resolveChromeUserDataDir(cwd = ROOT) {
  const raw = process.env.CHROME_USER_DATA_DIR ?? ".data/chrome-cdp";
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

/** macOS / Linux Chrome binary discovery. `CHROME_BIN` wins. */
export function resolveChromeBin() {
  if (process.env.CHROME_BIN?.trim()) return process.env.CHROME_BIN.trim();
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Chrome binary not found. Set CHROME_BIN to a Chromium-based browser path.");
}

/**
 * @param {{ api: string, frontend: string, cdpPort?: number | null }} ready
 * @param {string} [dataDir]
 */
export function writeLocalReady(ready, dataDir = resolveDataDir()) {
  mkdirSync(dataDir, { recursive: true });
  const payload = {
    type: "local-ready",
    api: ready.api,
    frontend: ready.frontend,
    cdpPort: ready.cdpPort ?? null,
    writtenAt: new Date().toISOString(),
  };
  writeFileSync(localReadyPath(dataDir), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

/**
 * @param {string} [dataDir]
 * @returns {{ type: string, api: string, frontend: string, cdpPort: number | null } | null}
 */
export function readLocalReady(dataDir = resolveDataDir()) {
  const path = localReadyPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (
      !parsed ||
      parsed.type !== "local-ready" ||
      typeof parsed.api !== "string" ||
      typeof parsed.frontend !== "string"
    ) {
      return null;
    }
    return {
      type: "local-ready",
      api: parsed.api,
      frontend: parsed.frontend,
      cdpPort: Number.isInteger(parsed.cdpPort) ? parsed.cdpPort : null,
    };
  } catch {
    return null;
  }
}

/**
 * Read-only seed profile probe for local DX warnings. Never migrates or locks ownership.
 * @param {string} [dbPath]
 * @returns {{ kind: "missing-db" | "unseeded" | "dirty-unseeded" | "incomplete" | "complete" | "unreadable", dbPath: string, profile?: string, status?: string, asOfDate?: string, message?: string }}
 */
export function inspectLocalSeedStatus(dbPath = resolveDatabaseFile()) {
  if (!existsSync(dbPath)) return { kind: "missing-db", dbPath };
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 1000 });
  } catch (error) {
    return {
      kind: "unreadable",
      dbPath,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    const row = db
      .prepare("SELECT profile, status, as_of_date AS asOfDate FROM seed_profile_state LIMIT 1")
      .get();
    if (!row) {
      let dirty = false;
      try {
        const admin = db.prepare("SELECT 1 AS ok FROM admin_config LIMIT 1").get();
        dirty = Boolean(admin);
      } catch {
        dirty = false;
      }
      return { kind: dirty ? "dirty-unseeded" : "unseeded", dbPath };
    }
    if (row.status === "complete") {
      return {
        kind: "complete",
        dbPath,
        profile: String(row.profile),
        status: "complete",
        asOfDate: String(row.asOfDate),
      };
    }
    return {
      kind: "incomplete",
      dbPath,
      profile: String(row.profile),
      status: String(row.status),
      asOfDate: String(row.asOfDate),
    };
  } catch (error) {
    return {
      kind: "unreadable",
      dbPath,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db.close();
  }
}

/**
 * @param {ReturnType<typeof inspectLocalSeedStatus>} status
 * @returns {string | null}
 */
export function formatSeedWarning(status) {
  if (status.kind === "complete") return null;
  if (status.kind === "missing-db") {
    return `WARNING: database file missing (${status.dbPath}). After first boot run: npm run seed`;
  }
  if (status.kind === "unseeded") {
    return `WARNING: no completed seed profile in ${status.dbPath}. Demo household data is absent; run: npm run seed`;
  }
  if (status.kind === "dirty-unseeded") {
    return `WARNING: ${status.dbPath} has non-demo rows (e.g. provisioned admin_config) and no seed profile. npm run seed will refuse this store; use a fresh DATA_DIR or replace .data for demo seed`;
  }
  if (status.kind === "incomplete") {
    return `WARNING: seed profile incomplete (status=${status.status}) in ${status.dbPath}. Re-run: npm run seed`;
  }
  return `WARNING: could not read seed status${status.message ? ` (${status.message})` : ""}. If the household looks empty, run: npm run seed`;
}

/**
 * @param {number} port
 * @param {number} [timeoutMs]
 */
export async function waitForCdp(port, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < end) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) {
        const body = await response.json();
        if (body && typeof body.webSocketDebuggerUrl === "string") return body;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  const detail = lastError instanceof Error ? lastError.message : "no CDP response";
  throw new Error(`Chrome CDP did not become ready on port ${port} (${detail})`);
}

/**
 * @param {number} port
 */
export async function isCdpReachable(port) {
  try {
    await waitForCdp(port, 400);
    return true;
  } catch {
    return false;
  }
}

/**
 * Launch a dedicated Chromium profile with a fixed debugging port, or reuse it.
 * @param {{ port: number, userDataDir: string, bin?: string, url?: string }} opts
 */
export async function ensureChromeCdp(opts) {
  const bin = opts.bin ?? resolveChromeBin();
  mkdirSync(opts.userDataDir, { recursive: true });
  if (await isCdpReachable(opts.port)) {
    return { reused: true, port: opts.port };
  }
  const args = [
    `--remote-debugging-port=${opts.port}`,
    `--user-data-dir=${opts.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
  ];
  if (opts.url) args.push(opts.url);
  const child = spawn(bin, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  await waitForCdp(opts.port);
  return { reused: false, port: opts.port, pid: child.pid ?? null };
}

/**
 * Connect target for session helpers: reuse CDP if up, otherwise launch the worktree profile.
 * @param {{ url?: string }} [opts]
 */
export async function ensureDevChrome(opts = {}) {
  const port = resolveCdpPort();
  if (port == null) throw new Error("CHROME_CDP_PORT is required");
  const userDataDir = resolveChromeUserDataDir();
  if (await isCdpReachable(port)) {
    return { reused: true, port, userDataDir };
  }
  console.log(`Chrome CDP not running on ${port}; launching worktree profile…`);
  const launched = await ensureChromeCdp({
    port,
    userDataDir,
    bin: resolveChromeBin(),
    url: opts.url,
  });
  return { ...launched, userDataDir };
}

/**
 * Human + machine banner lines for the local launcher.
 * @param {{ api: string, frontend: string, cdpPort?: number | null }} ready
 */
export function formatLocalReadyBanner(ready) {
  const lines = [`API:      ${ready.api}`, `Frontend: ${ready.frontend}`];
  if (ready.cdpPort) {
    lines.push(`CDP:      ${ready.cdpPort}  (auto-launched by session helpers if needed)`);
    lines.push("Session:  npm run dev:session | npm run dev:session-reset");
  } else {
    lines.push("CDP:      unset (set CHROME_CDP_PORT in .env.local for dev browser tooling)");
  }
  return lines;
}

/**
 * Resolve the frontend origin for session helpers.
 * Priority: --origin CLI, FRONTEND_URL env, local-ready.json under DATA_DIR.
 * @param {string[]} argv
 */
export function resolveFrontendOrigin(argv = process.argv.slice(2), dataDir = resolveDataDir()) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--origin=")) return arg.slice("--origin=".length);
    if (arg === "--origin") {
      const value = argv[i + 1];
      if (!value) throw new Error("--origin requires a URL");
      return value;
    }
  }
  if (process.env.FRONTEND_URL?.trim()) return process.env.FRONTEND_URL.trim();
  const ready = readLocalReady(dataDir);
  if (ready?.frontend) return ready.frontend;
  throw new Error(
    "Frontend origin unknown. Pass --origin, set FRONTEND_URL, or run npm run dev first (writes .data/local-ready.json)."
  );
}

/**
 * Fail fast when local-ready.json / FRONTEND_URL points at a dead listener.
 * Common after an orphaned API left behind when the Vite parent exited uncleanly.
 * @param {string} origin
 * @param {number} [timeoutMs]
 */
export async function assertFrontendReachable(origin, timeoutMs = 2000) {
  try {
    await fetch(origin, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Frontend not reachable at ${origin} (${detail}). Run npm run dev first; if storage is owned, stop the orphaned API (or use npm run dev:fresh) before retrying session helpers.`,
      { cause: error }
    );
  }
}

/**
 * @param {string} value
 * @returns {"comfortable" | "kiosk"}
 */
export function parseDensity(value) {
  if (value === COMFORTABLE_DENSITY || value === "desktop") return COMFORTABLE_DENSITY;
  if (value === KIOSK_DENSITY || value === "dense") return KIOSK_DENSITY;
  throw new Error(`density must be comfortable|kiosk|desktop|dense (got ${value})`);
}

/**
 * @param {string[]} argv
 */
export function resolveDensityFromArgv(argv = process.argv.slice(2)) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--density=")) return parseDensity(arg.slice("--density=".length));
    if (arg === "--density") {
      const value = argv[i + 1];
      if (!value) throw new Error("--density requires comfortable|kiosk");
      return parseDensity(value);
    }
  }
  // Product density control is deferred (TODO(density)); session helpers default comfortable.
  return COMFORTABLE_DENSITY;
}

export function cdpEndpoint(port = resolveCdpPort()) {
  return `http://127.0.0.1:${port}`;
}

/** Ensure parent directories exist for a file path. */
export function ensureParentDir(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}
