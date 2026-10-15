import { test, expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unlockAdmin } from "./admin-unlock";
import { prepareActivePlugins } from "./plugin-fixture-db";

/** — dedicated SERIAL own-server restore e2e (quickstart.md §3, FR-006/FR-015). This
 * IS the Constitution-XII evidence: an automated round-trip asserting pre-restore snapshot
 * existence + a post-restore read-boundary smoke, never a manual protocol.
 * Reuses `tests/e2e/critical-flow.spec.ts`'s own-spawned-server pattern (own free port, own
 * fresh DATA_DIR, real `node dist/server/index.js` — never the shared parallel `webServer`,
 * which a mid-suite DB swap would corrupt sibling specs). Unlike critical-flow, this spec skips
 * the gate/provision UI dance entirely: `/api/*` is gate-exempt (`isGateExempt`, src/server/
 * auth/gate.ts) and `reconcileBootstrap` (src/server/auth/reconcile.ts) seeds an ACTIVE, scope
 * `'*'` api_keys row for `MP_BOOTSTRAP_KEY` on every boot — that key satisfies `backups:admin`
 * (and every other capability) directly via the `mp_device_key` cookie, exactly like a
 * provisioned device key would. Also UNLIKE critical-flow (which sets `SCHEDULER_DISABLED=1`),
 * this spec's spawned server runs with the scheduler ENABLED — `POST /api/backups/snapshot`
 * requires an initialized scheduler singleton (`startServer`'s env comment below has the
 * detail).
 * Trace tags: BACKUPS-AC-01, BACKUPS-INV-03 (process level).
 */

const BOOTSTRAP_KEY = process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key";
const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";
const ADMIN_PIN = process.env.ADMIN_PIN ?? "1234";

/** `node dist/server/index.js` — the real production entrypoint (npm start). */
const SERVER_ENTRY = resolve(process.cwd(), "dist", "server", "index.js");

const HEALTH_TIMEOUT_MS = 30_000;

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

async function startServer(port: number, dataDir: string): Promise<ChildProcess> {
  const child = spawn("node", [SERVER_ENTRY], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "localhost",
      DATA_DIR: dataDir,
      DATABASE_PATH: "marplanner.db",
      MP_BOOTSTRAP_KEY: BOOTSTRAP_KEY,
      MP_ACCESS_TOKEN: ACCESS_TOKEN,
      ADMIN_PIN,
      // The process-level scenario only uses /api paths. the visible scenario also enters the
      // real access/provisioning gates, so the synthetic access token is explicit in this server.
      // UNLIKE critical-flow.spec.ts, the scheduler is left ENABLED (no SCHEDULER_DISABLED) —
      // `POST /api/backups/snapshot` routes through `runJobNow` (routes/backups.ts), which
      // requires an initialized scheduler singleton (without one it 503s
      // scheduler_unavailable). A real scheduler also means the restore engine's own
      // stop/restart-scheduler steps run for real here, not just at the integration level. Any
      // wall-clock catch-up the OTHER jobs (daily-briefing, telemetry-prune) or a startup
      // backups catch-up perform on this fresh DATA_DIR is harmless — every assertion below
      // targets specific returned filenames/fields, never an exact backup COUNT.
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderr += String(d);
    process.stderr.write(`[server:${port}] ${d}`);
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

test("backups restore round-trip: seed -> snapshot -> mutate -> restore -> verify (Constitution-XII)", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);

  if (!BOOTSTRAP_KEY.startsWith("mpk-")) {
    throw new Error(`MP_BOOTSTRAP_KEY must be an "mpk-" key; got "${BOOTSTRAP_KEY}".`);
  }
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(
      `Built server missing at ${SERVER_ENTRY}. Run \`npm run build\` first ` +
        `(Playwright's configured webServer does this before the suite).`
    );
  }

  const dataDir = mkdtempSync(join(tmpdir(), "mp-e2e-restore-"));
  const port = await getFreePort();
  const base = `http://localhost:${port}`;

  prepareActivePlugins(dataDir, ["backups"]);
  const server = await startServer(port, dataDir);
  const pid = server.pid;
  try {
    // Authenticate every subsequent page.request call via the bootstrap key's cookie — /api/* is
    // gate-exempt (auth/gate.ts's isGateExempt) and reconcileBootstrap already seeded this key
    // as an active, scope '*' row on this exact boot.
    await context.addCookies([{ name: "mp_device_key", value: BOOTSTRAP_KEY, url: base }]);

    // 1. Seed a member.
    const createRes = await page.request.post(`${base}/api/members`, {
      data: { displayName: "Ada Lovelace", role: "parent" },
    });
    expect(createRes.status()).toBe(201);
    const member = (await createRes.json()) as { id: string };

    // 2. Snapshot via the API — this is the file we will restore back to.
    const snapRes = await page.request.post(`${base}/api/backups/snapshot`);
    expect(snapRes.status()).toBe(200);
    const snapBody = (await snapRes.json()) as { status: string; filename?: string };
    expect(snapBody.status).toBe("completed");
    const backupFilename = snapBody.filename;
    expect(typeof backupFilename).toBe("string");
    if (!backupFilename) throw new Error("unreachable");

    // 3. Mutate (rename the member) — this is the change restore must revert.
    const patchRes = await page.request.patch(`${base}/api/members/${member.id}`, {
      data: { displayName: "Ada MUTATED" },
    });
    expect(patchRes.status()).toBe(200);

    const beforeRestore = await page.request.get(`${base}/api/members`);
    const beforeMembers = (await beforeRestore.json()) as Array<{ displayName: string }>;
    expect(beforeMembers.some((m) => m.displayName === "Ada MUTATED")).toBe(true);

    const listBeforeRestore = await page.request.get(`${base}/api/backups`);
    const listBeforeBody = (await listBeforeRestore.json()) as {
      backups: Array<{ filename: string }>;
      dbGeneration: number;
    };
    const dbGenerationBefore = listBeforeBody.dbGeneration;

    // 4. Fire the restore call CONCURRENTLY with several probe requests, so at least some land
    // inside the quiesce window (per-request outcome: only a clean 200 with pre-swap data, or
    // a clean 503 — never anything else, never torn/mixed data).
    const restorePromise = page.request.post(`${base}/api/backups/restore`, {
      data: { filename: backupFilename, confirmFilename: backupFilename },
    });
    const probeCount = 15;
    const probePromises = Array.from({ length: probeCount }, () =>
      page.request.get(`${base}/api/members`)
    );

    const [restoreRes, ...probeResponses] = await Promise.all([restorePromise, ...probePromises]);

    expect(restoreRes.status()).toBe(200);
    const restoreBody = (await restoreRes.json()) as {
      status: string;
      dbGeneration?: number;
      migrated?: boolean;
    };
    expect(restoreBody.status).toBe("restored");
    expect(typeof restoreBody.dbGeneration).toBe("number");
    expect(restoreBody.dbGeneration).toBeGreaterThan(dbGenerationBefore);

    // Concurrent probes: every one is EITHER a clean 200 with well-formed, pre-swap or
    // post-swap data, OR a clean 503 (quiescing) — never any other status, never malformed JSON.
    let sawQuiesced = false;
    for (const probeRes of probeResponses) {
      const status = probeRes.status();
      expect([200, 503]).toContain(status);
      if (status === 503) {
        sawQuiesced = true;
        expect(probeRes.headers()["retry-after"]).toBeDefined();
      } else {
        const body = (await probeRes.json()) as Array<{ displayName: string }>;
        expect(Array.isArray(body)).toBe(true);
        const names = body.map((m) => m.displayName);
        // Never a torn/mixed read: exactly the pre-swap state (still "Ada MUTATED") or exactly
        // the fully-restored post-swap state (back to "Ada Lovelace") — nothing in between.
        const isPreSwap = names.includes("Ada MUTATED");
        const isPostSwap = names.includes("Ada Lovelace") && !names.includes("Ada MUTATED");
        expect(isPreSwap || isPostSwap).toBe(true);
      }
    }
    // Whether a concurrent probe lands inside the ~350ms quiesce window is a timing race on a
    // loaded CI runner (it reliably does locally). The 503 short-circuit itself is proven
    // DETERMINISTICALLY by tests/integration/backups-quiesce-hook.test.ts (buildApp + inject:
    // 503 shape on /api/*, restore-route exemption, /health untouched), so the observation
    // here is informational only — the torn-read assertion inside the loop above remains the
    // hard guarantee (every probe saw exactly pre-swap or post-swap state, never a mix).
    console.log(`quiesce probes: sawQuiesced=${sawQuiesced}`);

    // 5. Mutation reverted — the member is back to its pre-mutation, pre-snapshot-mutation name.
    const afterRestore = await page.request.get(`${base}/api/members`);
    expect(afterRestore.status()).toBe(200);
    const afterMembers = (await afterRestore.json()) as Array<{ displayName: string }>;
    expect(afterMembers.some((m) => m.displayName === "Ada Lovelace")).toBe(true);
    expect(afterMembers.some((m) => m.displayName === "Ada MUTATED")).toBe(false);

    // 6. Pre-restore file exists + list derives correctly (BACKUPS-AC-01/AC-06).
    const listAfterRestore = await page.request.get(`${base}/api/backups`);
    expect(listAfterRestore.status()).toBe(200);
    const listAfterBody = (await listAfterRestore.json()) as {
      backups: Array<{ filename: string; type: string }>;
      dbGeneration: number;
    };
    expect(listAfterBody.backups.some((b) => b.filename === backupFilename)).toBe(true);
    expect(listAfterBody.backups.some((b) => b.type === "pre-restore")).toBe(true);
    expect(listAfterBody.dbGeneration).toBe(restoreBody.dbGeneration);

    // 7. Read-boundary smoke (Constitution-XII, FR-015): GET /api/members stays green — already
    // proven above (afterRestore.status === 200), asserted again explicitly per FR-015's
    // "member reads + backup list asserted before the restore is called healthy" wording.
    const finalMembersRes = await page.request.get(`${base}/api/members`);
    expect(finalMembersRes.status()).toBe(200);

    // 8. Same pid — NO process restart (ADR-017 / BACKUPS-INV-03 at the process level).
    expect(server.pid).toBe(pid);
    expect(server.exitCode).toBeNull();
    expect(server.signalCode).toBeNull();

    // 9. a SECOND snapshot-now call after the restore proves the scheduler was
    // genuinely restarted (re-armed and functional), not merely left in a "not stopped" state
    // — routes/backups.ts's snapshot handler 503s scheduler_unavailable whenever the
    // scheduler singleton isn't usable, so a 200 "completed" here is real, positive evidence.
    const secondSnapRes = await page.request.post(`${base}/api/backups/snapshot`);
    expect(secondSnapRes.status()).toBe(200);
    const secondSnapBody = (await secondSnapRes.json()) as { status: string; filename?: string };
    expect(secondSnapBody.status).toBe("completed");
    expect(secondSnapBody.filename).not.toBe(backupFilename);
  } finally {
    await stopServer(server);
  }
});

test("backups admin visibly restores data and deletes only the confirmed snapshot", async ({
  page,
}) => {
  test.setTimeout(90_000);

  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(
      `Built server missing at ${SERVER_ENTRY}. Run \`npm run build\` first ` +
        `(Playwright's configured webServer does this before the suite).`
    );
  }

  const dataDir = mkdtempSync(join(tmpdir(), "mp-e2e-backups-admin-"));
  const port = await getFreePort();
  const base = `http://localhost:${port}`;
  prepareActivePlugins(dataDir, ["backups"]);
  let server = await startServer(port, dataDir);

  try {
    await provisionAndUnlock(page, base);

    const sentinelName = "Backup download sentinel";
    const sentinelRes = await page.request.post(`${base}/api/members`, {
      data: { displayName: sentinelName, role: "parent" },
    });
    expect(sentinelRes.status()).toBe(201);
    const sentinel = (await sentinelRes.json()) as { id: string };

    const firstSnapshot = await createSnapshot(page, base);
    const secondSnapshot = await createSnapshot(page, base);
    expect(secondSnapshot).not.toBe(firstSnapshot);

    await page.reload();
    await ensureAdminUnlocked(page);

    const snapshotRow = page.getByTestId(`backups-row-${firstSnapshot}`);
    await expect(snapshotRow).toBeVisible();
    const snapshotCells = snapshotRow.locator("td");
    await expect(snapshotCells.nth(0)).toHaveText(firstSnapshot);
    await expect(snapshotCells.nth(1)).toHaveText(/snapshot|instantánea/i);
    await expect(snapshotCells.nth(2)).not.toHaveText("");
    await expect(snapshotCells.nth(3)).toHaveText(/\d+(?:\.\d+)? (?:B|KB|MB)/);

    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId(`backups-download-${firstSnapshot}`).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(firstSnapshot);
    const downloadedPath = await download.path();
    expect(downloadedPath).not.toBeNull();
    if (!downloadedPath) throw new Error("Downloaded backup did not expose a local path");

    const downloadedDatabase = new Database(downloadedPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(downloadedDatabase.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(
        downloadedDatabase
          .prepare("SELECT display_name AS displayName FROM members WHERE id = ?")
          .get(sentinel.id)
      ).toEqual({ displayName: sentinelName });
    } finally {
      downloadedDatabase.close();
    }

    await page.getByTestId("backups-upload-input").setInputFiles(downloadedPath);
    const uploadRow = page.locator('[data-testid^="backups-row-upload-"]').first();
    await expect(uploadRow).toBeVisible();
    const uploadRowId = await uploadRow.getAttribute("data-testid");
    const uploadedFilename = uploadRowId?.replace("backups-row-", "");
    if (!uploadedFilename) throw new Error("Uploaded backup row did not expose its filename");
    const listAfterUploadRes = await page.request.get(`${base}/api/backups`);
    expect(listAfterUploadRes.status()).toBe(200);
    const listAfterUpload = (await listAfterUploadRes.json()) as {
      backups: Array<{ filename: string; type: string; sizeBytes: number }>;
    };
    const uploadedBackup = listAfterUpload.backups.find(
      (backup) => backup.filename === uploadedFilename
    );
    expect(uploadedBackup).toMatchObject({ filename: uploadedFilename, type: "upload" });
    expect(uploadedBackup?.sizeBytes).toBeGreaterThan(0);

    const eventDate = new Date().toISOString().slice(0, 10);
    const eventEndDate = addDays(eventDate, 1);
    const eventTitle = "Backup restore visible mutation";
    const eventRes = await page.request.post(`${base}/api/calendar/events`, {
      data: {
        title: eventTitle,
        allDay: true,
        startDate: eventDate,
        endDate: eventEndDate,
      },
    });
    expect(eventRes.status()).toBe(201);

    await page.goto(`${base}/calendar`);
    await expect(page.getByText(/loading calendar|cargando calendario/i)).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(page.getByText(eventTitle, { exact: true }).first()).toBeVisible();
    await page.goto(`${base}/admin/backups`);
    await ensureAdminUnlocked(page);

    let restoreRequests = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url() === `${base}/api/backups/restore`) {
        restoreRequests += 1;
      }
    });

    await page.getByTestId(`backups-restore-select-${uploadedFilename}`).click();
    await page.getByTestId("backups-restore-confirm-input").fill("wrong filename");
    await page.getByTestId("backups-restore-submit").click();
    await expect(page.getByTestId("backups-restore-confirm-input")).toHaveAttribute(
      "aria-invalid",
      "true"
    );
    expect(restoreRequests).toBe(0);
    expect(await calendarEventExists(page, base, eventDate, eventEndDate, eventTitle)).toBe(true);

    await page.getByTestId("backups-restore-confirm-input").fill(uploadedFilename);
    const restoreReload = page.waitForEvent("load");
    await page.getByTestId("backups-restore-submit").click();
    await expect.poll(() => restoreRequests).toBe(1);
    await restoreReload;
    await ensureAdminUnlocked(page);
    expect(await calendarEventExists(page, base, eventDate, eventEndDate, eventTitle)).toBe(false);
    expect(await memberDisplayName(page, base, sentinel.id)).toBe(sentinelName);

    await stopServer(server);
    server = await startServer(port, dataDir);
    await page.goto(`${base}/admin/backups`);
    await ensureAdminUnlocked(page);
    expect(await calendarEventExists(page, base, eventDate, eventEndDate, eventTitle)).toBe(false);
    expect(await memberDisplayName(page, base, sentinel.id)).toBe(sentinelName);

    await page.goto(`${base}/calendar`);
    await expect(page.getByText(/loading calendar|cargando calendario/i)).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(page.getByText(eventTitle, { exact: true })).toHaveCount(0);
    await page.goto(`${base}/admin/backups`);
    await ensureAdminUnlocked(page);

    let deleteRequests = 0;
    page.on("request", (request) => {
      if (
        request.method() === "DELETE" &&
        request.url() === `${base}/api/backups/${encodeURIComponent(secondSnapshot)}`
      ) {
        deleteRequests += 1;
      }
    });

    await page.getByTestId(`backups-delete-${secondSnapshot}`).click();
    await expect(page.getByTestId("backups-delete-confirm")).toBeVisible();
    await expect(page.getByRole("dialog").getByText(secondSnapshot, { exact: true })).toBeVisible();
    expect(deleteRequests).toBe(0);
    await page.getByTestId("backups-delete-cancel").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByTestId(`backups-row-${secondSnapshot}`)).toBeVisible();
    expect(deleteRequests).toBe(0);

    await page.getByTestId(`backups-delete-${secondSnapshot}`).click();
    const confirmedDeleteDialog = page.getByRole("dialog");
    await expect(confirmedDeleteDialog.getByText(secondSnapshot, { exact: true })).toBeVisible();
    await confirmedDeleteDialog.getByTestId("backups-delete-confirm").click();
    await expect(page.getByTestId(`backups-row-${secondSnapshot}`)).toHaveCount(0);
    await expect(page.getByTestId(`backups-row-${firstSnapshot}`)).toBeVisible();
    expect(deleteRequests).toBe(1);

    const finalListRes = await page.request.get(`${base}/api/backups`);
    expect(finalListRes.status()).toBe(200);
    const finalList = (await finalListRes.json()) as { backups: Array<{ filename: string }> };
    expect(finalList.backups.some((backup) => backup.filename === secondSnapshot)).toBe(false);
    expect(finalList.backups.some((backup) => backup.filename === firstSnapshot)).toBe(true);
    expect(finalList.backups.some((backup) => backup.filename === uploadedFilename)).toBe(true);
  } finally {
    await stopServer(server);
  }
});

async function provisionAndUnlock(page: Page, base: string): Promise<void> {
  await page.goto(`${base}/admin/backups`);
  await page.getByTestId("access-gate-form").locator('input[name="token"]').fill(ACCESS_TOKEN);
  await page.getByRole("button", { name: "Enter", exact: true }).click();
  await page.getByLabel("Bootstrap key").fill(BOOTSTRAP_KEY);
  await page.getByRole("button", { name: "Provision Device" }).click();
  await expect(page.getByTestId("home-surface")).toBeVisible({ timeout: 15_000 });
  await page.goto(`${base}/admin/backups`);
  await ensureAdminUnlocked(page);
}

async function ensureAdminUnlocked(page: Page): Promise<void> {
  const management = page.getByTestId("backups-management");
  if (await management.isVisible().catch(() => false)) return;
  await unlockAdmin(page, ADMIN_PIN);
  await expect(management).toBeVisible();
}

async function createSnapshot(page: Page, base: string): Promise<string> {
  const response = await page.request.post(`${base}/api/backups/snapshot`);
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { status: string; filename?: string };
  expect(body.status).toBe("completed");
  expect(typeof body.filename).toBe("string");
  if (!body.filename) throw new Error("Snapshot response did not include a filename");
  return body.filename;
}

async function calendarEventExists(
  page: Page,
  base: string,
  from: string,
  to: string,
  title: string
): Promise<boolean> {
  const response = await page.request.get(
    `${base}/api/calendar/events?source=all&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
  );
  expect(response.status()).toBe(200);
  const events = (await response.json()) as Array<{ title: string }>;
  return events.some((event) => event.title === title);
}

async function memberDisplayName(page: Page, base: string, memberId: string): Promise<string> {
  const response = await page.request.get(`${base}/api/members`);
  expect(response.status()).toBe(200);
  const members = (await response.json()) as Array<{ id: string; displayName: string }>;
  const member = members.find((candidate) => candidate.id === memberId);
  if (!member) throw new Error(`Restored database did not contain member ${memberId}`);
  return member.displayName;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
