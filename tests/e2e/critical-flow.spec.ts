import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { unlockAdmin } from "./admin-unlock";

/** Critical-flow E2E test (ADR-059 re-scope; realizes FR-029/030/031/032, SC-003).
 * Flow: fresh boot (locked → access-gate FORM, never the shell, FR-029) → gate
 * passed (dedicated httpOnly gate cookie, FR-030) → provisioning from browser
 * defaults with no authed settings call (FR-031) → cold settings readable with
 * the device key alone → admin unlock (long-press reveal + PIN) → member create
 * → a REAL server-process restart against the same DATA_DIR → device key
 * survives (no re-provision on reload) → the created member re-read via the
 * key-authorized GET /api/members (FR-032) AND store-level durability of the
 * SQLite file under DATA_DIR (SC-003).
 * WHY THIS SPEC OWNS ITS SERVER LIFECYCLE: SC-003 requires a genuine server
 * process* restart against the same on-disk SQLite file. Playwright's managed
 * `webServer` (playwright.config.ts) cannot restart mid-test, so this spec
 * spawns/kills/respawns its own `node dist/server/index.js` child on its own
 * free port + a fresh temp DATA_DIR. The baseline `webServer` still runs its
 * `npm run build` step before tests, which produces the `dist/` this spec
 * reuses (see the config comment). The run itself is delegated to a non-sandbox
 * lane (CI `check:full` or a local machine) — a sandbox that blocks port-bind
 * cannot execute it.
 * HOST NOTE: the server and the browser both use `localhost` (not a bare IP) so
 * the `Secure` device/gate cookies are accepted over plain HTTP — loopback is a
 * "potentially trustworthy" secure context, and `localhost` is universally
 * whitelisted for that exemption across the browser AND Playwright's separate
 * APIRequestContext HTTP client.
 */

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";
const BOOTSTRAP_KEY = process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key";
const ADMIN_PIN = process.env.ADMIN_PIN ?? "1234";

/** `node dist/server/index.js` — the real production entrypoint (npm start). */
const SERVER_ENTRY = resolve(process.cwd(), "dist", "server", "index.js");

const MEMBER_NAME = "Ada Lovelace";
const HEALTH_TIMEOUT_MS = 30_000;

/** Reserve an ephemeral free port so parallel/CI runs avoid collisions with port 3000. */
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

/** Spawn the real server against a given port + DATA_DIR; resolve once it answers
 * GET /health. Detects an early child exit (e.g. EADDRINUSE on a respawn) and
 * fails fast with the port + captured stderr instead of a mystery health timeout.
 * stdout is discarded (`ignore`) so a chatty child can never fill an OS pipe
 * buffer and stall its own event loop; stderr is piped for diagnostics.
 */
async function startServer(port: number, dataDir: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
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
    process.stderr.write(`[server:${port}] ${d}`);
  });
  // Mutable holder (an object, so TS keeps its declared type across the aliased
  // callback rather than narrowing to `never`).
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
    // Any startup failure (early exit, health timeout) must not leak the child:
    // the caller has not captured this handle yet, so its `finally` cannot reap it.
    child.off("exit", onExit);
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((done) => child.once("exit", () => done()));
      child.kill("SIGKILL");
      await exited;
    }
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

test.describe.configure({ mode: "serial" });

test("critical flow: gate → provision → cold settings → admin → member → restart → re-read (SC-003)", async ({
  page,
}) => {
  test.setTimeout(120_000); // two real server boots on top of the built dist

  // Fail fast on a mis-set runner environment. ADR-037 makes a non-`mpg-` access
  // token (and a non-`mpk-` bootstrap key) fail closed, which would otherwise
  // surface only as a confusing "Provision Device never appeared" timeout.
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

  const dataDir = mkdtempSync(join(tmpdir(), "mp-e2e-"));
  try {
    const port = await getFreePort();
    const base = `http://localhost:${port}`;

    let server = await startServer(port, dataDir);
    try {
      // 1. Fresh boot → access-gate FORM (FR-029): 200 HTML, never the shell, never 401.
      const gateResp = await page.goto(`${base}/`);
      expect(gateResp?.status()).toBe(200);
      await expect(page.getByTestId("access-gate-form")).toBeVisible();
      // The provisioning shell must NOT be reachable before the gate is passed.
      await expect(page.getByRole("button", { name: "Provision Device" })).toHaveCount(0);

      // 2. Pass the gate (FR-030): submitting the correct token sets the gate cookie,
      // after which the SPA shell is served.
      await page.getByTestId("access-gate-form").locator('input[name="token"]').fill(ACCESS_TOKEN);
      await page.getByRole("button", { name: "Enter" }).click();

      // 3. Provisioning screen renders from browser defaults (FR-031): no authed
      // settings call gates this — it appears purely from the absent device marker.
      await expect(page.getByRole("button", { name: "Provision Device" })).toBeVisible();
      await page.getByLabel("Bootstrap key").fill(BOOTSTRAP_KEY);
      await page.getByRole("button", { name: "Provision Device" }).click();

      // Provision success → the family dashboard is on the provisioned shell.
      await expect(page.getByTestId("home-surface")).toBeVisible();

      // 4. Cold settings readable with the device key alone (FR-008..011), via the
      // product seam — the browser context carries the httpOnly mp_device_key cookie.
      const cold = await page.request.get(`${base}/api/settings`);
      expect(cold.status()).toBe(200);
      expect(JSON.stringify(await cold.json())).toContain("Europe/Madrid"); // seeded locale default

      // 5. Admin unlock (FR-017/018): hold the Options-menu Admin button for three seconds,
      // then enter the PIN through the touch keypad and verify it server-side.
      await unlockAdmin(page, ADMIN_PIN);

      // 6. Member create (FR-019/022/023): display name + role=parent → 201.
      // Language-agnostic selectors: the admin Members UI localizes to the household
      // locale (default 'en', ADR-015), so target stable ids/roles + a testid, NOT
      // English label text (which flips to Spanish once /api/settings resolves).
      const createSubmit = page.locator('form button[type="submit"]');
      await expect(createSubmit).toBeVisible();
      await page.locator("#member-display-name").fill(MEMBER_NAME);
      await page.locator("#member-role").click(); // Radix Select trigger
      await page.getByRole("option").first().click(); // first option = parent
      await createSubmit.click();
      await expect(page.getByTestId("member-create-success")).toBeVisible();

      // Pre-restart sanity: the member is readable through GET /api/members.
      const before = await page.request.get(`${base}/api/members`);
      expect(before.status()).toBe(200);
      expect(await before.json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            displayName: MEMBER_NAME,
            role: "parent",
            lifecycle: "active",
          }),
        ])
      );

      // 7. REAL server-process restart against the SAME DATA_DIR + SAME PORT (SC-003).
      // Reuse the same port so the loaded page keeps its URL across the restart.
      // Cookies are scoped by host and path, not port.
      await stopServer(server);
      server = await startServer(port, dataDir);

      // 8. Device key survives — reload does NOT drop back to provisioning (FR-031/SC-003).
      await page.reload();
      await expect(page.getByTestId("admin-pin-keypad")).toBeVisible();
      await expect(page.getByRole("button", { name: "Provision Device" })).toHaveCount(0);

      // 9. Member re-read via the key-authorized GET /api/members after restart (FR-032).
      const after = await page.request.get(`${base}/api/members`);
      expect(after.status()).toBe(200);
      const members = (await after.json()) as Array<Record<string, unknown>>;
      expect(members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            displayName: MEMBER_NAME,
            role: "parent",
            lifecycle: "active",
          }),
        ])
      );
    } finally {
      await stopServer(server);
    }

    // 10. Store-level durability (SC-003): the member row AND the active device key
    // survive in the on-disk SQLite file under DATA_DIR — zero committed rows lost.
    const db = new Database(join(dataDir, "marplanner.db"), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const memberRows = db
        .prepare("SELECT display_name, role, lifecycle FROM members")
        .all() as Array<{ display_name: string; role: string; lifecycle: string }>;
      expect(memberRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            display_name: MEMBER_NAME,
            role: "parent",
            lifecycle: "active",
          }),
        ])
      );
      const activeKeys = db
        .prepare("SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL")
        .get() as { n: number };
      expect(activeKeys.n).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
