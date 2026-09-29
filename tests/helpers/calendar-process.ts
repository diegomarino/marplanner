import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { buildApp } from "../../src/server/app";
import { reconcileBootstrap } from "../../src/server/auth/reconcile";
import { runMigrations } from "../../src/server/db/migrate";

const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port <= 0) throw new Error("PORT must be a positive integer");

const configuredFeedUrl = "https://calendar.example.test/subscription.ics";
const fixtureTemplate = readFileSync(
  resolve(process.cwd(), "tests/fixtures/calendar/tracer.ics"),
  "utf8"
);

function formatIcsInstant(value: Date): string {
  return value
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function currentFixture(): string {
  const start = new Date(Date.now() + 24 * 60 * 60 * 1_000);
  start.setUTCHours(9, 0, 0, 0);
  const end = new Date(start.getTime() + 60 * 60 * 1_000);
  return fixtureTemplate
    .replace("20260928T090000Z", formatIcsInstant(start))
    .replace("20260928T100000Z", formatIcsInstant(end));
}

let controlledRequests = 0;
const fixtureServer = createServer((_request, response) => {
  controlledRequests += 1;
  response.writeHead(200, { "content-type": "text/calendar; charset=utf-8" });
  response.end(currentFixture());
});
await new Promise<void>((resolveListen, reject) => {
  fixtureServer.once("error", reject);
  fixtureServer.listen(0, "127.0.0.1", resolveListen);
});
const fixtureAddress = fixtureServer.address();
if (!fixtureAddress || typeof fixtureAddress === "string") {
  throw new Error("Controlled calendar fixture did not bind to a TCP port");
}

runMigrations();
reconcileBootstrap();

const app = await buildApp({
  calendarFeed: {
    lookup: async (hostname: string) => {
      if (hostname !== "calendar.example.test") throw new Error("unexpected synthetic hostname");
      return [{ address: "93.184.216.34", family: 4 }];
    },
    transport: async (url: URL) => {
      if (url.toString() !== configuredFeedUrl) throw new Error("unexpected configured feed");
      const response = await fetch(`http://127.0.0.1:${fixtureAddress.port}/calendar.ics`);
      if (!response.ok) throw new Error("controlled fixture unavailable");
      process.stdout.write("calendar-fixture-request\n");
      return response.text();
    },
    phaseDelayMs: 75,
  },
} as Parameters<typeof buildApp>[0] & {
  calendarFeed: {
    lookup: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
    transport: (url: URL) => Promise<string>;
    phaseDelayMs: number;
  };
});

await app.listen({ port, host: "127.0.0.1" });
process.stdout.write("calendar-harness-ready\n");

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.close();
  await new Promise<void>((resolveClose, reject) => {
    fixtureServer.close((error) => (error ? reject(error) : resolveClose()));
  });
  process.stdout.write(`calendar-fixture-total ${controlledRequests}\n`);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
