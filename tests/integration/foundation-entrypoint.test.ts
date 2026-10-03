import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const expected = JSON.parse(
  readFileSync(resolve("tests/fixtures/assembly-cohort.json"), "utf8")
) as {
  batch: string;
  installedPluginIds: string[];
  registeredJobIds: string[];
  coreRoutes: Array<{ method: string; path: string }>;
  pluginRoutes: Array<{ method: string; path: string }>;
  familyRouteIds: string[];
  adminRouteIds: string[];
};
const entry = resolve("dist/server/index.js");
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No test port"));
      server.close(() => resolvePort(address.port));
    });
  });
}

function signal(child: ChildProcess, name: "SIGINT" | "SIGKILL") {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, name);
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill(name);
  }
}

async function hardKill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    signal(child, "SIGKILL");
    return;
  }
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  signal(child, "SIGKILL");
  await exited;
}

async function boot(dataDir: string, port: number, overrides: Record<string, string> = {}) {
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      DATABASE_PATH: "marplanner.db",
      HOST: "127.0.0.1",
      PORT: String(port),
      SCHEDULER_DISABLED: "0",
      MP_ACCESS_TOKEN: "mpg-synthetic-access-token",
      MP_BOOTSTRAP_KEY: "mpk-synthetic-bootstrap-key",
      ...overrides,
    },
  });
  let log = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    log += String(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    log += String(chunk);
  });
  const exit = new Promise<{ code: number | null; signal: string | null }>((done) => {
    child.once("exit", (code, endedBy) => done({ code, signal: endedBy }));
  });
  const waitLog = async (needle: string) => {
    for (let i = 0; i < 200; i += 1) {
      if (log.includes(needle)) return;
      if (child.exitCode !== null) throw new Error(`Process exited before ${needle}: ${log}`);
      await delay(50);
    }
    throw new Error(`Timed out waiting for ${needle}: ${log}`);
  };
  try {
    for (let i = 0; i < 200; i += 1) {
      if (child.exitCode !== null) throw new Error(`Process exited before health: ${log}`);
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok)
          return { child, exit, waitLog, log: () => log };
      } catch {
        /* startup has not listened yet */
      }
      await delay(50);
    }
    throw new Error(`Timed out waiting for health: ${log}`);
  } catch (error) {
    await hardKill(child);
    throw error;
  }
}

describe("built foundation entrypoint", () => {
  let child: ChildProcess | undefined;
  let dataDir: string | undefined;
  afterEach(async () => {
    if (child) await hardKill(child);
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    child = undefined;
    dataDir = undefined;
  });
  const prepare = async () => {
    dataDir = mkdtempSync(join(tmpdir(), "mp-foundation-"));
    return { dataDir, port: await freePort() };
  };

  it("serves reviewed core routes, isolates static assets, and drains both smoke writes on SIGINT", async () => {
    expect(existsSync(entry)).toBe(true);
    expect(expected.batch).toBe("BFULL");
    expect(expected.installedPluginIds).toHaveLength(9);
    expect(expected.familyRouteIds).toEqual(["home", "calendar", "chores", "meals"]);
    expect(expected.registeredJobIds).toHaveLength(8);
    const prepared = await prepare();
    const writePath = join(prepared.dataDir, "smoke.txt");
    const running = await boot(prepared.dataDir, prepared.port, {
      SCHEDULER_SMOKE_JOB: "1",
      SCHEDULER_SMOKE_SLOW_MS: "1200",
      SCHEDULER_SMOKE_WRITE_PATH: writePath,
    });
    child = running.child;
    const origin = `http://127.0.0.1:${prepared.port}`;
    await running.waitLog("scheduler started (6 jobs)");
    await running.waitLog("smoke job started");
    expect(await (await fetch(`${origin}/health`)).json()).toEqual({ status: "ok" });
    expect((await fetch(`${origin}/api/settings`)).status).toBe(401);
    const gate = await fetch(`${origin}/`);
    expect(gate.status).toBe(200);
    expect(await gate.text()).toContain("access-gate-form");
    const unlock = await fetch(`${origin}/gate`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "token=mpg-synthetic-access-token",
    });
    expect(unlock.status).toBe(303);
    const gateCookie = unlock.headers.get("set-cookie")?.match(/mp_gate=[^;]+/)?.[0];
    expect(gateCookie).toBeDefined();
    expect(
      (await fetch(`${origin}/server/index.js`, { headers: { cookie: gateCookie! } })).status
    ).toBe(404);
    const provision = await fetch(`${origin}/api/auth/provision`, {
      method: "POST",
      headers: { authorization: "Bearer mpk-synthetic-bootstrap-key" },
    });
    expect(provision.status).toBe(200);
    const deviceCookie = provision.headers.get("set-cookie")?.match(/mp_device_key=[^;]+/)?.[0];
    expect(deviceCookie).toBeDefined();
    const settings = await fetch(`${origin}/api/settings`, { headers: { cookie: deviceCookie! } });
    expect(settings.status).toBe(200);
    const effective = (await settings.json()) as { locale: { timezone: string } };
    expect(effective.locale.timezone).toBe("Europe/Madrid");
    for (const inactive of ["/api/reminders", "/api/backups"]) {
      expect(
        (await fetch(`${origin}${inactive}`, { headers: { cookie: deviceCookie! } })).status
      ).toBe(503);
    }
    expect(existsSync(writePath)).toBe(false);
    signal(running.child, "SIGINT");
    await running.waitLog("scheduler drained");
    expect(await running.exit).toEqual({ code: 0, signal: null });
    expect(readFileSync(writePath, "utf8")).toBe("smoke job write complete\n");
    expect(readFileSync(`${writePath}.second`, "utf8")).toBe("smoke job second write complete\n");
    expect(running.log().indexOf("smoke job fired")).toBeLessThan(
      running.log().indexOf("scheduler drained")
    );
    await hardKill(running.child);
    child = undefined;
  }, 30_000);

  it("keeps scheduler registrations but arms no smoke timer when disabled", async () => {
    const prepared = await prepare();
    const running = await boot(prepared.dataDir, prepared.port, {
      SCHEDULER_DISABLED: "1",
      SCHEDULER_SMOKE_JOB: "1",
    });
    child = running.child;
    await running.waitLog("scheduler disabled");
    await delay(300);
    expect(running.log()).not.toContain("scheduler started");
    expect(running.log()).not.toContain("smoke job fired");
    signal(running.child, "SIGINT");
    await running.waitLog("scheduler drained");
    expect(await running.exit).toEqual({ code: 0, signal: null });
    await hardKill(running.child);
    child = undefined;
  }, 30_000);
});
