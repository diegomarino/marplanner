import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExternalSourcePublic, SynchronizationPhase } from "../../src/shared";
import { unlockAdmin } from "./admin-unlock";

const BOOTSTRAP_KEY = "mpk-calendar-feed-tracer";
const ACCESS_TOKEN = "mpg-calendar-feed-tracer";
const CONTROLLED_FEED_URL = "https://calendar.example.test/subscription.ics";
const UNSAFE_FEED_URL = "http://127.0.0.1:9/private.ics";
const FAILED_FEED_URL = "https://calendar.example.test/unavailable.ics";
const LOCAL_EGRESS_SINK = "http://127.0.0.1:9/unavailable";
const HARNESS_ENTRY = resolve(process.cwd(), "tests/helpers/calendar-process.ts");

async function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("missing port"));
      server.close(() => resolvePort(address.port));
    });
  });
}

async function startHarness(
  port: number,
  dataDir: string
): Promise<{
  child: ChildProcess;
  output: () => string;
}> {
  const child = spawn(process.execPath, ["--import", "tsx", HARNESS_ENTRY], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      DATABASE_PATH: "marplanner.db",
      MP_BOOTSTRAP_KEY: BOOTSTRAP_KEY,
      MP_MANAGEMENT_KEY: "",
      MP_ACCESS_TOKEN: ACCESS_TOKEN,
      MP_ADMIN_PIN: "1234",
      SCHEDULER_DISABLED: "1",
      WEATHER_ENDPOINT: LOCAL_EGRESS_SINK,
      QUOTE_ENDPOINT: LOCAL_EGRESS_SINK,
      ONTHISDAY_ENDPOINT: LOCAL_EGRESS_SINK,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`calendar harness exited early:\n${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok && output.includes("calendar-harness-ready")) {
        return { child, output: () => output };
      }
    } catch {
      // The isolated process has not started listening yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  child.kill("SIGKILL");
  throw new Error(`calendar harness did not become ready:\n${output}`);
}

async function stopHarness(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise<void>((resolveWait) => setTimeout(resolveWait, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

function authCookie(response: Response): string {
  const setCookies = response.headers.getSetCookie();
  const deviceCookie = setCookies.find((value) => value.startsWith("mp_device_key="));
  if (!deviceCookie) throw new Error("Provisioning did not return a device cookie");
  return deviceCookie.split(";", 1)[0];
}

function utcDate(offsetDays: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

async function listSources(baseUrl: string, cookie: string): Promise<ExternalSourcePublic[]> {
  const response = await fetch(`${baseUrl}/api/calendar/external-sources`, {
    headers: { cookie },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as ExternalSourcePublic[];
}

async function mergedEvents(
  baseUrl: string,
  cookie: string
): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(
    `${baseUrl}/api/calendar/events?source=all&from=${utcDate(0)}&to=${utcDate(2)}`,
    { headers: { cookie } }
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Array<Record<string, unknown>>;
}

async function waitForPhase(
  baseUrl: string,
  cookie: string,
  id: string,
  phase: SynchronizationPhase
): Promise<ExternalSourcePublic> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const source = (await listSources(baseUrl, cookie)).find((item) => item.id === id);
    if (source?.phase === phase) return source;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`Synthetic source did not reach ${phase}`);
}

async function openAdminCalendar(page: Page, baseUrl: string, cookie: string): Promise<void> {
  const [name, value] = cookie.split("=", 2);
  await page.context().addCookies([
    { name, value, url: baseUrl, httpOnly: true },
    { name: "mp_provisioned", value: "1", url: baseUrl },
  ]);
  await page.goto(baseUrl);
  await page.locator('input[name="token"]').fill(ACCESS_TOKEN);
  await page.getByRole("button", { name: "Enter" }).click();
  await page.goto(`${baseUrl}/admin/calendar`);
  await unlockAdmin(page, "1234");
  await expect(page.getByTestId("calendar-management")).toBeVisible();
}

test("process tracer persists, synchronizes, and merges one controlled feed", async () => {
  test.setTimeout(60_000);
  const port = await getFreePort();
  const dataDir = mkdtempSync(join(tmpdir(), "mp-calendar-tracer-"));
  const baseUrl = `http://127.0.0.1:${port}`;
  let harness: Awaited<ReturnType<typeof startHarness>> | undefined;

  try {
    harness = await startHarness(port, dataDir);
    const unauthenticated = await fetch(`${baseUrl}/api/calendar/external-sources`);
    expect(unauthenticated.status).toBe(401);

    const provision = await fetch(`${baseUrl}/api/auth/provision`, {
      method: "POST",
      headers: { authorization: `Bearer ${BOOTSTRAP_KEY}` },
    });
    expect(provision.status).toBe(200);
    const cookie = authCookie(provision);

    const unsafe = await fetch(`${baseUrl}/api/calendar/external-sources/unsafe`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Unsafe", provider: "ics_generic", feedUrl: UNSAFE_FEED_URL }),
    });
    expect(unsafe.status).toBe(400);
    expect(harness.output()).not.toContain("calendar-fixture-request");

    const created = await fetch(`${baseUrl}/api/calendar/external-sources/tracer`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Synthetic calendar",
        provider: "ics_generic",
        feedUrl: CONTROLLED_FEED_URL,
        pollIntervalMin: 30,
      }),
    });
    expect(created.status).toBe(202);
    const createdSource = (await created.json()) as ExternalSourcePublic;
    expect(createdSource).not.toHaveProperty("feedUrl");
    expect(createdSource.pollIntervalMin).toBe(30);

    const observed: SynchronizationPhase[] = [];
    let source = createdSource;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && source.phase !== "succeeded") {
      if (source.phase && observed.at(-1) !== source.phase) observed.push(source.phase);
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      const response = await fetch(`${baseUrl}/api/calendar/external-sources`, {
        headers: { cookie },
      });
      expect(response.status).toBe(200);
      [source] = (await response.json()) as ExternalSourcePublic[];
    }
    if (source.phase && observed.at(-1) !== source.phase) observed.push(source.phase);
    expect(observed).toEqual(["requesting", "downloading", "parsing", "reconciling", "succeeded"]);
    expect(source.lastImportedCount).toBe(1);
    expect(harness.output().match(/calendar-fixture-request/g)).toHaveLength(1);

    const eventsResponse = await fetch(
      `${baseUrl}/api/calendar/events?source=all&from=${utcDate(0)}&to=${utcDate(2)}`,
      { headers: { cookie } }
    );
    expect(eventsResponse.status).toBe(200);
    const events = (await eventsResponse.json()) as Array<Record<string, unknown>>;
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "external", title: "Synthetic tracer event" }),
      ])
    );

    const clientBodies = JSON.stringify([createdSource, source, events]);
    expect(clientBodies).not.toContain(CONTROLLED_FEED_URL);
    expect(clientBodies).not.toContain("subscription.ics");
    expect(harness.output()).not.toContain(CONTROLLED_FEED_URL);
    expect(harness.output()).not.toContain(UNSAFE_FEED_URL);
  } finally {
    if (harness) await stopHarness(harness.child);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Admin journey keeps source controls distinct and highlight order observable", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const port = await getFreePort();
  const dataDir = mkdtempSync(join(tmpdir(), "mp-calendar-acceptance-"));
  const baseUrl = `http://127.0.0.1:${port}`;
  let harness: Awaited<ReturnType<typeof startHarness>> | undefined;
  let cookie: string | undefined;

  try {
    harness = await startHarness(port, dataDir);
    const provision = await fetch(`${baseUrl}/api/auth/provision`, {
      method: "POST",
      headers: { authorization: `Bearer ${BOOTSTRAP_KEY}` },
    });
    expect(provision.status).toBe(200);
    cookie = authCookie(provision);
    const locale = await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        object: "locale",
        settings: { timezone: "Europe/Madrid", language: "en", weekStartDay: 1 },
      }),
    });
    expect(locale.status).toBe(200);
    await openAdminCalendar(page, baseUrl, cookie);

    await page.getByLabel("Name", { exact: true }).fill("Synthetic calendar");
    await page.getByLabel("Feed URL").fill(CONTROLLED_FEED_URL);
    await page.getByRole("button", { name: "Add source" }).click();
    await expect(page.getByTestId(/^external-source-/)).toHaveCount(1);
    const [created] = await listSources(baseUrl, cookie);
    const sourceCard = page.getByTestId(`external-source-${created.id}`);
    await expect(sourceCard).toContainText("Synthetic calendar");
    expect(created).toMatchObject({
      name: "Synthetic calendar",
      enabled: true,
      pollIntervalMin: 15,
    });
    expect(created).not.toHaveProperty("feedUrl");
    await waitForPhase(baseUrl, cookie, created.id, "succeeded");
    expect(
      (await mergedEvents(baseUrl, cookie)).filter(
        (event) => event.title === "Synthetic tracer event"
      )
    ).toHaveLength(1);

    await page.getByLabel("Name", { exact: true }).fill("Unavailable synthetic calendar");
    await page.getByLabel("Feed URL").fill(FAILED_FEED_URL);
    await page.getByRole("button", { name: "Add source" }).click();
    const failedCard = page
      .getByTestId(/^external-source-/)
      .filter({ hasText: "Unavailable synthetic calendar" });
    await expect(failedCard).toBeVisible();
    const failedSource = (await listSources(baseUrl, cookie)).find(
      (item) => item.name === "Unavailable synthetic calendar"
    );
    expect(failedSource).toBeDefined();
    const firstFailure = await waitForPhase(baseUrl, cookie, failedSource!.id, "failed");
    expect(firstFailure.consecutiveFailures).toBe(1);
    expect(firstFailure.lastErrorCode).toBeTruthy();
    await expect(failedCard.getByRole("button", { name: "Sync now" })).toBeEnabled();
    await failedCard.getByRole("button", { name: "Sync now" }).click();
    await expect
      .poll(
        async () =>
          (await listSources(baseUrl, cookie)).find((item) => item.id === failedSource!.id)
            ?.consecutiveFailures
      )
      .toBe(2);
    expect(
      (await mergedEvents(baseUrl, cookie)).filter(
        (event) => event.title === "Synthetic tracer event"
      )
    ).toHaveLength(1);

    await sourceCard.getByRole("checkbox", { name: "Enabled" }).click();
    await expect(sourceCard.getByRole("checkbox", { name: "Enabled" })).not.toBeChecked();
    expect(
      (await listSources(baseUrl, cookie)).find((item) => item.id === created.id)?.enabled
    ).toBe(false);
    expect(
      (await mergedEvents(baseUrl, cookie)).filter(
        (event) => event.title === "Synthetic tracer event"
      )
    ).toHaveLength(0);
    const disabledSync = await fetch(
      `${baseUrl}/api/calendar/external-sources/${created.id}/sync`,
      {
        method: "POST",
        headers: { cookie },
      }
    );
    expect(disabledSync.status).toBe(409);

    await sourceCard.getByRole("checkbox", { name: "Enabled" }).click();
    await expect(sourceCard.getByRole("checkbox", { name: "Enabled" })).toBeChecked();
    expect(
      (await mergedEvents(baseUrl, cookie)).filter(
        (event) => event.title === "Synthetic tracer event"
      )
    ).toHaveLength(1);
    const beforeManual = harness.output().match(/calendar-fixture-request/g)?.length ?? 0;
    const firstSync = await fetch(`${baseUrl}/api/calendar/external-sources/${created.id}/sync`, {
      method: "POST",
      headers: { cookie },
    });
    expect(firstSync.status).toBe(202);
    const overlappingSync = await fetch(
      `${baseUrl}/api/calendar/external-sources/${created.id}/sync`,
      {
        method: "POST",
        headers: { cookie },
      }
    );
    expect(overlappingSync.status).toBe(202);
    await waitForPhase(baseUrl, cookie, created.id, "succeeded");
    expect((harness.output().match(/calendar-fixture-request/g)?.length ?? 0) - beforeManual).toBe(
      1
    );
    expect(
      (await mergedEvents(baseUrl, cookie)).filter(
        (event) => event.title === "Synthetic tracer event"
      )
    ).toHaveLength(1);

    await page.getByLabel("Emoji", { exact: true }).fill("⭐");
    await page.getByLabel("Keywords").fill("tracer");
    await page.getByRole("button", { name: "Add rule" }).click();
    await expect(page.getByRole("button", { name: "Move ⭐ rule" })).toBeVisible();
    await page.getByLabel("Emoji", { exact: true }).fill("🌟");
    await page.getByLabel("Keywords").fill("tracer");
    await expect(page.getByRole("button", { name: "Add rule" })).toBeEnabled();
    await page.getByRole("button", { name: "Add rule" }).click();
    const rulesUrl = `${baseUrl}/api/calendar/highlight-rules`;
    const readRules = async () => {
      const response = await fetch(rulesUrl, { headers: { cookie } });
      expect(response.status).toBe(200);
      return (await response.json()) as Array<{ id: string; emoji: string; enabled: boolean }>;
    };
    await expect.poll(async () => (await readRules()).length).toBe(2);
    const initialRules = await readRules();
    expect(initialRules.map((rule) => rule.emoji)).toEqual(["⭐", "🌟"]);
    expect(
      (await mergedEvents(baseUrl, cookie)).filter(
        (event) => event.decoratedTitle === "⭐ Synthetic tracer event"
      )
    ).toHaveLength(1);
    const firstHandle = page.getByRole("button", { name: "Move ⭐ rule" });
    const secondHandle = page.getByRole("button", { name: "Move 🌟 rule" });
    await expect(secondHandle).toBeEnabled();
    const reorderResponsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/calendar/highlight-rules/reorder") &&
        response.request().method() === "PUT"
    );
    const firstBox = await firstHandle.boundingBox();
    const secondBox = await secondHandle.boundingBox();
    expect(firstBox).not.toBeNull();
    expect(secondBox).not.toBeNull();
    await page.mouse.move(
      secondBox!.x + secondBox!.width / 2,
      secondBox!.y + secondBox!.height / 2
    );
    await page.mouse.down();
    await page.mouse.move(firstBox!.x + firstBox!.width / 2, firstBox!.y + firstBox!.height / 2, {
      steps: 10,
    });
    await page.mouse.up();
    const reorderResponse = await reorderResponsePromise;
    expect(reorderResponse.status()).toBe(200);
    await reorderResponse.finished();
    await expect
      .poll(async () => (await readRules()).map((rule) => rule.emoji))
      .toEqual(["🌟", "⭐"]);
    expect(
      (await mergedEvents(baseUrl, cookie)).filter(
        (event) => event.decoratedTitle === "🌟 Synthetic tracer event"
      )
    ).toHaveLength(1);

    const firstRuleCard = page.getByTestId(`highlight-rule-${initialRules[1].id}`);
    const enabledCheckbox = firstRuleCard.getByRole("checkbox", { name: "Enabled" });
    await expect(enabledCheckbox).toBeEnabled();
    // @dnd-kit PointerSensor retains its document click suppression for 50ms after
    // detach, including checkbox clicks synthesized by Space. Wait for that known
    // sensor cleanup boundary, then exercise native checkbox keyboard activation.
    await page.waitForTimeout(50);
    await enabledCheckbox.focus();
    await page.keyboard.press("Space");
    await expect
      .poll(async () => (await readRules()).find((rule) => rule.id === initialRules[1].id)?.enabled)
      .toBe(false);
    expect(
      (await mergedEvents(baseUrl, cookie)).filter(
        (event) => event.decoratedTitle === "⭐ Synthetic tracer event"
      )
    ).toHaveLength(1);
    await firstRuleCard.getByRole("button", { name: "Delete rule" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
    await expect.poll(async () => (await readRules()).map((rule) => rule.emoji)).toEqual(["⭐"]);

    await sourceCard.getByRole("button", { name: "Delete source" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    expect((await listSources(baseUrl, cookie)).map((item) => item.id)).toContain(created.id);
    await sourceCard.getByRole("button", { name: "Delete source" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
    await expect
      .poll(async () => (await listSources(baseUrl, cookie)).map((item) => item.id))
      .not.toContain(created.id);
    expect(
      (await mergedEvents(baseUrl, cookie)).filter((event) => event.source === "external")
    ).toHaveLength(0);
    const failedDelete = await fetch(
      `${baseUrl}/api/calendar/external-sources/${failedSource!.id}`,
      {
        method: "DELETE",
        headers: { cookie },
      }
    );
    expect(failedDelete.status).toBe(204);
    const finalRuleDelete = await fetch(`${rulesUrl}/${initialRules[0].id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(finalRuleDelete.status).toBe(204);
    expect(await listSources(baseUrl, cookie)).toEqual([]);
    expect(await readRules()).toEqual([]);
    expect(await mergedEvents(baseUrl, cookie)).toEqual([]);
    expect(await page.locator("body").innerText()).not.toContain(CONTROLLED_FEED_URL);
    expect(harness.output()).not.toContain(CONTROLLED_FEED_URL);
    expect(harness.output()).not.toContain(FAILED_FEED_URL);
  } finally {
    if (cookie) {
      const sources = await listSources(baseUrl, cookie).catch(() => []);
      for (const source of sources) {
        await fetch(`${baseUrl}/api/calendar/external-sources/${source.id}`, {
          method: "DELETE",
          headers: { cookie },
        }).catch(() => undefined);
      }
      const rules = await fetch(`${baseUrl}/api/calendar/highlight-rules`, { headers: { cookie } })
        .then(async (response) =>
          response.ok ? ((await response.json()) as Array<{ id: string }>) : []
        )
        .catch(() => []);
      for (const rule of rules) {
        await fetch(`${baseUrl}/api/calendar/highlight-rules/${rule.id}`, {
          method: "DELETE",
          headers: { cookie },
        }).catch(() => undefined);
      }
    }
    if (harness) await stopHarness(harness.child);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a participant chosen on a synced event survives the next sync", async ({ page }) => {
  test.setTimeout(60_000);
  const port = await getFreePort();
  const dataDir = mkdtempSync(join(tmpdir(), "mp-calendar-participants-"));
  const baseUrl = `http://127.0.0.1:${port}`;
  let harness: Awaited<ReturnType<typeof startHarness>> | undefined;

  try {
    harness = await startHarness(port, dataDir);
    const provision = await fetch(`${baseUrl}/api/auth/provision`, {
      method: "POST",
      headers: { authorization: `Bearer ${BOOTSTRAP_KEY}` },
    });
    expect(provision.status).toBe(200);
    const cookie = authCookie(provision);
    const member = await fetch(`${baseUrl}/api/members`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Ada Lovelace", role: "parent" }),
    });
    expect(member.status).toBe(201);
    const memberId = ((await member.json()) as { id: string }).id;
    const created = await fetch(`${baseUrl}/api/calendar/external-sources/tracer`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Synthetic calendar",
        provider: "ics_generic",
        feedUrl: CONTROLLED_FEED_URL,
      }),
    });
    expect(created.status).toBe(202);
    const firstSync = await waitForPhase(baseUrl, cookie, "tracer", "succeeded");
    const locale = await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        object: "locale",
        settings: { timezone: "UTC", language: "en", weekStartDay: 1 },
      }),
    });
    expect(locale.status).toBe(200);

    const [name, value] = cookie.split("=", 2);
    await page.context().addCookies([
      { name, value, url: baseUrl, httpOnly: true },
      { name: "mp_provisioned", value: "1", url: baseUrl },
    ]);
    await page.goto(baseUrl);
    await page.locator('input[name="token"]').fill(ACCESS_TOKEN);
    await page.getByRole("button", { name: "Enter" }).click();
    const row = page
      .getByTestId("calendar-event-row")
      .filter({ hasText: "Synthetic tracer event" });
    // The event is tomorrow (UTC) and the household runs on UTC, so the month to show is known up
    // front rather than read off a grid that may still be loading.
    const tomorrowInNextMonth = utcDate(1).slice(0, 7) !== utcDate(0).slice(0, 7);
    const openTracer = async (load: () => Promise<unknown>): Promise<void> => {
      await load();
      await expect(page.getByTestId("calendar-month-grid")).toBeVisible();
      if (tomorrowInNextMonth) await page.getByRole("button", { name: "Next period" }).click();
      await row.click();
    };
    await openTracer(() => page.goto(`${baseUrl}/calendar`));

    const detail = page.getByTestId("calendar-event-detail");
    await expect(detail.getByTestId("calendar-edit-btn")).toHaveCount(0);
    await detail.getByTestId("calendar-edit-participants-btn").click();
    await detail.getByTestId(`calendar-assign-member-${memberId}`).check();
    const assigned = page.waitForResponse(
      (response) => response.url().includes("/assignments") && response.request().method() === "PUT"
    );
    await detail.getByTestId("calendar-participants-save-btn").click();
    expect((await assigned).status()).toBe(200);
    await expect(detail).toBeHidden();

    const sync = await fetch(`${baseUrl}/api/calendar/external-sources/tracer/sync`, {
      method: "POST",
      headers: { cookie },
    });
    expect(sync.status).toBe(202);
    await expect
      .poll(async () => (await listSources(baseUrl, cookie))[0].lastSuccessAt)
      .toBeGreaterThan(firstSync.lastSuccessAt ?? 0);
    const tracer = (await mergedEvents(baseUrl, cookie)).filter(
      (event) => event.title === "Synthetic tracer event"
    );
    expect(tracer).toEqual([expect.objectContaining({ assignedTo: [memberId] })]);

    await openTracer(() => page.reload());
    await expect(
      detail.getByRole("list", { name: "Who is it for" }).getByText("Ada Lovelace")
    ).toBeVisible();
  } finally {
    if (harness) await stopHarness(harness.child);
    rmSync(dataDir, { recursive: true, force: true });
  }
});
