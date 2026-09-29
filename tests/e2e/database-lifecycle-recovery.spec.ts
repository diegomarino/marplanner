import { execFile } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test, type ChildProcess, type Page } from "@playwright/test";
import { unlockAdmin } from "./admin-unlock";
import { prepareActivePlugins } from "./plugin-fixture-db";

const execFileAsync = promisify(execFile);
const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";
const BOOTSTRAP_KEY = process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key";
const ADMIN_PIN = process.env.ADMIN_PIN ?? "1234";
const AS_OF_DATE = "2026-09-23";
const SERVER_ENTRY = resolve(process.cwd(), "dist", "server", "index.js");
const BASELINE_FILE = "0000_current_baseline.sql";
const CALENDAR_FEED_SYNC_MIGRATION_FILE = "0001_calendar_feed_sync.sql";
const PLUGIN_LIFECYCLE_FILE = "0002_plugin_lifecycle.sql";
const HEALTH_TIMEOUT_MS = 30_000;

type Backup = { filename: string; type: "scheduled" | "snapshot" | "pre-restore" | "upload" };

test.describe.configure({ mode: "serial" });

test("database recovery journey uses the existing Backups UI without a product repair", async ({
  page,
}) => {
  test.setTimeout(120_000);
  expect(existsSync(SERVER_ENTRY)).toBe(true);

  const dataDirectory = mkdtempSync(join(tmpdir(), "mp-e2e-recovery-journey-"));
  const port = await getFreePort();
  const base = `http://localhost:${port}`;
  let migrationRuntimeDirectory: string | undefined;
  let server: ChildProcess | undefined;
  try {
    const seed = await execFileAsync("npm", ["run", "seed", "--", "--as-of", AS_OF_DATE], {
      cwd: process.cwd(),
      env: { ...process.env, DATA_DIR: dataDirectory, DATABASE_PATH: "marplanner.db" },
    });
    expect(seed.stdout).toContain("mode=public");
    expect(seed.stdout).toContain(`as-of=${AS_OF_DATE}`);
    expect(seed.stdout).toContain(
      "modules=[public:settings,members:demo,calendar:demo,routines:demo,reminders:demo,meals:demo,daily:content:demo,time:announcements:demo]"
    );
    expect(seed.stdout).toContain("status=complete");

    prepareActivePlugins(dataDirectory, ["backups"]);
    server = await startServer(port, dataDirectory);
    await provisionAndUnlock(page, base);

    // The public read smoke is intentionally before the snapshot, never inferred afterward.
    const preSnapshotMembers = await readMembers(page, base);
    expect(preSnapshotMembers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "demo:member:homer", displayName: "Homer" }),
      ])
    );
    const preSnapshotCalendar = await page.request.get(
      `${base}/api/calendar/events?source=all&from=2026-09-23&to=2026-09-26`
    );
    expect(preSnapshotCalendar.status()).toBe(200);
    expect(await preSnapshotCalendar.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "demo:calendar:event:lisa-homework-club", source: "local" }),
      ])
    );

    await page.getByTestId("admin-nav-backups").click();
    await expect(page.getByTestId("backups-management")).toBeVisible();
    await expect(page.getByTestId("backups-snapshot-now")).toBeVisible();
    await expect(page.getByTestId("backups-upload-input")).toBeVisible();
    await expect(page.getByTestId("backups-upload-submit")).toBeDisabled();

    // List + snapshot: the only snapshot used for restoration is made through the UI.
    await page.getByTestId("backups-snapshot-now").click();
    const snapshot = await waitForBackup(page, base, "snapshot");
    await expect(page.getByTestId(`backups-row-${snapshot.filename}`)).toBeVisible();

    // Download, upload, and delete are audited as real existing UI capabilities before restore.
    const download = page.waitForEvent("download");
    await page.getByTestId(`backups-download-${snapshot.filename}`).click();
    expect((await download).suggestedFilename()).toBe(snapshot.filename);

    await page.getByTestId("backups-upload-input").setInputFiles({
      name: "recovery-journey-upload.db",
      mimeType: "application/x-sqlite3",
      buffer: readFileSync(join(dataDirectory, "marplanner.db")),
    });
    await page.getByTestId("backups-upload-submit").click();
    const uploaded = await waitForBackup(page, base, "upload");
    await expect(page.getByTestId(`backups-delete-${uploaded.filename}`)).toBeVisible();
    await page.getByTestId(`backups-delete-${uploaded.filename}`).click();
    await page.getByTestId("backups-delete-confirm").click();
    await expect(page.getByTestId(`backups-row-${uploaded.filename}`)).toHaveCount(0);

    // The mutation is visible through the ordinary Members UI, rather than a database fixture.
    await mutateHomerThroughMembersUi(page);
    expect(await memberNamed(page, base, "demo:member:homer")).toMatchObject({
      displayName: "Homer MUTATED",
    });

    // The current-schema snapshot is now restored by a running app whose migration directory has
    // the current migrations plus one later migration. The temporary migration itself creates a
    // record observable through the existing public Members read.
    await stopServer(server);
    migrationRuntimeDirectory = makeTemporaryMigrationRuntime();
    server = await startServer(port, dataDirectory, migrationRuntimeDirectory);
    await page.goto(`${base}/admin/backups`);
    await expect(page.getByTestId("admin-pin-keypad")).toBeVisible();
    await unlockAdmin(page, ADMIN_PIN);
    expect(await memberNamed(page, base, "migration:recovery:probe")).toMatchObject({
      displayName: "Migrated recovery probe",
    });

    await page.getByTestId("admin-nav-backups").click();
    await page.getByTestId(`backups-restore-select-${snapshot.filename}`).click();
    await page.getByTestId("backups-restore-confirm-input").fill(snapshot.filename);
    let restoreResult: { status: string; migrated?: boolean } | undefined;
    await page.route(`${base}/api/backups/restore`, async (route) => {
      const response = await route.fetch();
      restoreResult = (await response.json()) as { status: string; migrated?: boolean };
      await route.fulfill({ response });
    });
    await page.getByTestId("backups-restore-submit").click();
    await expect.poll(() => restoreResult).toMatchObject({ status: "restored", migrated: true });

    // Successful restore reloads the UI, reapplies the temporary migration, and restores reads.
    await expect(page.getByTestId("admin-pin-keypad")).toBeVisible({ timeout: 15_000 });
    expect(await memberNamed(page, base, "demo:member:homer")).toMatchObject({
      displayName: "Homer",
    });
    expect(await memberNamed(page, base, "migration:recovery:probe")).toMatchObject({
      displayName: "Migrated recovery probe",
    });
    await expect(page.getByTestId("admin-pin-keypad")).toBeVisible();
  } finally {
    if (server) await stopServer(server);
    if (migrationRuntimeDirectory) {
      rmSync(migrationRuntimeDirectory, { recursive: true, force: true });
    }
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

async function provisionAndUnlock(page: Page, base: string): Promise<void> {
  await page.goto(`${base}/admin/backups`);
  await page.getByTestId("access-gate-form").locator('input[name="token"]').fill(ACCESS_TOKEN);
  await page.getByRole("button", { name: "Enter", exact: true }).click();
  await page.getByLabel("Bootstrap key").fill(BOOTSTRAP_KEY);
  await page.getByRole("button", { name: "Provision Device" }).click();
  await expect(page.getByTestId("home-surface")).toBeVisible();
  await page.goto(`${base}/admin/backups`);
  await expect(page.getByTestId("admin-pin-keypad")).toBeVisible();
  await unlockAdmin(page, ADMIN_PIN);
}

async function mutateHomerThroughMembersUi(page: Page): Promise<void> {
  await page.getByTestId("admin-nav-members-management").click();
  const homer = page.locator("li").filter({ hasText: "Homer" });
  await expect(homer).toBeVisible();
  await homer.getByRole("button", { name: /edit|editar/i }).click();
  await page.getByRole("textbox").fill("Homer MUTATED");
  await page.getByRole("button", { name: /save|guardar/i }).click();
  await expect(page.getByText("Homer MUTATED", { exact: true })).toBeVisible();
}

async function readMembers(page: Page, base: string): Promise<Array<Record<string, unknown>>> {
  const response = await page.request.get(`${base}/api/members`);
  expect(response.status()).toBe(200);
  return response.json() as Promise<Array<Record<string, unknown>>>;
}

async function memberNamed(
  page: Page,
  base: string,
  id: string
): Promise<Record<string, unknown> | undefined> {
  return (await readMembers(page, base)).find((member) => member.id === id);
}

async function waitForBackup(page: Page, base: string, type: Backup["type"]): Promise<Backup> {
  await expect
    .poll(async () => {
      const response = await page.request.get(`${base}/api/backups`);
      expect(response.status()).toBe(200);
      const body = (await response.json()) as { backups: Backup[] };
      return body.backups.find((backup) => backup.type === type);
    })
    .not.toBeUndefined();
  const response = await page.request.get(`${base}/api/backups`);
  const body = (await response.json()) as { backups: Backup[] };
  const backup = body.backups.find((candidate) => candidate.type === type);
  if (!backup) throw new Error(`Missing ${type} backup after successful UI operation`);
  return backup;
}

function makeTemporaryMigrationRuntime(): string {
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "mp-e2e-later-migration-"));
  const migrationsDirectory = join(runtimeDirectory, "drizzle");
  mkdirSync(migrationsDirectory);
  symlinkSync(resolve(process.cwd(), "dist"), join(runtimeDirectory, "dist"), "dir");
  const baseline = resolve(process.cwd(), "drizzle", BASELINE_FILE);
  copyFileSync(baseline, join(migrationsDirectory, BASELINE_FILE));
  const pluginLifecycle = resolve(process.cwd(), "drizzle", PLUGIN_LIFECYCLE_FILE);
  copyFileSync(pluginLifecycle, join(migrationsDirectory, PLUGIN_LIFECYCLE_FILE));
  const calendarFeedSyncMigration = resolve(
    process.cwd(),
    "drizzle",
    CALENDAR_FEED_SYNC_MIGRATION_FILE
  );
  copyFileSync(
    calendarFeedSyncMigration,
    join(migrationsDirectory, CALENDAR_FEED_SYNC_MIGRATION_FILE)
  );
  writeFileSync(
    join(migrationsDirectory, "0003_recovery_ui_probe.sql"),
    "INSERT INTO members (id, display_name, color_key, role, lifecycle, created_at, updated_at) VALUES ('migration:recovery:probe', 'Migrated recovery probe', 'blue', 'parent', 'active', 0, 0);"
  );
  return runtimeDirectory;
}

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "localhost", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        listener.close(() => reject(new Error("Could not reserve a port")));
        return;
      }
      listener.close(() => resolvePort(address.port));
    });
  });
}

async function startServer(
  port: number,
  dataDirectory: string,
  runtimeDirectory: string = process.cwd()
): Promise<ChildProcess> {
  const child = (await import("node:child_process")).spawn("node", [SERVER_ENTRY], {
    cwd: runtimeDirectory,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "localhost",
      DATA_DIR: dataDirectory,
      DATABASE_PATH: "marplanner.db",
      MP_ACCESS_TOKEN: ACCESS_TOKEN,
      MP_BOOTSTRAP_KEY: BOOTSTRAP_KEY,
      ADMIN_PIN,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += String(chunk);
  });
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Recovery-journey server exited before health check: ${stderr}`);
    }
    try {
      if ((await fetch(`http://localhost:${port}/health`)).ok) return child;
    } catch {
      // Server startup is still in progress.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  child.kill("SIGKILL");
  throw new Error(`Recovery-journey server did not become healthy: ${stderr}`);
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}
