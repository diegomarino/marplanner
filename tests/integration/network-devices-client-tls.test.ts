import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildUniFiClient,
  UniFiControllerUnreachableError,
} from "../../src/server/modules/network-devices/client";
import { SELF_SIGNED_CERT, SELF_SIGNED_KEY } from "../helpers/self-signed-tls-fixture";

/** — de-vacuized `tlsInsecure` coverage. The existing
 * tests/boundary/network-devices-client.test.ts suite spies on `globalThis.fetch`, so the REAL
 * dispatcher (an undici `Agent`, `buildUniFiClient`) never actually runs — a mutant (or, in this
 * case, a genuine bug: the built-in `fetch` bundles Node's INTERNAL undici, a different major
 * from the npm `undici` package this Agent is constructed from, and passing an Agent across
 * that boundary throws on Node 24) would have survived every one of those tests undetected. This
 * test instead spins a REAL local HTTPS server presenting a self-signed cert and drives
 * `buildUniFiClient(...).listClients` against it over actual TLS — no mocked fetch, no mocked
 * dispatcher.
 * Placed under tests/integration/ (not tests/boundary/) per this repo's tests/integration
 * precedent of spinning real local servers (e.g. tests/integration/entrypoint.test.ts,
 * tests/integration/daily-briefing-catchup-e2e.test.ts) — a loopback HTTPS server on
 * 127.0.0.1 is NOT egress (nothing leaves the host), so this stays hermetic and CI-safe.
 * RED-before-GREEN evidence (recorded at authoring time): run against the unfixed
 * `client.ts` (built-in `fetch` receiving the npm-undici `Agent` directly) — the
 * "tlsInsecure: true -> resolves" half of the test below FAILS, rejecting with
 * `UniFiControllerUnreachableError` (wrapping `TypeError: fetch failed` /
 * `InvalidArgumentError: invalid onRequestStart method`) instead of resolving.
 * the "tlsInsecure: false -> rejects" half is a REASON-BLIND negative control
 * on its own — it passes identically whether the server is genuinely up and rejecting the
 * connection on TLS-trust grounds, or simply not there at all (a dead port also makes `fetch`
 * reject, landing in the exact same `UniFiControllerUnreachableError` branch). Fixed by driving
 * BOTH clients against the SAME live fixture-server instance inside ONE test, positive case
 * first: the positive assertion resolving proves the server was up and answering at the moment
 * the negative assertion's rejection is observed immediately after — a dead port could not have
 * produced the positive result.
 */
describe("network-devices UniFi client — real TLS dispatcher (issue #665)", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  /** Starts a local HTTPS server presenting the self-signed fixture cert, answering every
   * request with an Integration-v1-shaped empty page (`{ data: [] }`) — enough for
   * `listClientsLocalIntegrationV1` to resolve after exactly one request (a short first page
   * stops the pagination loop immediately). Returns the bare `host:port` string
   * `buildUniFiClient`'s `config.host` expects (no scheme — `normalizeHost` would strip one
   * anyway, but the real operator-supplied shape never carries one either). */
  async function startFixtureServer(): Promise<string> {
    server = createServer({ cert: SELF_SIGNED_CERT, key: SELF_SIGNED_KEY }, (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server!.address() as AddressInfo;
    return `127.0.0.1:${port}`;
  }

  it("same live fixture server: tlsInsecure:true resolves, tlsInsecure:false rejects — proves the negative result is a genuine TLS-trust failure, not a dead port", async () => {
    const host = await startFixtureServer();

    const insecureClient = buildUniFiClient({
      apiKey: "test-api-key",
      siteId: "site-1",
      host,
      tlsInsecure: true,
    });
    const secureClient = buildUniFiClient({
      apiKey: "test-api-key",
      siteId: "site-1",
      host,
      tlsInsecure: false,
    });

    // POSITIVE case first, against this exact still-running server instance (never closed or
    // recreated in between): resolving here proves the server was up and correctly answering
    // requests. The NEGATIVE case immediately after targets the SAME `host`/server, so its
    // rejection can only be the TLS-trust failure it claims to be — a dead port would have
    // failed the positive case too.
    await expect(insecureClient.listClients()).resolves.toEqual([]);
    await expect(secureClient.listClients()).rejects.toBeInstanceOf(
      UniFiControllerUnreachableError
    );
  });
});
