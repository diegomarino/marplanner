import {
  DEFAULT_CREDENTIALS_META,
  PUBLIC_DEFAULT_ACCESS_TOKEN,
  PUBLIC_DEFAULT_ADMIN_PINS,
  PUBLIC_DEFAULT_BOOTSTRAP_KEY,
  type PublicDefaultCredentials,
} from "../../shared/default-credentials";

/** True when the configured access token is the repository's public default. */
export function usesDefaultAccessToken(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MP_ACCESS_TOKEN === PUBLIC_DEFAULT_ACCESS_TOKEN;
}

/** The configured credentials that are public defaults. A value the operator chose is never
 * included, so this is safe to send to an unauthenticated browser.
 */
export function publicDefaultCredentials(
  env: NodeJS.ProcessEnv = process.env
): PublicDefaultCredentials {
  const result: PublicDefaultCredentials = {};
  if (env.MP_BOOTSTRAP_KEY === PUBLIC_DEFAULT_BOOTSTRAP_KEY) {
    result.bootstrapKey = PUBLIC_DEFAULT_BOOTSTRAP_KEY;
  }
  // Mirrors provision.ts, which seeds the PIN from ADMIN_PIN or falls back to "0000".
  const adminPin = env.ADMIN_PIN ?? "0000";
  if (PUBLIC_DEFAULT_ADMIN_PINS.includes(adminPin)) result.adminPin = adminPin;
  return result;
}

/** `<meta>` tag for the SPA shell, or "" when every credential was changed. */
export function defaultCredentialsMetaTag(env: NodeJS.ProcessEnv = process.env): string {
  const credentials = publicDefaultCredentials(env);
  if (Object.keys(credentials).length === 0) return "";
  const content = JSON.stringify(credentials).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return `<meta name="${DEFAULT_CREDENTIALS_META}" content="${content}">`;
}
