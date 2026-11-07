import {
  DEFAULT_CREDENTIALS_META,
  PUBLIC_DEFAULT_ACCESS_TOKEN,
  PUBLIC_DEFAULT_ADMIN_PINS,
  PUBLIC_DEFAULT_BOOTSTRAP_KEY,
  type PublicDefaultCredentials,
} from "../../shared/default-credentials";

/** The advisory admin PIN that provisioning seeds: `MP_ADMIN_PIN`, else "0000". */
export function resolveAdminPin(env: typeof process.env = process.env): string {
  return env.MP_ADMIN_PIN ?? "0000";
}

/** True when the configured access token is the repository's public default. */
export function usesDefaultAccessToken(env: typeof process.env = process.env): boolean {
  return env.MP_ACCESS_TOKEN === PUBLIC_DEFAULT_ACCESS_TOKEN;
}

/** The configured credentials that are public defaults. A value the operator chose is never
 * included, so this is safe to send to an unauthenticated browser.
 */
export function publicDefaultCredentials(
  env: typeof process.env = process.env
): PublicDefaultCredentials {
  const result: PublicDefaultCredentials = {};
  if (env.MP_BOOTSTRAP_KEY === PUBLIC_DEFAULT_BOOTSTRAP_KEY) {
    result.bootstrapKey = PUBLIC_DEFAULT_BOOTSTRAP_KEY;
  }
  // The same resolution provision.ts uses to seed the PIN.
  const adminPin = resolveAdminPin(env);
  if (PUBLIC_DEFAULT_ADMIN_PINS.includes(adminPin)) result.adminPin = adminPin;
  return result;
}

/** `<meta>` tag for the SPA shell, or "" when every credential was changed. */
export function defaultCredentialsMetaTag(env: typeof process.env = process.env): string {
  const credentials = publicDefaultCredentials(env);
  if (Object.keys(credentials).length === 0) return "";
  const content = JSON.stringify(credentials).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return `<meta name="${DEFAULT_CREDENTIALS_META}" content="${content}">`;
}
