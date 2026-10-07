import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { getDb, resetDb } from "../../src/server/db/client";
import { runMigrations } from "../../src/server/db/migrate";

/** Exercise the spawned server from provisioning and printer capability registration through
 * test-print, claim, real ESC/POS payload retrieval and acknowledgement. Activate the printing
 * plugin explicitly. This test proves durable state across HTTP; boundary suites cover exact
 * artifact bytes, lifecycle denial, event payloads and the complete deduplication matrix.
 */

const TSX_BIN = resolve(process.cwd(), "node_modules", ".bin", "tsx");
const SERVER_ENTRY = resolve(process.cwd(), "src", "server", "index.ts");
const HEALTH_TIMEOUT_MS = 20_000;
const BOOTSTRAP_KEY = "mpk-e2e-printing-skeleton-key";

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

function signalGroup(child: ChildProcess, signal: "SIGKILL"): void {
  if (typeof child.pid !== "number") return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone — nothing to signal
    }
  }
}

async function hardKill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((res) => child.once("exit", () => res()));
  signalGroup(child, "SIGKILL");
  await Promise.race([exited, new Promise<void>((res) => setTimeout(res, 5_000))]);
}

function activatePrintingFixture(dataDir: string): void {
  const previousDataDir = process.env.DATA_DIR;
  const previousDatabasePath = process.env.DATABASE_PATH;
  try {
    process.env.DATA_DIR = dataDir;
    process.env.DATABASE_PATH = "marplanner.db";
    resetDb();
    runMigrations();
    getDb()
      .prepare(
        "UPDATE plugin_activation_registry SET state = 'active' WHERE plugin_id = 'printing'"
      )
      .run();
  } finally {
    resetDb();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
  }
}

/** Spawn the real entrypoint via `tsx` (no build required) against a free port + a fresh temp
 * DATA_DIR, resolving once GET /health answers. `detached: true` so the spawned `tsx` wrapper
 * leads its own process group (entrypoint.test.ts's PROCESS-GROUP NOTE — SIGKILL must reach the
 * grandchild too). `SCHEDULER_DISABLED=1` keeps this test focused: no scheduler timers/catch-up
 * noise, matching the default e2e posture.
 */
async function startEntrypoint(port: number, dataDir: string): Promise<ChildProcess> {
  const child = spawn(TSX_BIN, [SERVER_ENTRY], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "localhost",
      DATA_DIR: dataDir,
      DATABASE_PATH: "marplanner.db",
      SCHEDULER_DISABLED: "1",
      MP_BOOTSTRAP_KEY: BOOTSTRAP_KEY,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  let buffer = "";
  child.stdout?.on("data", (d: Buffer) => {
    buffer += String(d);
  });
  child.stderr?.on("data", (d: Buffer) => {
    buffer += String(d);
  });

  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(`entrypoint exited before becoming healthy. output:\n${buffer}`);
    }
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return child;
    } catch {
      // not accepting connections yet — keep polling
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  signalGroup(child, "SIGKILL");
  throw new Error(
    `entrypoint on :${port} never became healthy within ${HEALTH_TIMEOUT_MS}ms. output:\n${buffer}`
  );
}

describe("printing skeleton — (Constitution XIII runnable skeleton)", () => {
  let activeChild: ChildProcess | null = null;
  let activeDataDir: string | null = null;

  afterEach(async () => {
    if (activeChild) {
      await hardKill(activeChild);
      activeChild = null;
    }
    if (activeDataDir) {
      try {
        rmSync(activeDataDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
      activeDataDir = null;
    }
  });

  it("full tracer path: test-print -> claim -> payload -> ack -> printed, plus 204/dedup edges", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mp-printing-skeleton-"));
    activeDataDir = dataDir;
    const port = await getFreePort();

    activatePrintingFixture(dataDir);
    activeChild = await startEntrypoint(port, dataDir);
    const base = `http://localhost:${port}`;
    const cookie = `mp_device_key=${BOOTSTRAP_KEY}`;

    // Register this session's printer capability (FR-021) — every claim below requires it.
    const capabilityRes = await fetch(`${base}/api/printing/capability`, {
      method: "POST",
      headers: { cookie },
    });
    expect(capabilityRes.status).toBe(200);

    // 0. Before any trigger, nothing is claimable — 204.
    const emptyClaim = await fetch(`${base}/api/printing/claim`, {
      method: "POST",
      headers: { cookie },
    });
    expect(emptyClaim.status).toBe(204);

    // 1. POST test-print -> a durable job row (FR-018).
    const triggerRes = await fetch(`${base}/api/printing/test-print`, {
      method: "POST",
      headers: { cookie },
    });
    expect(triggerRes.status).toBe(200);
    const triggerBody = (await triggerRes.json()) as {
      enqueued: boolean;
      jobId: string | null;
      alreadyPrinted?: boolean;
    };
    expect(triggerBody.enqueued).toBe(true);
    expect(triggerBody.alreadyPrinted).toBe(false);
    expect(typeof triggerBody.jobId).toBe("string");
    const jobId = triggerBody.jobId as string;

    // The admin list surfaces the freshly enqueued job, state pending, derivedState pending.
    const jobsBeforeClaim = await fetch(`${base}/api/printing/jobs`, { headers: { cookie } });
    expect(jobsBeforeClaim.status).toBe(200);
    const jobsBeforeClaimBody = (await jobsBeforeClaim.json()) as {
      jobs: Array<{ id: string; state: string; derivedState: string }>;
    };
    const beforeJob = jobsBeforeClaimBody.jobs.find((j) => j.id === jobId);
    expect(beforeJob?.state).toBe("pending");
    expect(beforeJob?.derivedState).toBe("pending");

    // 2. POST claim -> the atomic claim, returns the job + a fresh lease.
    const claimRes = await fetch(`${base}/api/printing/claim`, {
      method: "POST",
      headers: { cookie },
    });
    expect(claimRes.status).toBe(200);
    const claimBody = (await claimRes.json()) as {
      job: { id: string; state: string };
      leaseToken: string;
      leaseExpiresAt: number;
    };
    expect(claimBody.job.id).toBe(jobId);
    expect(claimBody.job.state).toBe("claimed");
    expect(typeof claimBody.leaseToken).toBe("string");
    const leaseToken = claimBody.leaseToken;

    // A second claim attempt finds nothing claimable — exactly one winner (FR-011).
    const secondClaim = await fetch(`${base}/api/printing/claim`, {
      method: "POST",
      headers: { cookie },
    });
    expect(secondClaim.status).toBe(204);

    // 3. GET payload -> the real ADR-066 ESC/POS-wrapped procedural test raster.
    const payloadRes = await fetch(
      `${base}/api/printing/jobs/${jobId}/payload?leaseToken=${encodeURIComponent(leaseToken)}`,
      { headers: { cookie } }
    );
    expect(payloadRes.status).toBe(200);
    expect(payloadRes.headers.get("content-type")).toBe("application/octet-stream");
    const payloadBytes = new Uint8Array(await payloadRes.arrayBuffer());
    expect(payloadBytes.length).toBeGreaterThan(0);

    // A stale lease token is rejected (INV-05 fencing) — 409, never served.
    const stalePayload = await fetch(
      `${base}/api/printing/jobs/${jobId}/payload?leaseToken=not-the-real-token`,
      { headers: { cookie } }
    );
    expect(stalePayload.status).toBe(409);

    // 4. POST ack -> printedAt stamped, printing.completed emitted (state proof — unit-tests
    // the event's own payload shape).
    const ackRes = await fetch(`${base}/api/printing/jobs/${jobId}/ack`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ leaseToken }),
    });
    expect(ackRes.status).toBe(200);
    const ackBody = (await ackRes.json()) as { state: string; printedAt: number | null };
    expect(ackBody.state).toBe("printed");
    expect(typeof ackBody.printedAt).toBe("number");

    // Idempotent re-ack under the SAME lease — still 200, no error (INV-05).
    const reAckRes = await fetch(`${base}/api/printing/jobs/${jobId}/ack`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ leaseToken }),
    });
    expect(reAckRes.status).toBe(200);

    // The admin list now shows the job as printed (SC-003 visibility).
    const jobsAfterAck = await fetch(`${base}/api/printing/jobs`, { headers: { cookie } });
    const jobsAfterAckBody = (await jobsAfterAck.json()) as {
      jobs: Array<{ id: string; state: string; derivedState: string; printedAt: number | null }>;
    };
    const afterJob = jobsAfterAckBody.jobs.find((j) => j.id === jobId);
    expect(afterJob?.state).toBe("printed");
    expect(afterJob?.derivedState).toBe("printed");
    expect(typeof afterJob?.printedAt).toBe("number");

    // 5. Re-triggering the SAME day's test print dedups (FR-012/AC-05) — no new job.
    const secondTriggerRes = await fetch(`${base}/api/printing/test-print`, {
      method: "POST",
      headers: { cookie },
    });
    expect(secondTriggerRes.status).toBe(200);
    const secondTriggerBody = (await secondTriggerRes.json()) as {
      enqueued: boolean;
      alreadyPrinted?: boolean;
    };
    expect(secondTriggerBody.enqueued).toBe(false);
    expect(secondTriggerBody.alreadyPrinted).toBe(true);

    // Unauthenticated request fails closed (401) — the standard device-key cookie boundary.
    const unauthRes = await fetch(`${base}/api/printing/jobs`);
    expect(unauthRes.status).toBe(401);
  }, 30_000);
});
