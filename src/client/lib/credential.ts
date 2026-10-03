import { appUrl, clientBasePath } from "./base-path";
/** Device-credential-loss recovery (FR-013).
 * The kiosk shell decides "provisioned" from the presence of the non-HttpOnly
 * `mp_provisioned` marker cookie (FR-031/ADR-059), not from an authenticated
 * probe. If the device key backing that marker is later revoked or expires
 * server-side, the marker can outlive the real credential: every `/api/*`
 * call then 401/403s (the hard invariant — no household data ever loads,
 * enforced by `src/server/auth/boundary.ts`) while the shell keeps rendering
 * as if provisioned, with no self-service way back to the provisioning gate.
 * `authFetch` closes that gap on the client-state side: any authenticated
 * call that comes back 401/403 is treated as credential loss — the marker is
 * cleared and the shell is notified (via `CREDENTIAL_LOST_EVENT`) to fall
 * back to the access-gate/provisioning screen, without waiting for a manual
 * refresh. This does NOT change the server authorization boundary and does
 * NOT add a boot-time `/api` probe (FR-031/ADR-059 stays intact) — the
 * re-check only ever piggybacks on a real, already-happening authenticated
 * call.
 * Credential-generation guard (race): several authenticated requests can be
 * in flight against a stale device key at once. If the user re-provisions
 * while a SLOWER stale request is still pending, that request can resolve
 * 401/403 AFTER the fresh marker is set — an unconditional clear would then
 * bounce the freshly-provisioned user straight back to the gate. `authFetch`
 * captures the current `credentialGeneration` before issuing the request and
 * only reports loss if the generation is still current when the response
 * comes back; `bumpCredentialGeneration` must be called wherever the
 * client learns the credential changed (a successful (re-)provision) so
 * denials from the OLD generation are ignored instead of misfiring. The
 * generation re-check happens AFTER the (async) scope-403 body peek below,
 * immediately before the report call — keeping "check generation, report
 * loss, bump generation" one atomic synchronous step is what lets N
 * concurrent stale-credential denials still collapse into exactly one event
 * (an await sitting BETWEEN the check and the report would let sibling
 * requests' checks interleave ahead of the first bump and all fire).
 * Scope-403 exception: a live device key
 * can still be denied on grounds OTHER than the credential itself being dead — an admin scope
 * (`requireManagementKey` rejecting it on the Network Devices panel, `code:
 * AUTH_SCOPE_DENIED_CODE`) or a domain-specific state gate (printing's `POST /claim` 403ing a
 * session that never registered its printer capability, `code: "printer_capability_missing"` —
 * see src/server/modules/printing/index.ts's `PrintCapabilityMissingError`). Neither is
 * credential loss, and must not de-provision the kiosk merely because SOME feature it lacks
 * capability/scope for was touched. The polarity below is therefore INVERTED from a fixed
 * allow-list of one code: any parseable `code` other than `AUTH_CREDENTIAL_INVALID_CODE` passes
 * through untouched — the server has explicitly told us the credential itself is fine, whatever
 * else it said no to. Only `code: AUTH_CREDENTIAL_INVALID_CODE` and an unparseable/codeless body
 * (the conservative default) still report loss. See `isCredentialLoss` below.
 */
import { AUTH_CREDENTIAL_INVALID_CODE } from "../../shared";

/** Custom event dispatched on `window` when device-credential loss is detected. */
export const CREDENTIAL_LOST_EVENT = "mp:credential-lost";

/** Monotonic counter identifying the "current" device credential from the
 * client's point of view. Bumped on every credential change (successful
 * provision, or a reported loss) so in-flight requests issued under a
 * now-superseded credential can recognize themselves as stale.
 */
let credentialGeneration = 0;

/** Bump the credential generation. Call this whenever the client learns the
 * device credential changed — most importantly right after a successful
 * (re-)provision — so that denials from requests still in flight under the
 * OLD credential are ignored rather than clearing the freshly-set marker.
 */
export function bumpCredentialGeneration(): void {
  credentialGeneration += 1;
}

/** Clear the (non-HttpOnly, client-readable) `mp_provisioned` marker cookie. */
export function clearProvisionedMarker(): void {
  document.cookie = `mp_provisioned=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${clientBasePath()}/`;
}

/** Clear the stale marker and notify listeners (the Shell) that the device
 * credential has been lost, so the UI can fall back to the provisioning gate.
 * Also bumps the credential generation, so concurrent stale-credential
 * failures collapse into a single `CREDENTIAL_LOST_EVENT` instead of one per
 * failed request.
 */
export function reportCredentialLoss(): void {
  bumpCredentialGeneration();
  clearProvisionedMarker();
  window.dispatchEvent(new Event(CREDENTIAL_LOST_EVENT));
}

/** `fetch` wrapper for authenticated `/api/*` calls: on a 401 or 403 response,
 * treat it as device-credential loss (FR-013) and report it — UNLESS the
 * credential generation has moved on since the request was issued (the
 * denial belongs to a credential the client has already superseded, e.g. via
 * a successful re-provision that raced ahead of this response), OR the body
 * carries a parseable `code` OTHER than `AUTH_CREDENTIAL_INVALID_CODE` — the server has
 * explicitly told us the credential itself is fine (a scope-403 like
 * `AUTH_SCOPE_DENIED_CODE`, or a domain-specific gate like printing's
 * `printer_capability_missing`), this particular request is merely denied on
 * OTHER grounds. Every other 401/403 shape — no parseable JSON body at all,
 * a body with no `code` field, or one carrying `AUTH_CREDENTIAL_INVALID_CODE`
 * — is treated as credential loss, matching the conservative
 * default for the boundary layer's own responses. Returns the response
 * unchanged either way so callers keep handling their own status-specific UI
 * (e.g. inline error text) exactly as before — the body is read via
 * `.clone` so this peek never consumes the stream the caller still needs.
 */
export async function authFetch(...args: Parameters<typeof fetch>): Promise<Response> {
  const generation = credentialGeneration;
  if (typeof args[0] === "string" && args[0].startsWith("/api/")) args[0] = appUrl(args[0]);
  const res = await fetch(...args);
  if (res.status === 401 || res.status === 403) {
    const credentialLoss = await isCredentialLoss(res);
    // Generation re-check happens HERE, right before the report call (not combined with the
    // status check above) — see the generation-guard doc note above for why this ordering
    // is load-bearing for the concurrent-denial-collapse guarantee.
    if (credentialLoss && generation === credentialGeneration) {
      reportCredentialLoss();
    }
  }
  return res;
}

/** False only when the response body is JSON carrying a `code` string OTHER than
 * `AUTH_CREDENTIAL_INVALID_CODE` — every such code (`AUTH_SCOPE_DENIED_CODE`,
 * `printer_capability_missing`, or any future domain-specific gate) means the credential itself
 * is live; the caller's own request was merely denied on other grounds, so `authFetch` must NOT
 * treat it as credential loss. Any other shape — no `code` field, a non-string `code`, an
 * unparseable/absent JSON body, or `code === AUTH_CREDENTIAL_INVALID_CODE` itself — reports
 * `true`, preserving the conservative default of treating every otherwise-unrecognized
 * 401/403 as credential loss.
 */
async function isCredentialLoss(res: Response): Promise<boolean> {
  try {
    const body = (await res.clone().json()) as { code?: unknown } | null;
    if (typeof body?.code === "string") {
      return body.code === AUTH_CREDENTIAL_INVALID_CODE;
    }
    return true;
  } catch {
    return true;
  }
}
