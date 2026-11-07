// Loads and validates `.env.fly`, the operator's git-ignored production values for Fly.
// Messages name keys only: a value from this file must never reach the terminal.
import * as nodeFs from "node:fs";
import { parseEnv } from "node:util";
import {
  PUBLIC_DEFAULT_ACCESS_TOKEN,
  PUBLIC_DEFAULT_ADMIN_PINS,
  PUBLIC_DEFAULT_BOOTSTRAP_KEY,
} from "../../src/shared/default-credentials.ts";

export const REQUIRED_FLY_KEYS = Object.freeze([
  "MP_ACCESS_TOKEN",
  "MP_BOOTSTRAP_KEY",
  "ADMIN_PIN",
]);

const PREFIXES = { MP_ACCESS_TOKEN: "mpg-", MP_BOOTSTRAP_KEY: "mpk-" };

const PUBLIC_DEFAULTS = {
  MP_ACCESS_TOKEN: [PUBLIC_DEFAULT_ACCESS_TOKEN],
  MP_BOOTSTRAP_KEY: [PUBLIC_DEFAULT_BOOTSTRAP_KEY],
  ADMIN_PIN: PUBLIC_DEFAULT_ADMIN_PINS,
};

/**
 * @param {string} path
 * @param {{ readFileSync: typeof nodeFs.readFileSync }} [fs]
 * @returns {Record<string, string>}
 */
export function readFlyEnv(path, fs = nodeFs) {
  let text;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error(
      `${path} not found — create it with the keys listed in infra/fly/USING_FLYIO.md`,
      { cause: error }
    );
  }
  return parseEnv(text);
}

/**
 * @param {Record<string, string>} env
 * @returns {{ errors: string[] }}
 */
export function validateFlyEnv(env) {
  const errors = [];
  for (const key of REQUIRED_FLY_KEYS) {
    const value = env[key];
    if (!value) {
      errors.push(`${key} is missing or empty in .env.fly`);
    } else if (PUBLIC_DEFAULTS[key].includes(value)) {
      errors.push(`${key} is a public default published in this repository; set a unique value`);
    } else if (PREFIXES[key] && !value.startsWith(PREFIXES[key])) {
      errors.push(`${key} must start with ${PREFIXES[key]}`);
    } else if (key === "ADMIN_PIN" && !/^\d{4,6}$/.test(value)) {
      // The Admin keypad (src/client/admin/AdminGate.tsx) enters digits only, 4 to 6 of them.
      errors.push("ADMIN_PIN must be 4–6 digits, the only PINs the Admin keypad can enter");
    }
  }
  return { errors };
}
