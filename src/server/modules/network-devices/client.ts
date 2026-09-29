// ─────────────────────────────────────────────────────────────────────
// UniFi controller client seam — the ONE
// injectable boundary between this module and the UniFi controller.
// `poll.ts`/`index.ts` never call `fetch` themselves and never
// know the controller's URL shape — they reach it only through
// `getUniFiClient`.
//
// Architect update 2026-09-05 (maintainer-supplied real UniFi docs/scripts,
// <homelab-unifi-notes>, read-only reference — cited by relative path
// below): the household's PROVEN path is the LOCAL Integration API v1
// (`docs/access.md` "API Local (Integration API v1)"), not the cloud
// `api.ui.com` API this module originally guessed at — "Para scripts en LAN
// (este repo), usar siempre la API local directamente" (marplanner itself
// runs on-LAN). The cloud path is a FALLBACK only (when `unifi.host` is
// unset but `unifi.consoleId` is set).
//
// fix (2026-09-05, live evidence): the ORIGINAL cloud/legacy URL
// shapes above 404'd even on-LAN — this module's guessed cloud base
// (`/proxy/network/<consoleId>/...`, no `/v1/connector/consoles/` segment)
// and its use of the Integration v1 site UUID as the LEGACY site segment
// (which the legacy API rejects — it wants the site NAME "default") both
// diverged from v1's PROVEN, shipped surface. Fixed by porting v1's exact
// shapes verbatim: `apps/api/src/lib/unifi/client.ts` (`INTEGRATION_BASE`/
// `LEGACY_BASE`, X-API-Key auth) and `apps/api/src/lib/unifi/sta.ts`
// (`POST …/api/s/default/cmd/stamgr`, `{cmd, mac: <lowercase>}`) — see
// `LEGACY_SITE`, `cloudConnectorPrefix`, `cloudLegacyUrl`,
// `cloudIntegrationV1Url` below. The cloud client-list fallback ALSO now
// uses Integration v1 (previously the legacy `stat/sta` snake_case
// endpoint, which never actually worked — see
// `listClientsCloudIntegrationV1`'s doc comment) — it remains otherwise
// unverified against a real console pending the live smoke (
// SC-008).
//
// Source: docs/features/network-devices.md (seam shape, unset vs
// rejected, test-flag throw), D3 (block-sta/unblock-sta — reconciliation
// needs the SAME client-list poll a blocked MAC stays visible in);
// FR-016/FR-019; <homelab-unifi-notes>/docs/access.md +
// scripts/check-clients.sh (LOCAL base shape, pagination, camelCase fields);
// (v1's proven URL shapes, <marplanner-v1>/apps/api/src/lib/unifi/
// client.ts + sta.ts).
// ─────────────────────────────────────────────────────────────────────

import { Agent, fetch as undiciFetch } from "undici";
import { getOperatorConfig, isTestRuntime } from "../../host-api";

/** A single raw controller-reported client — deliberately loose/unknown-shaped (an external
 * boundary). THREE coexisting shapes land here:
 * - Integration v1, LOCAL (PROVEN — <homelab-unifi-notes>/scripts/check-clients.sh): camelCase
 * `macAddress`/`ipAddress`/`isBlocked`, plus `name`/`hostname`/`type`/`ssid`.
 * - Integration v1, CLOUD (live-probed 2026-09-05, HTTP 200 against a real console, 23 clients —
 * a LIVE FINDING, not the local shape assumed at fix authoring time): a REDUCED
 * projection carrying exactly `access`/`connectedAt`/`id`/`ipAddress`/`macAddress`/`name`/
 * `type`/`uplinkDeviceId` — notably NO `isBlocked` and NO `hostname`. Blocked state instead
 * lives in `access: { type: "DEFAULT" | "BLOCKED" |... }` (`extractRawAccessType`,
 * `normalize.ts`) — the `"BLOCKED"` value itself is UNOBSERVED so far (only `"DEFAULT"` has
 * been seen live); see that function's doc comment for the full caveat.
 * - Legacy (snake_case, block/unblock COMMAND responses ONLY — both local/cloud): `mac`/`ip`/
 * `last_ip`/`fixed_ip`/`blocked`, per v1's `apps/api/src/lib/unifi/sta.ts`.
 * `normalize.ts` reads ALL THREE forms defensively and NEVER copies any IP-shaped field
 * (`ip`/`last_ip`/`fixed_ip`/`ipAddress`) into `LiveClient` (structural drop,
 * NETWORK-DEVICES-INV-06) — see `tests/helpers/unifi-fixtures.ts` for fixtures of all three
 * shapes, each deliberately rich in IP fields.
 */
export interface RawUniFiClient {
  // Integration v1 (camelCase, LOCAL — PROVEN).
  macAddress?: unknown;
  ipAddress?: unknown;
  type?: unknown;
  ssid?: unknown;
  isBlocked?: unknown;
  // Integration v1, CLOUD projection (live-probed 2026-09-05) — no isBlocked; blocked state
  // rides in access.type instead (normalize.ts's extractRawAccessType).
  access?: unknown;
  connectedAt?: unknown;
  id?: unknown;
  uplinkDeviceId?: unknown;
  // Legacy (snake_case, block/unblock command responses only —).
  mac?: unknown;
  ip?: unknown;
  last_ip?: unknown;
  fixed_ip?: unknown;
  blocked?: unknown;
  // Shared by both shapes.
  hostname?: unknown;
  name?: unknown;
  [key: string]: unknown;
}

/** The injected controller seam (the `SchedulerDeps`/`ForecastPort` precedent):
 * `listClients` is the SAME call used for presence AND blocked-state reconciliation
 * (block-sta, — a blocked MAC stays visible with a `blocked`/`isBlocked` flag, so
 * one call serves both — see `buildUniFiClient`'s doc comment for the OPEN RISK on the LOCAL
 * Integration v1 path specifically). `blockMac`/`unblockMac` are the authoritative
 * controller-side actions `index.ts`'s block/unblock calls BEFORE writing the local
 * mirror.
 * Every method REJECTS (never returns a sentinel) on failure, with either
 * `UniFiControllerRejectedError` (401/403, or a legacy 200-envelope auth failure — a
 * set-but-rejected credential, D2) or `UniFiControllerUnreachableError` (timeout/network/5xx/
 * malformed body) — the two states says must never be conflated with each other OR
 * with "unconfigured" (which is `getUniFiClient` returning `null`, never a method throwing).
 */
export interface UniFiClient {
  listClients(): Promise<RawUniFiClient[]>;
  blockMac(mac: string): Promise<void>;
  unblockMac(mac: string): Promise<void>;
}

/** Set-but-REJECTED credential (401/403 from the controller, or a legacy 200-envelope auth
 * failure) — distinct from `unconfigured` (an expired/wrong key must never
 * masquerade as "not set up yet").
 */
export class UniFiControllerRejectedError extends Error {
  constructor(message = "UniFi controller rejected the request (401/403)") {
    super(message);
    this.name = "UniFiControllerRejectedError";
  }
}

/** Timeout, network-level failure, non-2xx/non-401/403 status, or a malformed response body. */
export class UniFiControllerUnreachableError extends Error {
  constructor(message = "UniFi controller unreachable") {
    super(message);
    this.name = "UniFiControllerUnreachableError";
  }
}

const CLOUD_BASE_ORIGIN = "https://api.ui.com";

/** The LEGACY controller API's site segment is always the site NAME "default", never the
 * Integration v1 site UUID (`unifi.siteId`) —, fixing a v2-only divergence from v1's
 * PROVEN surface (`apps/api/src/lib/unifi/client.ts`'s `LEGACY_BASE` comment: "requires the site
 * name* 'default', NOT the UUID — passing the UUID returns 401 NoSiteContext... hardcoded to
 * 'default' because that is the universal default for single-site UniFi controllers"). `config
 *.siteId` is used ONLY for Integration v1 URLs (`localIntegrationV1Url`/`cloudIntegrationV1Url`)
 * — every legacy URL (`localLegacyUrl`/`cloudLegacyUrl`, both block/unblock command paths) uses
 * this constant instead, never `config.siteId`.
 */
const LEGACY_SITE = "default";

const FETCH_TIMEOUT_MS = 5000;
const INTEGRATION_V1_PAGE_SIZE = 200;
/** Safety valve against a misbehaving controller that never returns a short final page —
 * 100 pages * 200/page = 20,000 clients, far beyond any real household network. Defensive
 * only; a real deployment never approaches this. */
const INTEGRATION_V1_MAX_PAGES = 100;

/** Resolved, ready-to-use client configuration. `apiKey`/`siteId` are ALWAYS required; exactly
 * one of `host` (LOCAL Integration v1, PRIMARY — the household's proven path) or `consoleId`
 * (CLOUD, FALLBACK — URL shapes fixed to match v1's proven surface, but still
 * unverified against a real console pending the live smoke, SC-008) selects the base —
 * `host` wins when both happen to be set. `tlsInsecure` is the operator's explicit opt-in
 * acknowledging the local controller's self-signed cert (never inferred — posture:
 * never invent trust the operator didn't grant).
 */
interface UniFiClientConfig {
  apiKey: string;
  siteId: string;
  host?: string;
  consoleId?: string;
  /** Optional — defaults to `false` (TLS verification stays ON) when omitted, so existing
   * cloud-only test configs need no change. */
  tlsInsecure?: boolean;
}

/** `AbortSignal.timeout(FETCH_TIMEOUT_MS)` firing rejects `fetch` with a `DOMException` named
 * `"TimeoutError"`; a manually aborted signal is `"AbortError"` (same family). Duck-typed on
 * `.name` rather than `instanceof` — the `port.ts` precedent found `instanceof
 * Error`/`instanceof DOMException` unreliable across realms in this exact test environment.
 */
function isAbortOrTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return name === "TimeoutError" || name === "AbortError";
}

interface UniFiEnvelopeMeta {
  rc?: unknown;
  msg?: unknown;
}

/** Loose auth-ish match against a legacy envelope's `rc`/`msg` value — deliberately a substring match, not an exact enum, since the real legacy rc vocabulary
 * (`api.err.LoginRequired`, `api.err.Unauthorized`, …) is unverified against the real
 * controller until the architect's close-time live smoke (SC-008). A false negative
 * here (an auth failure misread as "unreachable" instead of "rejected") is still SAFE — both
 * outcomes mean "nothing succeeded, nothing mirrored" — so under-matching only costs a less
 * specific error, never a false success.
 */
function isAuthLikeEnvelopeValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const lower = value.toLowerCase();
  return (
    lower.includes("login") ||
    lower.includes("unauthor") ||
    lower.includes("forbidden") ||
    (lower.includes("invalid") && (lower.includes("key") || lower.includes("credential")))
  );
}

/** The LEGACY UniFi controller API convention — used by BOTH
 * local/cloud block/unblock COMMAND endpoints (removed the only other caller, the
 * CLOUD client-list fallback, which is Integration v1 now): application-level failures ride
 * INSIDE an HTTP-200 JSON envelope — `{ meta: { rc: "error", msg: "api.err.LoginRequired" },... }`
 * — never surfaced as a non-2xx status. Treating every 2xx as success would let
 * `blockMac`/`unblockMac` resolve — and the caller (`index.ts`'s `setBlockedState`) would then
 * mirror + emit a block the controller never actually applied, a confident falsehood in the
 * exact class AC-02 forbids.
 * Deliberately NOT applied to Integration v1 responses (architect update 2026-09-05): that API
 * uses a plain `{ data: [...] }` envelope with no `meta.rc` concept — proper HTTP status codes
 * carry its failures. Returns `null` when the body carries no `meta.rc` at all, or
 * `meta.rc === "ok"` — i.e. this check is additive to (never a replacement for) the HTTP-status
 * checks in `rawRequest`; a body with no legacy envelope shape (Integration v1 included) is not
 * this failure mode and falls through as a normal success.
 */
function classifyLegacyEnvelopeError(body: unknown): "rejected" | "unreachable" | null {
  if (!body || typeof body !== "object") return null;
  const meta = (body as { meta?: unknown }).meta;
  if (!meta || typeof meta !== "object") return null;

  const { rc, msg } = meta as UniFiEnvelopeMeta;
  if (rc === undefined || rc === "ok") return null;

  return isAuthLikeEnvelopeValue(msg) || isAuthLikeEnvelopeValue(rc) ? "rejected" : "unreachable";
}

/** Strips an accidental `http(s)://` prefix off an operator-supplied bare host/IP (e.g.
 * `192.168.1.1`, matching every <homelab-unifi-notes> doc example) before it is interpolated
 * into an origin string — a copy-pasted full URL would otherwise double up the scheme. */
function normalizeHost(host: string): string {
  return host.replace(/^https?:\/\//i, "");
}

/** LOCAL Integration v1 base (PRIMARY, PROVEN — docs/access.md "API Local (Integration API
 * v1)"): `https://<host>/proxy/network/integration/v1/sites/<siteId>`. No console id — the
 * local API is a direct host connection, not a cloud multi-console proxy. */
function localIntegrationV1Url(config: UniFiClientConfig, path: string): URL {
  return new URL(
    `/proxy/network/integration/v1/sites/${encodeURIComponent(config.siteId)}${path}`,
    `https://${normalizeHost(config.host!)}`
  );
}

/** LOCAL legacy command base (docs/access.md "Legacy local command path" —
 * `<homelab-unifi-notes>/docs/access.md`'s own `cmd/devmgr` example is the sibling of the
 * `cmd/stamgr` shape used here): `https://<host>/proxy/network/api/s/default`. Block/unblock has
 * no Integration v1 equivalent in the reference docs — the legacy command path is used
 * regardless of whether the client-list read goes through Integration v1. Fix: the site
 * segment is `LEGACY_SITE` ("default"), never `config.siteId` — the legacy API takes the site
 * NAME, not the Integration v1 UUID (see `LEGACY_SITE`'s doc comment). */
function localLegacyUrl(config: UniFiClientConfig, path: string): URL {
  return new URL(
    `/proxy/network/api/s/${LEGACY_SITE}${path}`,
    `https://${normalizeHost(config.host!)}`
  );
}

/** CLOUD connector prefix (fix part 2 — v1's PROVEN shape, `apps/api/src/lib/unifi/client.ts`
 * `INTEGRATION_BASE`/`LEGACY_BASE`): `/v1/connector/consoles/<consoleId>/proxy/network`. Replaces
 * this module's original, unverified guess (a bare `/proxy/network/<consoleId>/...`, missing the
 * `/v1/connector/consoles/` segment entirely) — live evidence 2026-09-05: v1's shape answers with
 * 401 (using the LOCAL key — the endpoints exist, just reject that key), while the old v2 guess
 * 404s outright. Shared by both `cloudLegacyUrl` and `cloudIntegrationV1Url` below.
 */
function cloudConnectorPrefix(config: UniFiClientConfig): string {
  return `/v1/connector/consoles/${encodeURIComponent(config.consoleId!)}/proxy/network`;
}

/** CLOUD legacy base (fix): `https://api.ui.com/v1/connector/consoles/<consoleId>/proxy/
 * network/api/s/default`. Used for BOTH local/cloud block/unblock COMMAND paths when
 * `unifi.host` is unset but `unifi.consoleId` is set — the site segment is `LEGACY_SITE`
 * ("default"), never `config.siteId` (same reasoning as `localLegacyUrl`). No longer used for
 * client-list (see `cloudIntegrationV1Url` — fix part 3). */
function cloudLegacyUrl(config: UniFiClientConfig, path: string): URL {
  return new URL(`${cloudConnectorPrefix(config)}/api/s/${LEGACY_SITE}${path}`, CLOUD_BASE_ORIGIN);
}

/** CLOUD Integration v1 base (fix part 3 — replaces the old CLOUD client-list fallback,
 * which used the LEGACY `stat/sta` endpoint and its snake_case shape): `https://api.ui.com/v1/
 * connector/consoles/<consoleId>/proxy/network/integration/v1/sites/<siteId>`. Same Integration
 * v1 tree as the LOCAL primary path (`localIntegrationV1Url`), just proxied through
 * `api.ui.com`'s connector instead of a direct host connection — the site segment here IS
 * `config.siteId` (the Integration v1 UUID), unlike every legacy URL above.
 */
function cloudIntegrationV1Url(config: UniFiClientConfig, path: string): URL {
  return new URL(
    `${cloudConnectorPrefix(config)}/integration/v1/sites/${encodeURIComponent(config.siteId)}${path}`,
    CLOUD_BASE_ORIGIN
  );
}

/** Perform one authenticated request and resolve to its parsed JSON body, or throw one of the
 * two distinguishable failure states from the HTTP status / transport layer alone (research
 * D2) — NO envelope validation here (that is `legacyRequest`'s job, layered on top only where
 * it applies). This is the SOLE place `fetch` is called in this module. `dispatcher` (an
 * undici `Agent`) is passed through only when the operator's `unifi.tlsInsecure` toggle is on
 * (`buildUniFiClient` constructs it once per client).
 * (Node 24 ABI mismatch): the BUILT-IN `fetch` bundles Node's OWN internal copy of
 * undici (7.29.0 on Node 24.19.0), a different major version from the npm `undici` package
 * (^8.10.2) this module's `Agent` is constructed from (`buildUniFiClient`). Passing an Agent
 * across that major-version boundary as the built-in `fetch`'s `dispatcher` throws
 * `TypeError: fetch failed` / `InvalidArgumentError: invalid onRequestStart method` on every
 * real TLS request — silent until an operator actually flips `tlsInsecure` on against a real
 * self-signed local controller. Fix: when a dispatcher is present, route the request through
 * undici's OWN `fetch` (imported above) instead of the built-in one, so `Agent` and `fetch`
 * always come from the SAME undici implementation. The non-tlsInsecure path stays on the
 * built-in `fetch`, unchanged — minimal blast radius, and it keeps every existing
 * `vi.stubGlobal("fetch",...)` test seam intact (none of those tests exercise tlsInsecure).
 */
async function rawRequest(
  url: URL,
  apiKey: string,
  dispatcher: Agent | undefined,
  init?: { method?: string; body?: unknown }
): Promise<unknown> {
  const requestInit = {
    method: init?.method ?? "GET",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  };

  let res: Response;
  try {
    res = dispatcher
      ? // undici's own `fetch` — its `RequestInit` types `dispatcher` natively (unlike the DOM
        // lib's `RequestInit`, which needs the `Parameters<typeof fetch>[1]` cast below), and
        // its `Response` is structurally identical (`status`/`ok`/`json`) to the DOM lib one
        // used everywhere else in this function.
        ((await undiciFetch(url, { ...requestInit, dispatcher })) as unknown as Response)
      : await fetch(url, requestInit as Parameters<typeof fetch>[1]);
    // `Parameters<typeof fetch>[1]` rather than the DOM lib's `RequestInit` by name — that
    // TYPE-only global identifier trips `no-undef` in this repo's eslint config (which
    // doesn't special-case type-only DOM lib names, the same reason the test file's
    // `FetchInit` stand-in exists).
  } catch (err) {
    // Timeout, DNS failure, connection refused, TLS error (incl. a self-signed cert rejected
    // because `tlsInsecure` was never enabled) — all genuinely UNREACHABLE, never conflated
    // with a controller REJECTION.
    throw new UniFiControllerUnreachableError(
      isAbortOrTimeoutError(err)
        ? "UniFi controller request timed out"
        : "UniFi controller network error"
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw new UniFiControllerRejectedError();
  }
  if (!res.ok) {
    // Every other non-2xx status (404, 429, 5xx…) buckets to Unreachable rather than a third
    // distinct state — only names two failure states (rejected/unreachable)
    // besides unconfigured. Deliberately unverified against the real controller until the
    // architect's close-time live smoke (SC-008, trap-sweep) — if that smoke
    // finds a status needing its own distinct handling, it is filed and fixed there.
    throw new UniFiControllerUnreachableError(`UniFi controller returned HTTP ${res.status}`);
  }

  try {
    return await res.json();
  } catch {
    throw new UniFiControllerUnreachableError(
      "UniFi controller returned a malformed response body"
    );
  }
}

/** `rawRequest` + the LEGACY 200-envelope validation layered on top — used for every LEGACY-shaped endpoint: BOTH local/cloud block/unblock commands. Fix
 * removed the only other caller (the CLOUD client-list fallback, now Integration v1 —
 * `listClientsCloudIntegrationV1`) — NEVER used for ANY client-list read, local or cloud
 * (`classifyLegacyEnvelopeError`'s own doc comment).
 */
async function legacyRequest(
  url: URL,
  apiKey: string,
  dispatcher: Agent | undefined,
  init?: { method?: string; body?: unknown }
): Promise<unknown> {
  const json = await rawRequest(url, apiKey, dispatcher, init);

  const envelopeError = classifyLegacyEnvelopeError(json);
  if (envelopeError === "rejected") {
    throw new UniFiControllerRejectedError(
      "UniFi controller reported an application-level auth failure inside a 200 envelope"
    );
  }
  if (envelopeError === "unreachable") {
    throw new UniFiControllerUnreachableError(
      "UniFi controller reported an application-level failure inside a 200 envelope"
    );
  }

  return json;
}

/** The Integration v1 `{ data: [...] }` envelope (<homelab-unifi-notes>/scripts/
 * check-clients.sh: `jq '.data | length'` / `jq -s '.[0] +.[1].data'`) — same key name as the
 * legacy shape by coincidence, but a DIFFERENT, proper REST envelope with no `meta.rc`. */
function extractIntegrationV1Page(body: unknown): RawUniFiClient[] {
  if (body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)) {
    return (body as { data: unknown[] }).data as RawUniFiClient[];
  }
  return [];
}

/** Shared PAGINATED Integration v1 client-list loop — exactly like <homelab-unifi-notes>/
 * scripts/check-clients.sh: `GET /clients?limit=200&offset=N`, looping while the returned page is
 * a full page (`limit` items), stopping the first time a page comes back short (or empty). No
 * envelope validation (`rawRequest`, not `legacyRequest` — Integration v1 has no legacy
 * `meta.rc` concept). Factored out (fix part 3) so the LOCAL and CLOUD Integration v1
 * client-list functions below share one loop instead of duplicating it — they differ only in
 * which URL builder they pass in (`localIntegrationV1Url` vs `cloudIntegrationV1Url`).
 * OPEN RISK (deferred to the architect's close-time live smoke, SC-008): it is UNVERIFIED
 * whether Integration v1's `/clients` endpoint lists a BLOCKED-AND-DISCONNECTED client at all —
 * if blocking a device also drops its network association, it may simply vanish from this
 * connected-clients list, breaking the "isBlocked=true confirmable via the poll" guarantee
 * ADR-053 §2 requires. This risk now applies EQUALLY to both the local and cloud paths (fix
 * removed the previously-documented legacy `stat/sta` alternative reconciliation source — the
 * cloud fallback is Integration v1 too now, per the same live evidence that motivated this fix)
 * — there is no longer a differently-shaped fallback to swap to if the live smoke finds this.
 */
async function listClientsIntegrationV1Paginated(
  urlBuilder: (path: string) => URL,
  apiKey: string,
  dispatcher: Agent | undefined
): Promise<RawUniFiClient[]> {
  const all: RawUniFiClient[] = [];
  let offset = 0;

  for (let page = 0; page < INTEGRATION_V1_MAX_PAGES; page++) {
    const url = urlBuilder("/clients");
    url.searchParams.set("limit", String(INTEGRATION_V1_PAGE_SIZE));
    url.searchParams.set("offset", String(offset));

    const body = await rawRequest(url, apiKey, dispatcher, { method: "GET" });
    const items = extractIntegrationV1Page(body);
    all.push(...items);

    if (items.length < INTEGRATION_V1_PAGE_SIZE) break;
    offset += INTEGRATION_V1_PAGE_SIZE;
  }

  return all;
}

/** LOCAL Integration v1 client list (PRIMARY, PROVEN — direct host connection). */
async function listClientsLocalIntegrationV1(
  config: UniFiClientConfig,
  dispatcher: Agent | undefined
): Promise<RawUniFiClient[]> {
  return listClientsIntegrationV1Paginated(
    (path) => localIntegrationV1Url(config, path),
    config.apiKey,
    dispatcher
  );
}

/** CLOUD Integration v1 client list (fix part 3 — was `listClientsCloudLegacy`, the LEGACY
 * `stat/sta` snake_case endpoint hitting a 404 URL, see `cloudLegacyUrl`'s doc comment for the
 * base-URL half of the bug). Beyond the wrong URL, that old implementation carried a SECOND
 * latent bug worth naming here even though it never shipped live: `stat/sta`'s snake_case
 * `{mac, ip, blocked,...}` payload landing through `normalize.ts`'s camelCase-first extraction
 * (`extractRawMac`/`extractRawBlocked`) would have worked only because those extractors already
 * fall back to the snake_case field names defensively — a coincidence, not a designed-for cloud
 * path, since `normalize.ts`'s own doc comment frames the snake_case branch as "command
 * responses", not "the cloud client list". Routing the cloud fallback through Integration v1
 * (same camelCase shape as local) removes that coincidence entirely — `normalize.ts` needs no
 * change, the two client-list paths are now shape-identical.
 */
async function listClientsCloudIntegrationV1(
  config: UniFiClientConfig,
  dispatcher: Agent | undefined
): Promise<RawUniFiClient[]> {
  return listClientsIntegrationV1Paginated(
    (path) => cloudIntegrationV1Url(config, path),
    config.apiKey,
    dispatcher
  );
}

/** Block/unblock via the LEGACY command path (block-sta/unblock-sta) — LOCAL when
 * `unifi.host` is set (docs/access.md "Legacy local command path"), CLOUD otherwise. Always
 * envelope-validated (`legacyRequest`) — neither base's command endpoint is Integration v1.
 * Review N1 (v1 parity, `apps/api/src/lib/unifi/sta.ts`): the stamgr endpoint requires lowercase
 * hex MACs — v1's `blockSta`/`unblockSta` lowercase defensively so "callers do NOT need to
 * normalize beforehand". This repo's `register` already canonicalizes to uppercase before
 * storage, so an upstream MAC reaching here is uppercase by construction today — but nothing
 * pinned the invariant AT this seam specifically. Lowercase here too, matching v1 exactly, so the
 * seam is correct independent of what any future caller happens to pass in. */
async function sendStaCommand(
  config: UniFiClientConfig,
  dispatcher: Agent | undefined,
  cmd: "block-sta" | "unblock-sta",
  mac: string
): Promise<void> {
  const url = config.host
    ? localLegacyUrl(config, "/cmd/stamgr")
    : cloudLegacyUrl(config, "/cmd/stamgr");
  await legacyRequest(url, config.apiKey, dispatcher, {
    method: "POST",
    body: { cmd, mac: mac.toLowerCase() },
  });
}

/** Build a real `UniFiClient` bound to resolved credentials — directly unit-testable (the
 * matrix: local/cloud base selection, pagination, TLS dispatcher, healthy/rejected/unreachable
 * listClients + block/unblock) without the `isTestRuntime` throw below, mirroring
 * `buildForecastPort`'s split (`port.ts`).
 * The undici `Agent` (when `config.tlsInsecure`) is constructed ONCE here and reused across
 * every call this client instance makes — never per-request — though note `getUniFiClient`
 * itself builds a FRESH client (and thus a fresh Agent) on every call; this mirrors the
 * pre-existing stateless-factory shape (no connection-pool reuse across polls/actions) rather
 * than introducing a new inefficiency.
 */
export function buildUniFiClient(config: UniFiClientConfig): UniFiClient {
  // Never disable TLS unless the operator toggle explicitly says so (posture).
  const dispatcher = config.tlsInsecure
    ? new Agent({ connect: { rejectUnauthorized: false } })
    : undefined;

  return {
    async listClients(): Promise<RawUniFiClient[]> {
      return config.host
        ? listClientsLocalIntegrationV1(config, dispatcher)
        : listClientsCloudIntegrationV1(config, dispatcher);
    },
    async blockMac(mac: string): Promise<void> {
      await sendStaCommand(config, dispatcher, "block-sta", mac);
    },
    async unblockMac(mac: string): Promise<void> {
      await sendStaCommand(config, dispatcher, "unblock-sta", mac);
    },
  };
}

/** The production factory: the SOLE reader of the `unifi.*` operator config keys.
 * `apiKey`/`siteId` unset, or NEITHER `host` nor `consoleId` set → `null` (unconfigured, a
 * NORMAL state — every caller must treat this exactly like "not set up yet", never an error).
 * `host` (LOCAL Integration v1, PRIMARY) wins over `consoleId` (CLOUD, FALLBACK) when both
 * happen to be set. Constructing it while `isTestRuntime` is true THROWS immediately — a
 * forgotten `__setUniFiClientForTests` injection in a test must fail loud and instant, never
 * fall through to a real (CI-forbidden) network call that would otherwise just hang toward the
 * suite's timeout.
 */
export function createUniFiClient(): UniFiClient | null {
  if (isTestRuntime()) {
    throw new Error(
      "createUniFiClient(): refusing to construct a real fetch-based client under the test " +
        "runtime — inject a client via __setUniFiClientForTests() instead (research D2)."
    );
  }

  const apiKey = getOperatorConfig("unifi.apiKey");
  const siteId = getOperatorConfig("unifi.siteId");
  if (!apiKey || !siteId) return null;

  const host = getOperatorConfig("unifi.host");
  const consoleId = getOperatorConfig("unifi.consoleId");
  if (!host && !consoleId) return null;

  const tlsInsecureRaw = getOperatorConfig("unifi.tlsInsecure");
  const tlsInsecure = tlsInsecureRaw === "1" || tlsInsecureRaw === "true";

  return buildUniFiClient({ apiKey, siteId, host, consoleId, tlsInsecure });
}

let testClientOverride: UniFiClient | null | undefined;

/** Test-only injection seam (the `__setForecastPortForTests` precedent). `undefined` means "no
 * override" (falls through to `createUniFiClient`, which throws under the test runtime);
 * `null` is itself a valid injected value — "unconfigured", exactly what production sees when
 * no `unifi.*` operator config is set.
 */
export function __setUniFiClientForTests(client: UniFiClient | null | undefined): void {
  testClientOverride = client;
}

/** The single entrypoint `poll.ts`/`index.ts` call. Prefers an injected test client when one is
 * set (including an explicit `null`); otherwise falls through to `createUniFiClient` — which
 * throws under the test runtime if no injection was ever made (see above).
 */
export function getUniFiClient(): UniFiClient | null {
  if (testClientOverride !== undefined) return testClientOverride;
  return createUniFiClient();
}
