import path from "node:path";
import { openAdminSection } from "./admin-nav";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { type Page, type APIRequestContext } from "@playwright/test";
import { test as base, expect } from "./printer-session";
import { messages, resolveLang } from "../../src/client/i18n/messages";
import { unlockAdmin } from "./admin-unlock";
import { hashKey } from "../../src/server/auth/credentials";

/** docs/features/printing.md — end-to-end through the REAL built app (real
 * server + real browser), using the fake-transport seam exposed at `window.__mpPrintTransport`
 * (src/client/printing/transport.ts's `createPrintTransport`: a DEV/`VITE_E2E_HOOKS` build with
 * no explicit test override returns the shared fake instance and publishes it on `window` — see
 * that module's own doc comment, verified by reading it before writing this file). Proves,
 * against the REAL pipeline, FR-008/FR-009/FR-012.
 * ONE continuous job/timeline, not three independent ones — a deliberate consequence of two real
 * domain constraints discovered while reading the module (`src/server/modules/printing/index.ts`):
 * (1) the admin trigger's record key is the fixed constant `"test-print"`
 * (`TEST_PRINT_RECORD_KEY`) — there is no admin-facing way to enqueue a SECOND distinct
 * "test-print" job for the SAME household-today date; a second trigger for the same date is
 * exactly FR-012's `alreadyPrinted` dedup.
 * (2) `claimJob` is day-scoped to `target_date = householdToday` — a job enqueued for any OTHER
 * date is structurally unclaimable by the real executor, so a degradation scenario cannot be
 * exercised on a "different day" job either.
 * The only way to prove enqueue→claim→transmit→ack, degrade→retry→recover, AND re-trigger→
 * alreadyPrinted in one spec is therefore to script the ONE-SHOT transport failure BEFORE the
 * job's first claim: the executor's first attempt fails (recoverable — `retrying` becomes
 * observable), its next poll tick (no re-scripting, no re-trigger) succeeds and acks (`printed`),
 * and only THEN does a second click of the same trigger button prove `alreadyPrinted`. This still
 * exercises every one of FR-008/FR-009/FR-012 exactly as written, against the real state machine.
 * Poll cadence: `playwright.config.ts`'s shared `webServer` sets `VITE_E2E_PRINT_POLL_MS=500`
 * (`PrintExecutor.tsx`'s `resolveDefaultPollIntervalMs`) — inert for any spec's page that
 * never pairs a printer.
 * CONCURRENCY CONSTRAINT: `tests/e2e/daily-briefing.spec.ts`'s test
 * ALSO pairs a real printer executor against this same shared `webServer` — this is no longer
 * the only spec that does. `claimJob` (src/server/modules/printing/index.ts) claims the OLDEST
 * `pending` job for household-today ACROSS ALL record keys, with no session/producer scoping, so
 * two paired executors racing the SAME server can steal each other's jobs (reproduced: this
 * spec's `recordedChunks` assertion at the bottom fails with an empty array when both specs
 * run concurrently, because the OTHER spec's executor claimed and transmitted this spec's job).
 * Two paired executors must therefore NEVER run concurrently against this server — enforced, not
 * just documented, by importing `test`/`expect` from `./printer-session` (a filesystem mutex
 * fixture) instead of `@playwright/test` directly; see that module's own doc comment.
 * State hygiene: cleanup runs inside the printer-session mutex and removes only this spec's
 * test-print records and its freshly provisioned device's capability. CI uses one worker and
 * zero retries; concurrent stress receipts show interaction, without identifying one cause.
 */

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";
const BOOTSTRAP_KEY = process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key";
const ADMIN_PIN = process.env.ADMIN_PIN ?? "1234";

/** DB PATH: derived exactly the way the server itself resolves it (`src/server/db/client.ts`'s * `resolveDbPath`: `path.resolve(DATA_DIR, DATABASE_PATH ?? "marplanner.db")`), from the SAME
 * env vars `playwright.config.ts` publishes for the shared `webServer` and test process
 * (`E2E_DATA_DIR`; no `DATABASE_PATH` override, so the default filename applies). Both the
 * webServer child process and this test process run with `cwd` = the repo root (Playwright's
 * default `rootDir` = the config file's directory), so the relative path resolves identically in
 * both — verified by reading `resolveDbPath` rather than guessing the filename.
 */
function resolveE2eDbPath(): string {
  const dataDir = process.env.E2E_DATA_DIR ?? ".e2e-data";
  const dbFile = process.env.DATABASE_PATH ?? "marplanner.db";
  return path.resolve(process.cwd(), dataDir, dbFile);
}

/** Remove only the test-print records owned by this spec and, at teardown, its device capability. */
function cleanTestPrintState(deviceKey?: string): void {
  const dbPath = resolveE2eDbPath();
  if (!existsSync(dbPath)) return;
  const db = new Database(dbPath);
  try {
    db.prepare(
      "DELETE FROM print_jobs WHERE record_id IN (SELECT id FROM print_records WHERE record_key = ?)"
    ).run("test-print");
    db.prepare("DELETE FROM print_records WHERE record_key = ?").run("test-print");
    if (deviceKey) {
      db.prepare(
        "DELETE FROM printer_capabilities WHERE key_id IN (SELECT id FROM api_keys WHERE key_hash = ?)"
      ).run(hashKey(deviceKey));
    }
  } finally {
    db.close();
  }
}

const test = base.extend<{ printState: void }>({
  printState: [
    async ({ page, printerSession }, use) => {
      cleanTestPrintState();
      try {
        await use();
      } finally {
        let deviceKey: string | undefined;
        try {
          deviceKey = (await page.context().cookies()).find(
            (cookie) => cookie.name === "mp_device_key"
          )?.value;
          // Stop this page's executor before removing its rows, while the session lock is held.
          if (!page.isClosed()) await page.goto("about:blank");
        } finally {
          cleanTestPrintState(deviceKey);
        }
      }
    },
    { auto: true },
  ],
});

//: declared here, at the top level, rather than as an in-body
// `test.setTimeout(...)` call — `test.describe.configure({ timeout })` is resolved at
// test-collection time, BEFORE the `printerSession` fixture (./printer-session) ever runs, so
// this budget is already in effect for the WHOLE test including a slow fixture setup (e.g. a
// lock wait). An in-body call would be too late for exactly that case — see printer-session.ts's
// own "TIMEOUT ORDERING" doc comment for the full reasoning.

test.describe.configure({ timeout: 90_000 });

interface PrintJobDto {
  id: string;
  recordKey: string;
  targetDate: string;
  state: string;
  derivedState: string;
  attempts: number;
  printedAt: number | null;
}

async function fetchJob(
  request: APIRequestContext,
  jobId: string
): Promise<PrintJobDto | undefined> {
  const res = await request.get("/api/printing/jobs");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { jobs: PrintJobDto[] };
  return body.jobs.find((j) => j.id === jobId);
}

/** Force `PrintingManagement` to unmount+remount (its own `loadJobs` only runs on mount) so its
 * admin-list DOM reflects the CURRENT server state, not a stale render from an earlier click. */
async function reopenPrintingPanel(page: Page): Promise<void> {
  await openAdminSection(page, "admin-nav-members-management");
  await openAdminSection(page, "admin-nav-printing");
  await expect(page.getByTestId("printing-management")).toBeVisible();
  await page.getByTestId("printing-tab-diagnostics").click();
}

test("admin test-print → claim → degrade → retry → ack → printed; re-trigger → alreadyPrinted (#)", async ({
  page,
  printerSession,
}) => {
  // Timeout: see the file-level `test.describe.configure({ timeout: 90_000 })` above.

  // 1) Access gate -> device provisioning (daily-briefing.spec.ts precedent).
  await page.goto("/");
  await expect(page.getByTestId("access-gate-form")).toBeVisible();
  await page.getByTestId("access-gate-form").locator('input[name="token"]').fill(ACCESS_TOKEN);
  await page.getByRole("button", { name: "Enter" }).click();
  await expect(page.getByRole("button", { name: "Provision Device" })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByLabel("Bootstrap key").fill(BOOTSTRAP_KEY);
  await page.getByRole("button", { name: "Provision Device" }).click();
  await expect(page.getByTestId("home-surface")).toBeVisible({ timeout: 15_000 });

  const settingsResponse = await page.request.get("/api/settings");
  expect(settingsResponse.status()).toBe(200);
  const settings = (await settingsResponse.json()) as { locale: { language?: string } };
  const m = messages[resolveLang(settings.locale.language)];

  // 2) The one printer session is mounted globally (Shell.tsx — ABOVE the admin-unlock branch),
  // so its compact recovery entry point is visible before admin unlock. Confirm the e2e transport
  // hook is really the mechanism in play before scripting anything through it.
  const attentionPill = page.getByTestId("printer-attention-pill");
  await expect(attentionPill).toBeVisible();
  const hookPresent = await page.evaluate(() => typeof window.__mpPrintTransport !== "undefined");
  expect(hookPresent).toBe(true);

  // 3) Pair (explicit user gesture, per FR-019/US4) — the fake's pair never fails unscripted;
  // capability registration (FR-021) happens inside handlePair BEFORE "paired" is observable.
  await attentionPill.click();
  const attentionState = page.getByTestId("printer-attention-state");
  await expect(attentionState).toHaveText(m["printing.executor.state.unpaired"]);
  await page.getByTestId("printer-attention-pair").click();
  await expect(attentionState).toHaveText(m["printing.executor.state.paired"], { timeout: 10_000 });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("printer-attention-dialog")).toHaveCount(0);

  // 4) Script a ONE-SHOT transport failure BEFORE any job exists — see the module doc above for
  // why this, not a second job, is how this single spec proves both the happy path AND
  // degradation/recovery. `disconnect` is deliberately omitted (default false): this is a
  // transient write hiccup that keeps the connection "paired" (AC2), not a dropped device.
  await page.evaluate(() => window.__mpPrintTransport?.scriptPrintFailure());

  // 5) Enter Admin through the visible family flow, then unlock -> Printing management -> trigger
  // the test print through the REAL UI.
  await unlockAdmin(page, ADMIN_PIN);
  await openAdminSection(page, "admin-nav-printing");
  const management = page.getByTestId("printing-management");
  await expect(management).toBeVisible();
  await management.getByTestId("printing-tab-diagnostics").click();

  const firstFailureResponse = page.waitForResponse(
    (response) =>
      /\/api\/printing\/jobs\/[^/]+\/fail$/.test(response.url()) &&
      response.request().method() === "POST",
    { timeout: 15_000 }
  );

  const firstTriggerResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/printing/test-print") && response.request().method() === "POST"
  );
  await management.getByTestId("printing-trigger-test-print").click();
  const firstTriggerBody = (await (await firstTriggerResponse).json()) as {
    enqueued: boolean;
    jobId: string | null;
    alreadyPrinted?: boolean;
  };
  // Safety net (should be unreachable in practice — `printState`'s `cleanTestPrintState` above
  // already cleared any prior "test-print" record before this test body ever ran). Fail loudly
  // with the exact diagnosis rather than silently, in case that cleanup itself regresses.
  expect(
    firstTriggerBody.enqueued,
    "expected a fresh enqueue — cleanTestPrintState() should have cleared any stale " +
      "'test-print' record in printState; if this fires, that cleanup itself likely regressed"
  ).toBe(true);
  expect(firstTriggerBody.alreadyPrinted).toBeFalsy();
  const jobId = firstTriggerBody.jobId;
  if (!jobId) throw new Error("unreachable — enqueued: true always carries a jobId");

  await expect(
    management.getByText(m["printing.management.trigger.enqueued"], { exact: true })
  ).toBeVisible();

  // Observe the real failure response: the next executor tick can recover before a
  // separate jobs-list read sees the transient retrying state on a slower runner.
  const failureResponse = await firstFailureResponse;
  expect(failureResponse.status()).toBe(200);
  const retryingJob = (await failureResponse.json()) as PrintJobDto;
  expect(retryingJob.id).toBe(jobId);
  expect(retryingJob.derivedState).toBe("retrying");
  expect(retryingJob.attempts).toBe(1);
  expect(retryingJob.printedAt).toBeNull();

  // 7) Recovery WITHOUT any re-trigger (FR-009): the next poll tick claims the SAME job again
  // (no scripted failure queued this time) and this time the transmit+ack succeed.
  await expect
    .poll(async () => (await fetchJob(page.request, jobId))?.derivedState, {
      timeout: 15_000,
      intervals: [100],
    })
    .toBe("printed");
  const printedJob = await fetchJob(page.request, jobId);
  expect(printedJob?.printedAt).not.toBeNull();
  // The recoverable failure's own attempts+1 survives the eventual successful ack (ackJob never
  // resets it) — direct proof a real degradation occurred on this exact job, not a lucky skip.
  expect(printedJob?.attempts).toBe(1);

  // 8) Byte-level proof (FR-008/FR-020): the SUCCESSFUL attempt's chunks (the failed attempt
  // recorded nothing — the fake throws before writeChunks runs) begin with the ESC/POS init
  // sequence (ESC @) and end with the full-cut command (GS V 0), per escpos.ts's own wrap.
  const chunkArrays = await page.evaluate(() =>
    (window.__mpPrintTransport?.recordedChunks() ?? []).map((chunk) => Array.from(chunk))
  );
  const allBytes = chunkArrays.flat();
  expect(allBytes.length).toBeGreaterThan(0);
  expect(allBytes.slice(0, 2)).toEqual([0x1b, 0x40]); // ESC @ — initialise
  expect(allBytes.slice(-3)).toEqual([0x1d, 0x56, 0x00]); // GS V 0 — full cut

  // 9) The admin list, force-refreshed through the real UI, shows `printed` for this exact job.
  await reopenPrintingPanel(page);
  await expect(page.getByTestId(`printing-job-state-${jobId}`)).toHaveText(
    m["printing.management.state.printed"]
  );

  // 10) Re-trigger the SAME record/date (FR-012): no second job, `alreadyPrinted: true`.
  const secondTriggerResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/printing/test-print") && response.request().method() === "POST"
  );
  await page.getByTestId("printing-management").getByTestId("printing-trigger-test-print").click();
  const secondTriggerBody = (await (await secondTriggerResponse).json()) as {
    enqueued: boolean;
    jobId: string | null;
    alreadyPrinted?: boolean;
  };
  expect(secondTriggerBody.enqueued).toBe(false);
  expect(secondTriggerBody.alreadyPrinted).toBe(true);
  expect(secondTriggerBody.jobId).toBe(jobId);
  await expect(
    page
      .getByTestId("printing-management")
      .getByText(m["printing.management.trigger.alreadyPrinted"], { exact: true })
  ).toBeVisible();

  // No duplicate job was created for this record/date.
  const allJobsRes = await page.request.get("/api/printing/jobs");
  const allJobsBody = (await allJobsRes.json()) as { jobs: PrintJobDto[] };
  const testPrintJobsToday = allJobsBody.jobs.filter((j) => j.recordKey === "test-print");
  expect(testPrintJobsToday.map((j) => j.id)).toEqual([jobId]);

  // 11) Reset today's print (FR-016) through the real UI: the same record becomes printable and
  // a new test print is enqueued and printed by the paired executor.
  const resetResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/printing/reset-today") && response.request().method() === "POST"
  );
  await page.getByTestId("printing-reset-today").click();
  await page.getByTestId("printing-reset-today-confirm").click();
  const resetBody = (await (await resetResponse).json()) as {
    resetRecords: number;
    cancelledJobs: number;
  };
  expect(resetBody.resetRecords).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId("printing-reset-today-result")).toBeVisible();

  const thirdTriggerResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/printing/test-print") && response.request().method() === "POST"
  );
  await page.getByTestId("printing-trigger-test-print").click();
  const thirdTriggerBody = (await (await thirdTriggerResponse).json()) as {
    enqueued: boolean;
    jobId: string | null;
  };
  expect(thirdTriggerBody.enqueued).toBe(true);
  expect(thirdTriggerBody.jobId).not.toBe(jobId);
  await expect
    .poll(async () => (await fetchJob(page.request, thirdTriggerBody.jobId!))?.derivedState, {
      timeout: 15_000,
      intervals: [100],
    })
    .toBe("printed");
});

test("printing administration uses the same pair action as printer attention", async ({
  page,
  printerSession,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("access-gate-form")).toBeVisible();
  await page.getByTestId("access-gate-form").locator('input[name="token"]').fill(ACCESS_TOKEN);
  await page.getByRole("button", { name: "Enter" }).click();
  await page.getByLabel("Bootstrap key").fill(BOOTSTRAP_KEY);
  await page.getByRole("button", { name: "Provision Device" }).click();
  await expect(page.getByTestId("home-surface")).toBeVisible({ timeout: 15_000 });

  await page.goto("/admin/printing");
  await expect(page.getByTestId("admin-pin-keypad")).toBeVisible();
  await unlockAdmin(page, ADMIN_PIN);
  await openAdminSection(page, "admin-nav-printing");
  await expect(page.getByTestId("printing-management-pair")).toBeVisible();
  await page.getByTestId("printing-management-pair").click();
  await expect(page.getByTestId("printing-management-pair")).toBeHidden({ timeout: 10_000 });

  // Pairing fills the printer fields from the fake transport; Save writes printerTransport.
  try {
    await expect(page.getByTestId("printer-device-id")).toHaveValue("fake-printer");
    const saveResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/settings") && response.request().method() === "PUT"
    );
    await page.getByTestId("printer-settings-save").click();
    expect((await saveResponse).status()).toBe(200);
    await expect(page.getByTestId("printer-settings-saved")).toBeVisible();
    const stored = (await (await page.request.get("/api/settings")).json()) as {
      printerTransport?: { deviceId: string };
    };
    expect(stored.printerTransport?.deviceId).toBe("fake-printer");
  } finally {
    await page.request.put("/api/settings", {
      data: {
        object: "printerTransport",
        settings: { deviceId: "", name: "", serviceUuid: "", characteristicUuid: "" },
      },
    });
  }
});
