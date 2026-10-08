import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SERVER_ENTRY = resolve(process.cwd(), "dist", "server", "index.js");
const HEALTH_TIMEOUT_MS = 30_000;

async function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "localhost", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not reserve a free port")));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill("SIGTERM");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      exited,
      new Promise<void>((resolveWait) => {
        timeout = setTimeout(resolveWait, 5_000);
      }),
    ]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function startFreshPluginLifecycleServer(): Promise<{
  dataDir: string;
  origin: string;
  stop: () => Promise<void>;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "mp-plugin-lifecycle-e2e-"));
  const port = await getFreePort();
  const origin = `http://localhost:${port}`;
  const child = spawn("node", [SERVER_ENTRY], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "localhost",
      DATA_DIR: dataDir,
      DATABASE_PATH: "marplanner.db",
      MP_BOOTSTRAP_KEY: process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key",
      MP_ACCESS_TOKEN: process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token",
      ADMIN_PIN: process.env.ADMIN_PIN ?? "1234",
      SCHEDULER_DISABLED: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += String(chunk);
  });

  try {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Plugin lifecycle server exited before health. stderr:\n${stderr}`);
      }
      try {
        const response = await fetch(`${origin}/health`);
        if (response.ok) {
          return {
            dataDir,
            origin,
            stop: async () => {
              await stopProcess(child);
              rmSync(dataDir, { recursive: true, force: true });
            },
          };
        }
      } catch {
        // Server is still starting.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new Error(`Plugin lifecycle server did not become healthy. stderr:\n${stderr}`);
  } catch (error) {
    await stopProcess(child);
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
}
