#!/usr/bin/env node
// Post-deploy smoke: GET every read route in docs/api/openapi.json against a live deployment
// and fail on any 5xx. /health alone does not exercise per-route response schemas.
//
// Usage: npm run smoke:deploy [-- --url https://<app>.fly.dev] [-- --reprovision]
import * as nodeFs from "node:fs";
import { pathToFileURL } from "node:url";
import { readFlyEnv } from "./env.mjs";
import { FLY_CONFIG, readFlyApp } from "./fly-cli.mjs";

export const SMOKE_CACHE = "infra/fly/.smoke-device";
const DEVICE_COOKIE = "mp_device_key";
/** The auth boundary answers 401 for an unknown key and 403 for a revoked or expired one. */
export const STALE_CREDENTIAL = Object.freeze([401, 403]);

/** Routes that download household data, return binaries, need a lease or reach the home network. */
export const SMOKE_SKIP = Object.freeze([
  "/api/backups/{filename}/download",
  "/api/backups/{filename}/download-sql",
  "/api/daily-briefing/{memberId}/{date}/preview.png",
  "/api/printing/jobs/{id}/payload",
  "/api/network-devices/live-clients",
  "/health",
]);

/** @param {{ paths: Record<string, { get?: unknown }> }} spec */
export function planSmokeRoutes(spec) {
  const gets = Object.entries(spec.paths)
    .filter(([path, item]) => item.get && !SMOKE_SKIP.includes(path))
    .map(([path]) => path);
  return {
    direct: gets.filter((path) => !path.includes("{")),
    parametrized: gets.filter((path) => path.includes("{")),
  };
}

function firstId(body) {
  return Array.isArray(body) && body[0]?.id != null ? String(body[0].id) : null;
}

/**
 * `{id}` comes from the list route the path extends, `{memberId}` from /api/members and
 * `{date}` is today. Returns null when a value cannot be discovered.
 * @param {string} path
 * @param {Record<string, unknown>} bodies list responses keyed by path
 * @param {string} today YYYY-MM-DD
 */
export function fillParams(path, bodies, today) {
  let unknown = false;
  const filled = path.replace(/\{(\w+)\}/g, (_, name, offset) => {
    let value = null;
    if (name === "date") value = today;
    else if (name === "memberId") value = firstId(bodies["/api/members"]);
    else if (name === "id") value = firstId(bodies[path.slice(0, offset - 1)]);
    if (value == null) unknown = true;
    return encodeURIComponent(value ?? "");
  });
  return unknown ? null : filled;
}

/**
 * The smoke device's cookie: cached in `cachePath` (mode 0600) or provisioned once with the
 * bootstrap key. Each provision adds a device, so the cache is reused across deploys.
 */
export async function deviceCookie({ baseUrl, bootstrapKey, cachePath, fetch, fs }) {
  if (fs.existsSync(cachePath)) {
    const cached = fs.readFileSync(cachePath, "utf8").trim();
    if (cached) return cached;
  }
  const response = await fetch(`${baseUrl}/api/auth/provision`, {
    method: "POST",
    headers: { authorization: `Bearer ${bootstrapKey}` },
  });
  if (!response.ok) throw new Error(`provisioning the smoke device failed (${response.status})`);
  const prefix = `${DEVICE_COOKIE}=`;
  const header = response.headers.getSetCookie().find((cookie) => cookie.startsWith(prefix));
  if (!header) throw new Error("provisioning returned no device cookie");
  const value = header.slice(prefix.length).split(";")[0];
  fs.rmSync(cachePath, { force: true });
  fs.writeFileSync(cachePath, `${value}\n`, { mode: 0o600 });
  return value;
}

export async function runSmoke({ baseUrl, bootstrapKey, cachePath, spec, fetch, fs, log, today }) {
  const date = today ?? new Date().toISOString().slice(0, 10);
  const result = { failures: [], warnings: [], skipped: [] };
  const auth = { baseUrl, bootstrapKey, cachePath, fetch, fs };
  let cookie = await deviceCookie(auth);
  let reprovisioned = false;

  const get = (path) =>
    fetch(`${baseUrl}${path}`, {
      headers: { cookie: `${DEVICE_COOKIE}=${cookie}`, accept: "application/json" },
    });

  async function check(path) {
    let response = await get(path).catch(() => null);
    if (STALE_CREDENTIAL.includes(response?.status) && !reprovisioned) {
      reprovisioned = true;
      fs.rmSync(cachePath, { force: true });
      cookie = await deviceCookie(auth);
      response = await get(path).catch(() => null);
    }
    if (!response) {
      result.failures.push(`GET ${path} → unreachable`);
      log(`  ✘ GET ${path} → unreachable`);
      return null;
    }
    const line = `GET ${path} → ${response.status}`;
    if (response.status >= 500 || STALE_CREDENTIAL.includes(response.status)) {
      result.failures.push(line);
      log(`  ✘ ${line}`);
    } else if (response.status >= 400) {
      result.warnings.push(line);
      log(`  ⚠ ${line}`);
    } else {
      log(`  ✔ ${line}`);
    }
    return response;
  }

  const { direct, parametrized } = planSmokeRoutes(spec);
  const bodies = {};
  for (const path of direct) {
    const response = await check(path);
    if (response?.ok) bodies[path] = await response.json().catch(() => null);
  }
  for (const template of parametrized) {
    const path = fillParams(template, bodies, date);
    if (path) await check(path);
    else {
      result.skipped.push(template);
      log(`  · GET ${template} skipped (no id to fill)`);
    }
  }
  return result;
}

function parseArgs(argv) {
  const options = { url: null, reprovision: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--url") options.url = argv[++i];
    else if (argv[i] === "--reprovision") options.reprovision = true;
    else
      throw new Error(
        `Unknown flag: ${argv[i]}\nUsage: npm run smoke:deploy -- [--url <https://…>] [--reprovision]`
      );
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const env = readFlyEnv(".env.fly");
  const baseUrl = (
    options.url ?? `https://${readFlyApp(nodeFs.readFileSync(FLY_CONFIG, "utf8"))}.fly.dev`
  ).replace(/\/$/, "");
  if (options.reprovision) nodeFs.rmSync(SMOKE_CACHE, { force: true });
  const spec = JSON.parse(nodeFs.readFileSync("docs/api/openapi.json", "utf8"));
  console.log(`Smoke checking ${baseUrl}`);
  const result = await runSmoke({
    baseUrl,
    bootstrapKey: env.MP_BOOTSTRAP_KEY,
    cachePath: SMOKE_CACHE,
    spec,
    fetch: globalThis.fetch,
    fs: nodeFs,
    log: console.log,
  });
  console.log(
    `${result.failures.length} failed, ${result.warnings.length} warnings, ${result.skipped.length} skipped`
  );
  process.exitCode = result.failures.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
