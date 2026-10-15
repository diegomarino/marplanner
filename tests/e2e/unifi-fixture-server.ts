import https from "node:https";
import type { Server } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** docs/features/network-devices.md — a tiny local HTTPS server standing in for the real
 * UniFi controller (no test tier performs real egress). Unlike
 * `weather-fixture-server.ts` (a plain-http stand-in — weather's port accepts an http override),
 * the network-devices production client (`src/server/modules/network-devices/client.ts`) always
 * builds an `https://<host>` origin for the LOCAL Integration v1 base, so this fixture must be a
 * genuine (self-signed) HTTPS server.
 * FINDING (reported, not "fixed" here — see the network-devices.spec.ts docblock): the natural
 * choice, `client.ts`'s own `unifi.tlsInsecure` toggle (which constructs an `undici` npm-package
 * `Agent` and passes it as `fetch`'s `dispatcher`), THROWS at the real `fetch` call on this
 * repo's Node 24 (`TypeError: fetch failed` / `InvalidArgumentError: invalid onRequestStart
 * method`) — Node 24 bundles undici 7.29.0 internally for its global `fetch`, while the
 * `undici` npm package pinned in package.json is 8.10.2; passing an `Agent` built from the
 * newer npm package as the built-in fetch's `dispatcher` is a cross-major-version ABI mismatch.
 * This fixture therefore avoids that path entirely: it exposes `certPath` so the caller can set
 * `NODE_EXTRA_CA_CERTS` on the SPAWNED server process instead, letting Node's OWN default TLS
 * validation trust this self-signed cert with no custom dispatcher involved.
 * Serves exactly the two endpoints `client.ts` calls when `unifi.host` is set:
 * - `GET.../integration/v1/sites/:siteId/clients` — the LOCAL Integration v1 client-list read
 * (`listClientsLocalIntegrationV1`), paginated; this fixture always returns a single (short)
 * page so `client.ts`'s pagination loop stops after one call.
 * - `POST.../api/s/:siteId/cmd/stamgr` — the LEGACY block/unblock command path
 * (`sendStaCommand`), envelope-validated by `client.ts`'s `legacyRequest` (`{meta:{rc:'ok'}}`).
 * Tracks blocked state per MAC (case-insensitive) purely so a LATER poll would reflect a prior
 * block/unblock command — not required for the own assertions (which read the block/unblock
 * HTTP response body directly), but keeps the fixture honest rather than silently ignoring the
 * command's effect.
 */
export interface UnifiFixtureClient {
  macAddress: string;
  name: string;
  /** Initial blocked state (default false), so a spec or the dev fixture can start with a block. */
  isBlocked?: boolean;
}

export interface UnifiFixtureServer {
  /** `host:port`, no protocol — matches the shape `UNIFI_HOST` expects (`client.ts`'s * `normalizeHost` strips an accidental protocol prefix off an operator-supplied value; this
   * fixture supplies the bare form directly). */
  origin: string;
  /** Path to the self-signed cert this server presents — pass via `NODE_EXTRA_CA_CERTS` on the
   * SPAWNED server process's env (set before that process starts; Node reads it once at boot)
   * so the real client's default TLS validation trusts it. See this module's own docblock for
   * why `unifi.tlsInsecure`'s dispatcher-based bypass is NOT used here. Valid until `close`. */
  certPath: string;
  close(): Promise<void>;
}

export async function startUnifiFixtureServer(
  clients: UnifiFixtureClient[],
  options: { port?: number } = {}
): Promise<UnifiFixtureServer> {
  const certDir = mkdtempSync(join(tmpdir(), "mp-e2e-unifi-cert-"));
  const keyPath = join(certDir, "key.pem");
  const certPath = join(certDir, "cert.pem");
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-nodes",
        "-subj",
        "/CN=127.0.0.1",
        // Required: Node's TLS validation checks the certificate's SAN list, not just the
        // legacy CN field, when matching the connection's target IP (`checkServerIdentity`) —
        // without this, `NODE_EXTRA_CA_CERTS` trusts the CA but every connection still fails
        // ERR_TLS_CERT_ALTNAME_INVALID.
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      { stdio: "ignore" }
    );
  } catch (err) {
    rmSync(certDir, { recursive: true, force: true });
    throw new Error(
      "unifi-fixture-server: failed to generate a self-signed cert via openssl — is openssl on PATH?",
      { cause: err }
    );
  }

  const key = readFileSync(keyPath);
  const cert = readFileSync(certPath);

  /** mac (lowercase) -> isBlocked. */
  const blocked = new Map<string, boolean>(
    clients.map((c) => [c.macAddress.toLowerCase(), c.isBlocked ?? false])
  );

  const server: Server = https.createServer({ key, cert }, (req, res) => {
    const url = new URL(req.url ?? "/", "https://127.0.0.1");

    if (req.method === "GET" && url.pathname.endsWith("/clients")) {
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const page =
        offset === 0
          ? clients.map((c) => ({
              macAddress: c.macAddress,
              name: c.name,
              // Deliberately IP-rich — mirrors tests/helpers/unifi-fixtures.ts's own fixture, so
              // this fixture also exercises the structural IP drop (NETWORK-DEVICES-INV-06) for
              // any assertion the e2e spec chooses to make against it.
              ipAddress: "203.0.113.10",
              type: "WIRELESS",
              isBlocked: blocked.get(c.macAddress.toLowerCase()) ?? false,
            }))
          : []; // any subsequent page is short/empty — ends the client-list pagination loop
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: page }));
      return;
    }

    if (req.method === "POST" && url.pathname.endsWith("/cmd/stamgr")) {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body || "{}") as { cmd?: unknown; mac?: unknown };
          if (typeof parsed.mac === "string") {
            const mac = parsed.mac.toLowerCase();
            if (parsed.cmd === "block-sta") blocked.set(mac, true);
            if (parsed.cmd === "unblock-sta") blocked.set(mac, false);
          }
        } catch {
          // Malformed body — this fixture is not testing malformed-input handling; still
          // answer a normal "ok" envelope below.
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ meta: { rc: "ok" }, data: [] }));
      });
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found in unifi fixture server" }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("unifi fixture server did not report a usable address");
  }
  const origin = `127.0.0.1:${address.port}`;

  return {
    origin,
    certPath,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(certDir, { recursive: true, force: true });
    },
  };
}
