import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";

/** — host-API barrel process-boot smoke (ADR-059 / Constitution XIII
 * runnable aggregate, front-loaded per docs/features/plugin-system.md).
 * A REAL server process (the built `dist/server/index.js` entrypoint,
 * mirroring critical-flow.spec.ts's SC-003 lifecycle helpers) boots against a
 * fresh DB, applies migrations, and serves the SPA shell same-origin over a
 * real HTTP GET / — proving the app still boots + migrates + serves after
 * daily-messages was wired through `src/server/host-api`, which an
 * in-process `app.inject` cannot exercise (it never runs the entrypoint
 * guard / production bundle).
 */

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";
const BOOTSTRAP_KEY = process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key";
const ADMIN_PIN = process.env.ADMIN_PIN ?? "1234";

/** `node dist/server/index.js` — the real production entrypoint (npm start). */
const SERVER_ENTRY = resolve(process.cwd(), "dist", "server", "index.js");

const HEALTH_TIMEOUT_MS = 30_000;

/** Reserve an ephemeral free port so parallel/CI runs never collide on:3000. */
function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "localhost", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolvePort(port));
      } else {
        srv.close(() => reject(new Error("could not reserve a free port")));
      }
    });
  });
}

/** Spawn the real server against a given port + DATA_DIR; resolve once it
 * answers GET /health. Detects an early child exit and fails fast with the
 * captured stderr instead of a mystery health timeout.
 */
async function startServer(port: number, dataDir: string): Promise<ChildProcess> {
  const child = spawn("node", [SERVER_ENTRY], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "localhost",
      DATA_DIR: dataDir,
      // Pin the DB filename so an inherited absolute DATABASE_PATH can't divert
      // the child to a shared/alternate store (it resolves under DATA_DIR).
      DATABASE_PATH: "marplanner.db",
      MP_BOOTSTRAP_KEY: BOOTSTRAP_KEY,
      ADMIN_PIN,
      MP_ACCESS_TOKEN: ACCESS_TOKEN,
      // This spec spawns its own server, bypassing playwright.config.ts's
      // webServer.env — pin the kill-switch here too so no real scheduler
      // timers ever start (see src/server/index.ts's doc comment).
      SCHEDULER_DISABLED: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderr += String(d);
  });
  const exit: { done: boolean; code: number | null; signal: string | null } = {
    done: false,
    code: null,
    signal: null,
  };
  const onExit = (code: number | null, signal: string | null) => {
    exit.done = true;
    exit.code = code;
    exit.signal = signal;
  };
  child.once("exit", onExit);

  try {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exit.done) {
        throw new Error(
          `server exited before becoming healthy on :${port} ` +
            `(code=${exit.code}, signal=${exit.signal}). stderr:\n${stderr}`
        );
      }
      try {
        const res = await fetch(`http://localhost:${port}/health`);
        if (res.ok) {
          child.off("exit", onExit);
          return child;
        }
      } catch {
        // not accepting connections yet — keep polling
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(
      `server on :${port} never became healthy within ${HEALTH_TIMEOUT_MS}ms. stderr:\n${stderr}`
    );
  } catch (err) {
    child.off("exit", onExit);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    throw err;
  }
}

/** Terminate a spawned server and wait for the process to actually exit. */
async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((res) => child.once("exit", () => res()));
  child.kill("SIGTERM");
  let settled = false;
  await Promise.race([
    exited.then(() => {
      settled = true;
    }),
    new Promise<void>((res) => setTimeout(res, 5_000)),
  ]);
  if (!settled && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

test("process-boot: real server process boots + migrates + serves the shell, daily-messages wired through the host-API barrel", async () => {
  test.setTimeout(60_000);

  if (!ACCESS_TOKEN.startsWith("mpg-")) {
    throw new Error(
      `MP_ACCESS_TOKEN must be an "mpg-" token (ADR-037) for the gate to be passable; got "${ACCESS_TOKEN}".`
    );
  }
  if (!BOOTSTRAP_KEY.startsWith("mpk-")) {
    throw new Error(`MP_BOOTSTRAP_KEY must be an "mpk-" key; got "${BOOTSTRAP_KEY}".`);
  }
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(
      `Built server missing at ${SERVER_ENTRY}. Run \`npm run build\` first ` +
        `(Playwright's configured webServer does this before the suite).`
    );
  }

  const dataDir = mkdtempSync(join(tmpdir(), "mp-hostapi-e2e-"));
  const port = await getFreePort();
  const base = `http://localhost:${port}`;

  const server = await startServer(port, dataDir);
  try {
    // Migrations applied cleanly against the fresh DB: the daily_messages
    // table (the barrel-wired plugin's own table) exists on disk.
    const db = new Database(join(dataDir, "marplanner.db"), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'daily_messages'")
        .get();
      expect(table).toBeDefined();
    } finally {
      db.close();
    }

    // Pass the access gate (POST /gate, ADR-037), then serve the SPA shell
    // same-origin over a real HTTP GET / (never app.inject — proves the
    // production bundle + entrypoint guard, not just a Fastify handler).
    const gateRes = await fetch(`${base}/gate`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent(ACCESS_TOKEN)}`,
      redirect: "manual",
    });
    expect(gateRes.status).toBe(303);
    const setCookie = gateRes.headers.get("set-cookie");
    if (!setCookie) throw new Error("gate POST did not set the gate cookie");
    const gateCookie = setCookie.split(";")[0];

    const shellRes = await fetch(`${base}/`, { headers: { cookie: gateCookie } });
    expect(shellRes.status).toBe(200);
    const body = await shellRes.text();
    expect(body.toLowerCase()).toContain("<!doctype html");
  } finally {
    await stopServer(server);
  }
});
