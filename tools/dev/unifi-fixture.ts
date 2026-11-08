/**
 * DEV-only: run a local fake UniFi controller so the Network devices admin page can be exercised
 * without real hardware (docs/features/network-devices.md, "Exercising the page without a
 * controller"). It reuses the e2e fixture server (a self-signed HTTPS controller), serves a stable
 * demo client list, and, with `--api <origin>`, registers demo devices and blocks one through the
 * real API.
 *
 *   npm run dev:unifi-fixture -- --api http://127.0.0.1:3100
 */
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import {
  startUnifiFixtureServer,
  type UnifiFixtureClient,
} from "../../tests/e2e/unifi-fixture-server";

const FRESH_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 2_000;

/** Locally administered MACs, so they never collide with a real vendor OUI. The last client is
 * unnamed on purpose (the controller reports no name, so the page shows its unnamed label). */
const DEMO_CLIENTS: UnifiFixtureClient[] = [
  { macAddress: "02:00:5e:10:00:01", name: "Homer's iPhone" },
  { macAddress: "02:00:5e:10:00:02", name: "Bart's Tablet" },
  { macAddress: "02:00:5e:10:00:03", name: "Lisa's Chromebook" },
  { macAddress: "02:00:5e:10:00:04", name: "Living Room TV" },
  { macAddress: "02:00:5e:10:00:05", name: "Guest Phone" },
  { macAddress: "02:00:5e:10:00:06", name: "" },
];

const DEMO_MEMBERS: Record<string, string> = {
  "02:00:5e:10:00:01": "demo:member:homer",
  "02:00:5e:10:00:02": "demo:member:bart",
  "02:00:5e:10:00:03": "demo:member:lisa",
};

function usage(): string {
  return `Usage: npm run dev:unifi-fixture -- [--port <n>] [--api <origin>] [--no-register]

Starts a fake UniFi controller with six demo clients (one unnamed) and prints the environment to
start \`npm run dev\` with. Start THIS tool first, then the dev server with the printed env.

  --port <n>       fixed controller port (default: a free port)
  --api <origin>   dev server origin, e.g. http://127.0.0.1:3100: waits for a fresh live cache,
                   then registers the first four demo clients and blocks "Bart's Tablet"
  --no-register    with --api, skip the registration step
  -h, --help       this text

Limits: a "not detected" device cannot be produced this way (registration needs the device in
the live cache); the component tests cover that state. The certificate is regenerated on every
run, so restart the dev server after restarting this tool. UNIFI_TLS_INSECURE is not used (Node 24
undici mismatch, see tests/e2e/unifi-fixture-server.ts); NODE_EXTRA_CA_CERTS is.
`;
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Cookie transport: Bearer is accepted only on `/api/plugins*` (docs/operations.md). The tool
 * provisions a normal device key with the bootstrap key, like a kiosk does on first connect
 * (network-devices accepts the household device key, ADR-058), and returns its cookie header. */
async function provisionCookie(base: string): Promise<string> {
  const token = process.env.MP_ACCESS_TOKEN?.trim() ?? "";
  const bootstrapKey = process.env.MP_BOOTSTRAP_KEY?.trim() ?? "";
  const gate = `mp_gate=${createHash("sha256").update(token).digest("hex")}`;
  const label = hostname().trim().slice(0, 80);
  const res = await fetch(`${base}/api/auth/provision`, {
    method: "POST",
    headers: {
      cookie: gate,
      authorization: `Bearer ${bootstrapKey}`,
      ...(label ? { "content-type": "application/json" } : {}),
    },
    // Name the key after this machine so Admin → Access keys can tell it apart.
    ...(label ? { body: JSON.stringify({ label }) } : {}),
  });
  if (!res.ok) {
    throw new Error(
      `Provisioning failed (HTTP ${res.status}): check MP_ACCESS_TOKEN and MP_BOOTSTRAP_KEY and that the dev server uses them.`
    );
  }
  const device = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith("mp_device_key="));
  if (!device) throw new Error("Provisioning did not set an mp_device_key cookie.");
  return `${gate}; ${device}`;
}

async function registerDemoDevices(api: string): Promise<void> {
  const base = api.replace(/\/$/, "");
  const refused = () => new Error("The device key was refused by the network devices API.");
  console.log(`Waiting for the dev server at ${base} ...`);
  let cookie = "";
  const upDeadline = Date.now() + FRESH_TIMEOUT_MS;
  while (cookie === "") {
    try {
      cookie = await provisionCookie(base);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("Provisioning") || Date.now() > upDeadline) throw err;
      await sleep(POLL_INTERVAL_MS);
    }
  }
  const headers = { cookie, "content-type": "application/json" };

  console.log(`Waiting up to ${FRESH_TIMEOUT_MS / 1000}s for a fresh live cache at ${base} ...`);
  const deadline = Date.now() + FRESH_TIMEOUT_MS;
  let fresh = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/network-devices/live-clients`, { headers });
      if (res.status === 401 || res.status === 403) throw refused();
      if (res.ok) {
        const body = (await res.json()) as { state?: string };
        if (body.state === "fresh") {
          fresh = true;
          break;
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("The device key")) throw err;
      // The dev server may not be up yet: keep retrying until the deadline.
    }
    await sleep(POLL_INTERVAL_MS);
  }
  if (!fresh) throw new Error("The live cache never became fresh: is the scheduler enabled?");
  console.log("Live cache is fresh.");

  const membersRes = await fetch(`${base}/api/members`, { headers });
  if (membersRes.status === 401 || membersRes.status === 403) throw refused();
  const members = membersRes.ok ? ((await membersRes.json()) as { id: string }[]) : [];
  const memberIds = new Set(members.map((m) => m.id));

  let bartId: string | null = null;
  for (const client of DEMO_CLIENTS.slice(0, 4)) {
    const mac = client.macAddress;
    const wanted = DEMO_MEMBERS[mac];
    const res = await fetch(`${base}/api/network-devices`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        mac,
        alias: client.name,
        memberId: wanted && memberIds.has(wanted) ? wanted : null,
      }),
    });
    if (res.status === 401 || res.status === 403) throw refused();
    if (res.status === 409) {
      console.log(`  already registered: ${client.name}`);
      continue;
    }
    if (!res.ok) throw new Error(`register ${client.name}: HTTP ${res.status}`);
    const device = (await res.json()) as { id: string };
    if (mac === "02:00:5e:10:00:02") bartId = device.id;
    console.log(`  registered: ${client.name}`);
  }

  if (bartId === null) {
    const list = await fetch(`${base}/api/network-devices`, { headers });
    const body = (await list.json()) as { devices: { id: string; mac: string }[] };
    bartId = body.devices.find((d) => d.mac === "02:00:5e:10:00:02")?.id ?? null;
  }
  if (bartId !== null) {
    // No body, so no JSON content-type: Fastify answers 400 to an empty JSON body.
    const res = await fetch(`${base}/api/network-devices/${bartId}/block`, {
      method: "POST",
      headers: { cookie: headers.cookie },
    });
    console.log(res.ok ? "  blocked: Bart's Tablet" : `  block failed: HTTP ${res.status}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // No .env.local: rely on the process environment.
  }

  const port = Number(flagValue(args, "--port") ?? "0");
  const api = flagValue(args, "--api");

  const fixture = await startUnifiFixtureServer(DEMO_CLIENTS, { port });
  const origin = fixture.origin;
  console.log(
    `UniFi fixture listening on ${origin}. Start the dev server in ANOTHER terminal with:`
  );
  console.log(
    `  UNIFI_API_KEY=fixture-key UNIFI_SITE_ID=default UNIFI_HOST=${origin} ` +
      `NODE_EXTRA_CA_CERTS=${fixture.certPath} npm run dev`
  );
  console.log(
    "The certificate is regenerated on every run: restart the dev server after restarting this tool."
  );

  const shutdown = () => {
    void fixture.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  if (api && !args.includes("--no-register")) {
    try {
      await registerDemoDevices(api);
      console.log("Done. Leave this tool running so the live cache keeps a controller to poll.");
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
