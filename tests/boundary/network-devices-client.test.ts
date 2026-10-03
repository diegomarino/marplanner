import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildUniFiClient,
  createUniFiClient,
  UniFiControllerRejectedError,
  UniFiControllerUnreachableError,
} from "../../src/server/modules/network-devices/client";

/** A legacy UniFi controller application-level failure riding inside an HTTP-200 JSON envelope
 * — `meta.rc !== "ok"`, never a non-2xx status. */
function legacyErrorEnvelope(msg: string): string {
  return JSON.stringify({ meta: { rc: "error", msg } });
}

/** docs/features/network-devices.md — UniFi controller client transport boundary tests
 * (FR-016/FR-019). the transport
 * itself (`request`/`buildUniFiClient`) had ZERO direct coverage — everything exercised it
 * only through `poll.ts`'s `pollOnce` with a fully injected `UniFiClient`, so a mutation
 * flipping the 401/403 branch to `UniFiControllerUnreachableError` (M7), or one that dropped
 * `createUniFiClient`'s `isTestRuntime` throw (M8), would have survived undetected. Both
 * are driven directly here against a stubbed global `fetch` — no real egress, ever (research
 * D2).
 */
/** Local stand-in for the DOM lib's `RequestInit` (a TYPE-only global with no runtime backing,
 * unlike `URL`/`Response`/`AbortSignal` — using it directly trips `no-undef` in this repo's
 * eslint config, which doesn't special-case type-only DOM lib identifiers). */
interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}

describe("network-devices UniFi client transport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const CONFIG = { apiKey: "test-api-key", consoleId: "console-1", siteId: "site-1" };

  function stubFetch(impl: (url: URL, init: FetchInit) => Response | Promise<Response>) {
    const spy = vi.fn(impl);
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  // ── createUniFiClient — unconfigured vs test-flag throw ──────

  describe("createUniFiClient", () => {
    it("all-unset operator config -> returns null (unconfigured, a NORMAL state)", async () => {
      // isTestRuntime reads VITEST from process.env via the host-api barrel — genuinely
      // "true" while running under vitest, so createUniFiClient would otherwise throw here
      // (fail-fast). Stub the barrel to simulate a NON-test runtime with fully
      // absent unifi.* config, isolating this test to the unconfigured branch specifically.
      vi.doMock("../../src/server/host-api", () => ({
        getOperatorConfig: () => undefined,
        isTestRuntime: () => false,
      }));
      vi.resetModules();
      const { createUniFiClient: freshCreate } =
        await import("../../src/server/modules/network-devices/client");
      expect(freshCreate()).toBeNull();
      vi.doUnmock("../../src/server/host-api");
      vi.resetModules();
    });

    it("partially-set operator config (missing siteId) -> still returns null", async () => {
      vi.doMock("../../src/server/host-api", () => ({
        getOperatorConfig: (key: string) =>
          key === "unifi.apiKey" ? "k" : key === "unifi.consoleId" ? "c" : undefined,
        isTestRuntime: () => false,
      }));
      vi.resetModules();
      const { createUniFiClient: freshCreate } =
        await import("../../src/server/modules/network-devices/client");
      expect(freshCreate()).toBeNull();
      vi.doUnmock("../../src/server/host-api");
      vi.resetModules();
    });

    it("FR-019 fail-fast: THROWS immediately under the test runtime, never falling through to a real fetch (M8 — reviewer's mutant must die)", () => {
      // No mocking here at all — this is the REAL isTestRuntime, which reads
      // process.env.VITEST — genuinely "true" in this suite. A mutant that removed or
      // inverted this throw would let createUniFiClient fall through to
      // getOperatorConfig's real (unset) values and silently return null instead of
      // throwing — this assertion is exactly what kills that mutant.
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      expect(() => createUniFiClient()).toThrow(/test runtime/i);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // ── buildUniFiClient.listClients — status matrix + body unwrap ─────────────

  describe("buildUniFiClient.listClients", () => {
    it("200 healthy -> unwraps the {data: [...]} envelope", async () => {
      const raw = [{ mac: "aa:bb:cc:dd:ee:01", blocked: false }];
      stubFetch(() => new Response(JSON.stringify({ data: raw }), { status: 200 }));

      const client = buildUniFiClient(CONFIG);
      const result = await client.listClients();

      expect(result).toEqual(raw);
    });

    it("a 200 body with no `data` array -> empty array, never a throw", async () => {
      stubFetch(() => new Response(JSON.stringify({ unrelated: true }), { status: 200 }));

      const client = buildUniFiClient(CONFIG);
      await expect(client.listClients()).resolves.toEqual([]);
    });

    it("401 -> UniFiControllerRejectedError (M7 — reviewer's 401->Unreachable inversion mutant must die)", async () => {
      stubFetch(() => new Response("unauthorized", { status: 401 }));

      const client = buildUniFiClient(CONFIG);
      await expect(client.listClients()).rejects.toBeInstanceOf(UniFiControllerRejectedError);
      // Explicitly NOT Unreachable — the exact inversion a mutant would produce.
      await expect(client.listClients()).rejects.not.toBeInstanceOf(
        UniFiControllerUnreachableError
      );
    });

    it("403 -> UniFiControllerRejectedError (distinct branch, both 401 and 403 must map the same way)", async () => {
      stubFetch(() => new Response("forbidden", { status: 403 }));

      const client = buildUniFiClient(CONFIG);
      await expect(client.listClients()).rejects.toBeInstanceOf(UniFiControllerRejectedError);
    });

    it("500 -> UniFiControllerUnreachableError, never Rejected", async () => {
      stubFetch(() => new Response("server error", { status: 500 }));

      const client = buildUniFiClient(CONFIG);
      await expect(client.listClients()).rejects.toBeInstanceOf(UniFiControllerUnreachableError);
      await expect(client.listClients()).rejects.not.toBeInstanceOf(UniFiControllerRejectedError);
    });

    it("a malformed (non-JSON) 200 body -> UniFiControllerUnreachableError", async () => {
      stubFetch(() => new Response("not json{{{", { status: 200 }));

      const client = buildUniFiClient(CONFIG);
      await expect(client.listClients()).rejects.toBeInstanceOf(UniFiControllerUnreachableError);
    });

    it("a timeout (AbortSignal fires, duck-typed TimeoutError) -> UniFiControllerUnreachableError", async () => {
      stubFetch(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            (init.signal as AbortSignal).addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "TimeoutError"));
            });
          })
      );

      const client = buildUniFiClient(CONFIG);
      await expect(client.listClients()).rejects.toBeInstanceOf(UniFiControllerUnreachableError);
    }, 8000);

    it("a genuine network-level rejection (not an abort) -> UniFiControllerUnreachableError", async () => {
      stubFetch(() => Promise.reject(new Error("ECONNREFUSED")));

      const client = buildUniFiClient(CONFIG);
      await expect(client.listClients()).rejects.toBeInstanceOf(UniFiControllerUnreachableError);
    });

    it("AbortSignal is wired on every request (research D2's fail-fast transport budget)", async () => {
      const spy = stubFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));

      const client = buildUniFiClient(CONFIG);
      await client.listClients();

      expect(spy).toHaveBeenCalledTimes(1);
      const [, init] = spy.mock.calls[0] as [URL, FetchInit];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });
  });

  // ── request shape — headers, URL, block/unblock command bodies (D3's load-bearing mechanism) ──

  describe("request shape", () => {
    it("listClients (CLOUD, no unifi.host): GET, X-API-KEY header present, URL targets the CLOUD connector's Integration v1 /clients under consoleId/siteId (fix #671 part 3)", async () => {
      const spy = stubFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));

      const client = buildUniFiClient(CONFIG);
      await client.listClients();

      const [url, init] = spy.mock.calls[0] as [URL, FetchInit];
      expect(init.method ?? "GET").toBe("GET");
      expect((init.headers as Record<string, string>)["X-API-KEY"]).toBe(CONFIG.apiKey);
      expect(url.pathname).toBe(
        `/v1/connector/consoles/${CONFIG.consoleId}/proxy/network/integration/v1/sites/${CONFIG.siteId}/clients`
      );
      expect(url.origin).toBe("https://api.ui.com");
      expect(url.searchParams.get("limit")).toBe("200");
      expect(url.searchParams.get("offset")).toBe("0");
    });

    it("blockMac (CLOUD): POST /cmd/stamgr with body {cmd: 'block-sta', mac} against the LEGACY site 'default', never unifi.siteId (fix #671 parts 1+2 — v1's proven shape)", async () => {
      const spy = stubFetch(() => new Response(JSON.stringify({}), { status: 200 }));

      const client = buildUniFiClient(CONFIG);
      await client.blockMac("aa:bb:cc:dd:ee:ff");

      const [url, init] = spy.mock.calls[0] as [URL, FetchInit];
      expect(init.method).toBe("POST");
      expect(url.pathname).toBe(
        `/v1/connector/consoles/${CONFIG.consoleId}/proxy/network/api/s/default/cmd/stamgr`
      );
      expect(url.pathname).not.toContain(CONFIG.siteId);
      expect(url.origin).toBe("https://api.ui.com");
      expect(JSON.parse(init.body as string)).toEqual({
        cmd: "block-sta",
        mac: "aa:bb:cc:dd:ee:ff",
      });
      expect((init.headers as Record<string, string>)["X-API-KEY"]).toBe(CONFIG.apiKey);
    });

    it("unblockMac: POST /cmd/stamgr with body {cmd: 'unblock-sta', mac}", async () => {
      const spy = stubFetch(() => new Response(JSON.stringify({}), { status: 200 }));

      const client = buildUniFiClient(CONFIG);
      await client.unblockMac("aa:bb:cc:dd:ee:ff");

      const [, init] = spy.mock.calls[0] as [URL, FetchInit];
      expect(JSON.parse(init.body as string)).toEqual({
        cmd: "unblock-sta",
        mac: "aa:bb:cc:dd:ee:ff",
      });
    });

    it("blockMac: an uppercase/mixed-case MAC is lowercased before the stamgr POST (review N1, v1 sta.ts parity — the stamgr endpoint requires lowercase hex)", async () => {
      const spy = stubFetch(() => new Response(JSON.stringify({}), { status: 200 }));

      const client = buildUniFiClient(CONFIG);
      await client.blockMac("AA:BB:CC:DD:EE:01");

      const [, init] = spy.mock.calls[0] as [URL, FetchInit];
      expect(JSON.parse(init.body as string)).toEqual({
        cmd: "block-sta",
        mac: "aa:bb:cc:dd:ee:01",
      });
    });

    it("encodes consoleId/siteId as URL path segments (defensive against URL-hostile operator config)", async () => {
      const spy = stubFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));

      const client = buildUniFiClient({ apiKey: "k", consoleId: "a/b", siteId: "c d" });
      await client.listClients();

      const [url] = spy.mock.calls[0] as [URL, FetchInit];
      expect(url.pathname).toBe(
        "/v1/connector/consoles/a%2Fb/proxy/network/integration/v1/sites/c%20d/clients"
      );
    });

    it("CLOUD legacy command path (block/unblock) encodes a URL-hostile consoleId, but the site segment stays the literal 'default' regardless of an equally URL-hostile siteId", async () => {
      const spy = stubFetch(() => new Response(JSON.stringify({}), { status: 200 }));

      const client = buildUniFiClient({ apiKey: "k", consoleId: "a/b", siteId: "c d" });
      await client.blockMac("aa:bb:cc:dd:ee:ff");

      const [url] = spy.mock.calls[0] as [URL, FetchInit];
      expect(url.pathname).toBe(
        "/v1/connector/consoles/a%2Fb/proxy/network/api/s/default/cmd/stamgr"
      );
    });
  });

  // ── legacy 200-envelope errors ────────────────

  describe("legacy 200-envelope application-level failures", () => {
    // NOTE (fix part 3): `listClients` is NEVER legacy-envelope-validated any more, on
    // EITHER base — the CLOUD fallback used to hit the LEGACY `stat/sta` endpoint (envelope
    // validated), but now hits Integration v1 (same as LOCAL), which has no `meta.rc` concept.
    // The two tests that used to pin the old CLOUD listClients-rejects-on-envelope-error
    // behavior are replaced below by a test proving the OPPOSITE — matching the pre-existing
    // LOCAL "listClients is NOT meta.rc-validated" test in the LOCAL Integration v1 section.
    // blockMac/unblockMac remain legacy-envelope-validated on BOTH bases (tests below, unchanged).

    it("listClients (CLOUD, no unifi.host): is NOT meta.rc-validated — Integration v1 has no legacy envelope concept, same as LOCAL (fix #671 part 3)", async () => {
      // A response that HAPPENS to carry a meta.rc error field alongside data must not be misread
      // as a legacy failure — the cloud client-list path is Integration v1 now, not legacy.
      stubFetch(
        () =>
          new Response(
            JSON.stringify({ meta: { rc: "error", msg: "api.err.LoginRequired" }, data: [] }),
            { status: 200 }
          )
      );

      const client = buildUniFiClient(CONFIG);
      await expect(client.listClients()).resolves.toEqual([]);
    });

    it("listClients: 200 + meta.rc === 'ok' (healthy envelope) still unwraps data normally", async () => {
      const raw = [{ mac: "aa:bb:cc:dd:ee:01", blocked: false }];
      stubFetch(
        () => new Response(JSON.stringify({ meta: { rc: "ok" }, data: raw }), { status: 200 })
      );

      const client = buildUniFiClient(CONFIG);
      await expect(client.listClients()).resolves.toEqual(raw);
    });

    it("blockMac: 200 + meta.rc error envelope -> throws, the caller never sees a false success (AC-02 class)", async () => {
      stubFetch(() => new Response(legacyErrorEnvelope("api.err.Unauthorized"), { status: 200 }));

      const client = buildUniFiClient(CONFIG);
      await expect(client.blockMac("aa:bb:cc:dd:ee:ff")).rejects.toBeInstanceOf(
        UniFiControllerRejectedError
      );
    });

    it("unblockMac: 200 + meta.rc error envelope -> throws, symmetric with blockMac", async () => {
      stubFetch(
        () => new Response(legacyErrorEnvelope("api.err.SomeOtherFailure"), { status: 200 })
      );

      const client = buildUniFiClient(CONFIG);
      await expect(client.unblockMac("aa:bb:cc:dd:ee:ff")).rejects.toBeInstanceOf(
        UniFiControllerUnreachableError
      );
    });

    it("a 200 body with no meta field at all is NOT this failure mode — falls through as a normal success", async () => {
      stubFetch(() => new Response(JSON.stringify({}), { status: 200 }));

      const client = buildUniFiClient(CONFIG);
      await expect(client.blockMac("aa:bb:cc:dd:ee:ff")).resolves.toBeUndefined();
    });
  });

  // ── LOCAL Integration v1 (PRIMARY, PROVEN — architect update 2026-09-05) ────
  //
  // <homelab-unifi-notes>/docs/access.md "API Local (Integration API v1)" +
  // scripts/check-clients.sh: the household's proven on-LAN path, base
  // https://<host>/proxy/network/integration/v1/sites/<siteId>, paginated
  // GET /clients?limit=200&offset=N, camelCase fields, {data:[...]} envelope
  // with NO meta.rc concept. Block/unblock has no Integration v1 equivalent
  // in the reference docs, so it stays on the legacy local command path
  // (docs/access.md "Legacy local command path").

  describe("LOCAL Integration v1 base selection + shape", () => {
    const LOCAL_CONFIG = { apiKey: "test-api-key", siteId: "site-1", host: "192.168.1.1" };

    describe("createUniFiClient base-selection matrix", () => {
      it("unifi.host set -> constructs a client (LOCAL primary)", async () => {
        vi.doMock("../../src/server/host-api", () => ({
          getOperatorConfig: (key: string) => {
            if (key === "unifi.apiKey") return "k";
            if (key === "unifi.siteId") return "s";
            if (key === "unifi.host") return "192.168.1.1";
            return undefined;
          },
          isTestRuntime: () => false,
        }));
        vi.resetModules();
        const { createUniFiClient: freshCreate } =
          await import("../../src/server/modules/network-devices/client");
        expect(freshCreate()).not.toBeNull();
        vi.doUnmock("../../src/server/host-api");
        vi.resetModules();
      });

      it("unifi.consoleId set, no unifi.host -> constructs a client (CLOUD fallback)", async () => {
        vi.doMock("../../src/server/host-api", () => ({
          getOperatorConfig: (key: string) => {
            if (key === "unifi.apiKey") return "k";
            if (key === "unifi.siteId") return "s";
            if (key === "unifi.consoleId") return "c";
            return undefined;
          },
          isTestRuntime: () => false,
        }));
        vi.resetModules();
        const { createUniFiClient: freshCreate } =
          await import("../../src/server/modules/network-devices/client");
        expect(freshCreate()).not.toBeNull();
        vi.doUnmock("../../src/server/host-api");
        vi.resetModules();
      });

      it("neither unifi.host nor unifi.consoleId set (apiKey+siteId present) -> null (unconfigured)", async () => {
        vi.doMock("../../src/server/host-api", () => ({
          getOperatorConfig: (key: string) => {
            if (key === "unifi.apiKey") return "k";
            if (key === "unifi.siteId") return "s";
            return undefined;
          },
          isTestRuntime: () => false,
        }));
        vi.resetModules();
        const { createUniFiClient: freshCreate } =
          await import("../../src/server/modules/network-devices/client");
        expect(freshCreate()).toBeNull();
        vi.doUnmock("../../src/server/host-api");
        vi.resetModules();
      });
    });

    it("host set -> listClients targets the LOCAL Integration v1 base, never the cloud", async () => {
      const spy = stubFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));

      const client = buildUniFiClient(LOCAL_CONFIG);
      await client.listClients();

      const [url, init] = spy.mock.calls[0] as [URL, FetchInit];
      expect(url.origin).toBe("https://192.168.1.1");
      expect(url.pathname).toBe(
        `/proxy/network/integration/v1/sites/${LOCAL_CONFIG.siteId}/clients`
      );
      expect(url.searchParams.get("limit")).toBe("200");
      expect(url.searchParams.get("offset")).toBe("0");
      expect((init.headers as Record<string, string>)["X-API-KEY"]).toBe(LOCAL_CONFIG.apiKey);
    });

    it("host set -> block/unblock still use the LOCAL legacy command path (no Integration v1 equivalent), against the LEGACY site 'default', never unifi.siteId (fix #671 part 1)", async () => {
      const spy = stubFetch(() => new Response(JSON.stringify({}), { status: 200 }));

      const client = buildUniFiClient(LOCAL_CONFIG);
      await client.blockMac("aa:bb:cc:dd:ee:ff");

      const [url, init] = spy.mock.calls[0] as [URL, FetchInit];
      expect(url.origin).toBe("https://192.168.1.1");
      expect(url.pathname).toBe("/proxy/network/api/s/default/cmd/stamgr");
      expect(url.pathname).not.toContain(LOCAL_CONFIG.siteId);
      expect(JSON.parse(init.body as string)).toEqual({
        cmd: "block-sta",
        mac: "aa:bb:cc:dd:ee:ff",
      });
    });

    it("host set -> the local legacy command path is STILL meta.rc-validated (Codex #660 P1 applies here too)", async () => {
      stubFetch(() => new Response(legacyErrorEnvelope("api.err.LoginRequired"), { status: 200 }));

      const client = buildUniFiClient(LOCAL_CONFIG);
      await expect(client.blockMac("aa:bb:cc:dd:ee:ff")).rejects.toBeInstanceOf(
        UniFiControllerRejectedError
      );
    });

    it("host set -> listClients is NOT meta.rc-validated — Integration v1 has no legacy envelope concept", async () => {
      // A response that HAPPENS to carry a meta.rc field alongside data must not be misread as
      // a legacy failure — Integration v1 doesn't use this convention at all.
      stubFetch(
        () => new Response(JSON.stringify({ meta: { rc: "error" }, data: [] }), { status: 200 })
      );

      const client = buildUniFiClient(LOCAL_CONFIG);
      await expect(client.listClients()).resolves.toEqual([]);
    });

    it("strips an accidental http(s):// prefix from the operator-supplied host", async () => {
      const spy = stubFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));

      const client = buildUniFiClient({ ...LOCAL_CONFIG, host: "https://192.168.1.1" });
      await client.listClients();

      const [url] = spy.mock.calls[0] as [URL, FetchInit];
      expect(url.origin).toBe("https://192.168.1.1");
    });

    describe("pagination (limit=200/offset, <homelab-unifi-notes>/scripts/check-clients.sh)", () => {
      function page(count: number, startAt: number): Array<{ macAddress: string }> {
        return Array.from({ length: count }, (_, i) => ({ macAddress: `mac-${startAt + i}` }));
      }

      it("two full pages then a short page stops the loop", async () => {
        const spy = stubFetch((url) => {
          const offset = Number(url.searchParams.get("offset"));
          const items =
            offset === 0 ? page(200, 0) : offset === 200 ? page(200, 200) : page(50, 400);
          return new Response(JSON.stringify({ data: items }), { status: 200 });
        });

        const client = buildUniFiClient(LOCAL_CONFIG);
        const result = await client.listClients();

        expect(spy).toHaveBeenCalledTimes(3); // 200 + 200 + 50(short) -> stop after the short page
        expect(result).toHaveLength(450);
        expect(result[0]).toEqual({ macAddress: "mac-0" });
        expect(result[449]).toEqual({ macAddress: "mac-449" });
      });

      it("a single short page (fewer than limit items) stops after ONE call", async () => {
        const spy = stubFetch(
          () => new Response(JSON.stringify({ data: [{ macAddress: "mac-0" }] }), { status: 200 })
        );

        const client = buildUniFiClient(LOCAL_CONFIG);
        const result = await client.listClients();

        expect(spy).toHaveBeenCalledTimes(1);
        expect(result).toHaveLength(1);
      });

      it("an empty first page stops immediately with an empty result", async () => {
        const spy = stubFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));

        const client = buildUniFiClient(LOCAL_CONFIG);
        const result = await client.listClients();

        expect(spy).toHaveBeenCalledTimes(1);
        expect(result).toEqual([]);
      });
    });

    describe("tlsInsecure -> undici Agent dispatcher (self-signed local controller cert)", () => {
      //: this sub-describe's ORIGINAL "passes a dispatcher on every request when
      // tlsInsecure is true" test stubbed `globalThis.fetch` and asserted against IT — but
      // `rawRequest` never actually calls `globalThis.fetch` on the tlsInsecure path (it calls
      // undici's OWN `fetch`, exactly the fix for — see client.ts's `rawRequest` doc
      // comment), so that test's stub spy was never invoked and its assertion was vacuous by
      // construction (would have passed against ANY tlsInsecure behavior, including the
      // pre- broken one, since `spy.mock.calls[0]` from an unrelated earlier call in the
      // same `describe` happened to satisfy it). Replaced below with a test that mocks
      // undici's OWN `fetch` export (keeping its real `Agent`) so the assertion is actually
      // wired to the code path it claims to cover, with no real network — the REAL dispatcher
      // (genuine TLS, no mocks at all) is exercised separately in
      // tests/integration/network-devices-client-tls.test.ts.
      it("routes the tlsInsecure request through undici's OWN fetch, with a dispatcher (mocked undici.fetch — no real network)", async () => {
        const undiciFetchSpy = vi.fn(
          async (_url: URL, _init: { dispatcher?: unknown }) =>
            new Response(JSON.stringify({ data: [] }), { status: 200 })
        );
        vi.doMock("undici", async (importOriginal) => {
          const actual = await importOriginal<typeof import("undici")>();
          return { ...actual, fetch: undiciFetchSpy };
        });
        vi.resetModules();
        const { buildUniFiClient: freshBuild } =
          await import("../../src/server/modules/network-devices/client");

        const client = freshBuild({ ...LOCAL_CONFIG, tlsInsecure: true });
        await client.listClients();

        expect(undiciFetchSpy).toHaveBeenCalledTimes(1);
        const [, init] = undiciFetchSpy.mock.calls[0] as [URL, { dispatcher?: unknown }];
        expect(init.dispatcher).toBeDefined();

        vi.doUnmock("undici");
        vi.resetModules();
      });

      it("passes NO dispatcher when tlsInsecure is false/omitted — never disable TLS unless the operator says so", async () => {
        const spy = stubFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));

        const client = buildUniFiClient(LOCAL_CONFIG); // tlsInsecure omitted
        await client.listClients();

        const [, init] = spy.mock.calls[0] as [URL, FetchInit & { dispatcher?: unknown }];
        expect(init.dispatcher).toBeUndefined();
      });
    });
  });

  // ──: the dispatcher-forwarding coverage above only exercises
  // `listClientsLocalIntegrationV1`'s OWN call to `rawRequest(url, config.apiKey, dispatcher,
  //...)`. The CLOUD client-list path (now `listClientsCloudIntegrationV1`, fix part 3 — was
  // `listClientsCloudLegacy`) and `sendStaCommand` (block/unblock — shared by BOTH local and cloud
  // command URLs) each make their OWN, separate call to `rawRequest`/`legacyRequest` — a mutant
  // hardcoding `undefined` at either call site (instead of forwarding `dispatcher`) survived the
  // whole suite, since nothing previously exercised those two specific paths with
  // `tlsInsecure: true`. Verified RED against each mutant individually (temporarily hardcoded
  // `undefined` at the respective call site, observed the assertion below fail, reverted clean).
  describe("tlsInsecure dispatcher reaches EVERY legacy request path (PR-G review fold)", () => {
    /** Mocks undici's OWN `fetch` export (keeping its real `Agent`, same pattern as the
     * Integration-v1 dispatcher test above), imports a FRESH `client.ts` bound to the mock, runs
     * `body`, and always tears the mock down again — even if `body` throws — so a failed
     * assertion can never leak the mock into a later test . */
    async function withMockedUndiciFetch<T>(
      body: (
        freshBuild: typeof buildUniFiClient,
        undiciFetchSpy: ReturnType<typeof vi.fn>
      ) => Promise<T>
    ): Promise<T> {
      const undiciFetchSpy = vi.fn(
        async (_url: URL, _init: { dispatcher?: unknown }) =>
          new Response(JSON.stringify({ data: [] }), { status: 200 })
      );
      vi.doMock("undici", async (importOriginal) => {
        const actual = await importOriginal<typeof import("undici")>();
        return { ...actual, fetch: undiciFetchSpy };
      });
      vi.resetModules();
      try {
        const { buildUniFiClient: freshBuild } =
          await import("../../src/server/modules/network-devices/client");
        return await body(freshBuild, undiciFetchSpy);
      } finally {
        vi.doUnmock("undici");
        vi.resetModules();
      }
    }

    it("listClientsCloudIntegrationV1 (CLOUD client-list, no unifi.host) forwards the dispatcher", async () => {
      await withMockedUndiciFetch(async (freshBuild, undiciFetchSpy) => {
        const client = freshBuild({ ...CONFIG, tlsInsecure: true });
        await client.listClients();

        expect(undiciFetchSpy).toHaveBeenCalledTimes(1);
        const [, init] = undiciFetchSpy.mock.calls[0] as [URL, { dispatcher?: unknown }];
        expect(init.dispatcher).toBeDefined();
      });
    });

    it("sendStaCommand (blockMac) forwards the dispatcher", async () => {
      await withMockedUndiciFetch(async (freshBuild, undiciFetchSpy) => {
        const client = freshBuild({ ...CONFIG, tlsInsecure: true });
        await client.blockMac("aa:bb:cc:dd:ee:ff");

        expect(undiciFetchSpy).toHaveBeenCalledTimes(1);
        const [, init] = undiciFetchSpy.mock.calls[0] as [URL, { dispatcher?: unknown }];
        expect(init.dispatcher).toBeDefined();
      });
    });
  });

  // ──: unifi.siteId must never leak into a LEGACY URL — the legacy controller API
  // takes the site NAME "default", never the Integration v1 site UUID (see client.ts's
  // `LEGACY_SITE` doc comment for the v1 citation). `DISTINCTIVE_SITE_ID` below is deliberately
  // never equal to "default", so any accidental use of `config.siteId` in a legacy URL builder
  // would show up as a distinct, wrong path segment — this is the RED-proof for fix part 1.
  describe("LEGACY_SITE — unifi.siteId never appears in any legacy URL (issue #671)", () => {
    const DISTINCTIVE_SITE_ID = "integration-v1-site-uuid-not-default";

    it("LOCAL legacy command path (block/unblock) uses the literal site 'default', never unifi.siteId", async () => {
      const spy = stubFetch(() => new Response(JSON.stringify({}), { status: 200 }));

      const client = buildUniFiClient({
        apiKey: "k",
        siteId: DISTINCTIVE_SITE_ID,
        host: "192.168.1.1",
      });
      await client.blockMac("aa:bb:cc:dd:ee:ff");

      const [url] = spy.mock.calls[0] as [URL, FetchInit];
      expect(url.pathname).toBe("/proxy/network/api/s/default/cmd/stamgr");
      expect(url.pathname).not.toContain(DISTINCTIVE_SITE_ID);
    });

    it("CLOUD legacy command path (block/unblock) uses the literal site 'default', never unifi.siteId", async () => {
      const spy = stubFetch(() => new Response(JSON.stringify({}), { status: 200 }));

      const client = buildUniFiClient({
        apiKey: "k",
        siteId: DISTINCTIVE_SITE_ID,
        consoleId: "console-1",
      });
      await client.unblockMac("aa:bb:cc:dd:ee:ff");

      const [url] = spy.mock.calls[0] as [URL, FetchInit];
      expect(url.pathname).toBe(
        "/v1/connector/consoles/console-1/proxy/network/api/s/default/cmd/stamgr"
      );
      expect(url.pathname).not.toContain(DISTINCTIVE_SITE_ID);
    });

    it("CLOUD Integration v1 client-list path DOES use unifi.siteId (the Integration v1 UUID, not the legacy site name) — the one place it belongs", async () => {
      const spy = stubFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));

      const client = buildUniFiClient({
        apiKey: "k",
        siteId: DISTINCTIVE_SITE_ID,
        consoleId: "console-1",
      });
      await client.listClients();

      const [url] = spy.mock.calls[0] as [URL, FetchInit];
      expect(url.pathname).toBe(
        `/v1/connector/consoles/console-1/proxy/network/integration/v1/sites/${DISTINCTIVE_SITE_ID}/clients`
      );
    });

    it("LOCAL Integration v1 client-list path DOES use unifi.siteId, same as CLOUD", async () => {
      const spy = stubFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));

      const client = buildUniFiClient({
        apiKey: "k",
        siteId: DISTINCTIVE_SITE_ID,
        host: "192.168.1.1",
      });
      await client.listClients();

      const [url] = spy.mock.calls[0] as [URL, FetchInit];
      expect(url.pathname).toBe(
        `/proxy/network/integration/v1/sites/${DISTINCTIVE_SITE_ID}/clients`
      );
    });
  });
});
