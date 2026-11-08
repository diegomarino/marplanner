/** Single source of truth for auth cookie names + attributes (ADR-060, amended).
 * Both auth cookies are `Secure` + `HttpOnly` + `SameSite=Lax` + mount-scoped `Path` (root defaults to `/`), issued
 * from ONE factory so the two set-sites (gate + provisioning) cannot drift.
 * NOTE — `__Host-` was evaluated and REJECTED (ADR-060 Correction): browsers
 * accept `__Host-`/`__Secure-` prefixed cookies ONLY over real HTTPS, NOT over
 * `http://localhost` (empirically verified — localhost's secure-context status
 * covers plain `Secure` but not the prefixes). Adopting `__Host-` would lock the
 * access gate in no-TLS local dev, contradicting ADR-060's own posture. Plain
 * `Secure` is accepted on localhost AND enforced on real TLS — the right choice.
 * `mp_provisioned` (a non-secret, non-HttpOnly client-readable presence marker,
 * FR-031/ADR-059) is intentionally NOT an auth cookie and is out of scope here.
 */
export const DEVICE_COOKIE = "mp_device_key";
export const GATE_COOKIE = "mp_gate";

/** Lifetime of the gate, device and `mp_provisioned` cookies: 400 days, the
 * longest Chromium accepts. Without it they are session cookies, and an Android
 * PWA drops them whenever the app is closed, which logs the device out. Device
 * keys never expire server-side (`expiresAt = null`), so the cookie must outlive
 * the browser session too.
 */
export const AUTH_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

/** Serialize an auth cookie with the one shared attribute policy: `Secure`
 * (accepted on localhost, enforced under the TLS-required-for-non-localhost
 * posture) + `HttpOnly` + `SameSite=Lax` (so a bookmark navigation into the app
 * still sends the cookie) + the deployment mount cookie path + a persistent
 * `Max-Age`.
 */
export function serializeAuthCookie(name: string, value: string, basePath = ""): string {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=${basePath}/; Max-Age=${AUTH_COOKIE_MAX_AGE_SECONDS}`;
}
