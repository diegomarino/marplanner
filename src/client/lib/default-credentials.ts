import {
  DEFAULT_CREDENTIALS_META,
  PUBLIC_DEFAULT_ADMIN_PINS,
  PUBLIC_DEFAULT_BOOTSTRAP_KEY,
  type PublicDefaultCredentials,
} from "../../shared/default-credentials";

/** Public default credentials the server reported in the shell's `<meta>` tag. Values outside
 * the known public set are ignored, so a tampered or stale page can never prefill a secret.
 */
export function readPublicDefaultCredentials(): PublicDefaultCredentials {
  const raw = document.querySelector<HTMLMetaElement>(
    `meta[name="${DEFAULT_CREDENTIALS_META}"]`
  )?.content;
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const { bootstrapKey, adminPin } = parsed as Record<string, unknown>;
  const result: PublicDefaultCredentials = {};
  if (bootstrapKey === PUBLIC_DEFAULT_BOOTSTRAP_KEY) result.bootstrapKey = bootstrapKey;
  if (typeof adminPin === "string" && PUBLIC_DEFAULT_ADMIN_PINS.includes(adminPin)) {
    result.adminPin = adminPin;
  }
  return result;
}
