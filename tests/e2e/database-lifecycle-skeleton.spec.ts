import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("database lifecycle skeleton boots, reads publicly, and reports its declared date", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByTestId("access-gate-form")
    .locator('input[name="token"]')
    .fill(process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token");
  await page.getByRole("button", { name: "Enter", exact: true }).click();
  await page
    .getByLabel("Bootstrap key")
    .fill(process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key");
  await page.getByRole("button", { name: "Provision Device" }).click();
  await expect(page.getByTestId("home-surface")).toBeVisible();

  const settings = await page.request.get("/api/settings");
  expect(settings.ok()).toBe(true);
  await expect(settings.json()).resolves.toEqual(expect.any(Object));

  const dataDirectory = await mkdtemp(join(tmpdir(), "mp-e2e-seed-"));
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("npm", ["run", "seed", "--", "--as-of", "2026-09-23"], {
      cwd: process.cwd(),
      env: { ...process.env, DATA_DIR: dataDirectory },
    }));
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }

  expect(stdout).toContain("mode=public");
  expect(stdout).toContain("as-of=2026-09-23");
  expect(stdout).toContain(
    "modules=[public:settings,members:demo,calendar:demo,routines:demo,reminders:demo,meals:demo,daily:content:demo,time:announcements:demo]"
  );
  expect(stdout).toContain("status=complete");
});
