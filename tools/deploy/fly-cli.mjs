// flyctl helpers for npm run deploy:fly. Secret values travel only through stdin.
import { spawn as nodeSpawn } from "node:child_process";

export const FLY_CONFIG = "infra/fly/fly.toml";
const TEMPLATE_APP = "your-marplanner-app";

/**
 * Top-level `app = "…"` from fly.toml; keys inside [tables] are ignored.
 * @param {string} tomlText
 */
export function readFlyApp(tomlText) {
  for (const line of tomlText.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const match = /^\s*app\s*=\s*["']([^"']+)["']/.exec(line);
    if (!match) continue;
    if (match[1] === TEMPLATE_APP)
      throw new Error(`${FLY_CONFIG} still uses the template app name; set your own`);
    return match[1];
  }
  throw new Error(`${FLY_CONFIG} has no top-level app name`);
}

/**
 * @param {Record<string, string>} local
 * @param {string[]} remoteNames
 */
export function planSecrets(local, remoteNames) {
  const stage = Object.keys(local).sort();
  const remote = new Set(remoteNames);
  return {
    stage,
    added: stage.filter((key) => !remote.has(key)),
    extra: remoteNames.filter((key) => !(key in local)).sort(),
  };
}

/**
 * One line as `fly secrets import` reads it (port of flyctl internal/command/secrets/parser.go,
 * single-line branch): the value loses leading spaces, is cut at a `#` preceded by an even number
 * of `"`, and loses one pair of surrounding quotes. Returns null where flyctl would start a
 * multi-line value.
 * @param {string} line
 */
export function flyParseLine(line) {
  const eq = line.indexOf("=");
  const key = line.slice(0, eq).trim();
  let value = line.slice(eq + 1).replace(/^ +/, "");
  const hash = value.indexOf("#");
  if (hash !== -1) {
    const before = value.slice(0, hash);
    if ((before.match(/"/g) ?? []).length % 2 === 0) value = before.replace(/ +$/, "");
  }
  if (value.startsWith('"""')) {
    if (value.length >= 6 && value.endsWith('"""')) return { key, value: value.slice(3, -3) };
    return null;
  }
  if (
    value.length >= 2 &&
    ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))
  )
    value = value.slice(1, -1);
  return { key, value };
}

/** Encodes `value` so flyctl's parser reads it back unchanged, or returns null. */
function encodeForFly(key, value) {
  for (const candidate of [value, `"${value}"`, `'${value}'`, `"""${value}"""`]) {
    if (flyParseLine(`${key}=${candidate}`)?.value === value) return candidate;
  }
  return null;
}

/** `fly secrets import` reads one NAME=VALUE per line, with its own quoting rules. */
export function secretsImportPayload(local) {
  return Object.entries(local)
    .map(([key, value]) => {
      if (/[\r\n]/.test(value))
        throw new Error(`${key} contains a newline; Fly secrets import is line-based`);
      const encoded = encodeForFly(key, value);
      if (encoded === null)
        throw new Error(
          `${key} cannot be sent through fly secrets import unchanged; avoid # and quotes in it`
        );
      return `${key}=${encoded}\n`;
    })
    .join("");
}

/** @param {string} json output of `fly secrets list --json` */
export function parseSecretsList(json) {
  return JSON.parse(json || "[]").map((entry) => entry.Name ?? entry.name);
}

/** @param {{ sha: string, subject: string }} build */
export function deployArgs({ sha, subject }) {
  return [
    "deploy",
    ".",
    "--config",
    FLY_CONFIG,
    "--ha=false",
    "--remote-only",
    "--build-arg",
    `MP_BUILD_SHA=${sha}`,
    "--build-arg",
    `MP_BUILD_SUBJECT=${subject}`,
  ];
}

/**
 * Runs flyctl (`fly`, falling back to `flyctl`). stdout is captured; stderr streams to the
 * terminal unless `quiet`, which callers set for any command that carries secret values.
 * `stream` sends stdout to the terminal too (long commands like deploy); stdout is then "".
 * @param {string[]} args
 * @param {{ input?: string, quiet?: boolean, stream?: boolean, spawn?: typeof nodeSpawn }} [options]
 * @returns {Promise<{ code: number, stdout: string }>}
 */
export async function runFly(
  args,
  { input, quiet = false, stream = false, spawn = nodeSpawn } = {}
) {
  try {
    return await spawnOnce("fly", args, { input, quiet, stream, spawn });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return spawnOnce("flyctl", args, { input, quiet, stream, spawn });
  }
}

function spawnOnce(bin, args, { input, quiet, stream, spawn }) {
  return new Promise((resolve, reject) => {
    const stdio = ["pipe", stream ? "inherit" : "pipe", quiet ? "pipe" : "inherit"];
    const child = spawn(bin, args, { stdio });
    let stdout = "";
    child.on("error", reject);
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.resume();
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
    child.stdin.end(input ?? "");
  });
}
