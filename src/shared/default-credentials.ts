/** Credential values published in this repository (`.env.example`, the provisioning fallback
 * and the one-click deploy templates). A deployment running with one of them is open to anyone
 * who has read the repository, so the UI may prefill it and must warn that it has to be changed.
 */
export const PUBLIC_DEFAULT_ACCESS_TOKEN = "mpg-local-change-me";
export const PUBLIC_DEFAULT_BOOTSTRAP_KEY = "mpk-local-bootstrap-change-me";
/** `0000` is the provisioning fallback when `ADMIN_PIN` is unset; `1234` is `.env.example`. */
export const PUBLIC_DEFAULT_ADMIN_PINS: readonly string[] = ["0000", "1234"];

/** What the server tells the client shell: only values that are already public. */
export interface PublicDefaultCredentials {
  bootstrapKey?: string;
  adminPin?: string;
}

export const DEFAULT_CREDENTIALS_META = "mp-default-credentials";
