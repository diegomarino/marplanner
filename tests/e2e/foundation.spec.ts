import { expect, test } from "@playwright/test";

const accessToken = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";

test("B0 gate protects and serves the built foundation at desktop and narrow widths", async ({
  page,
  request,
}) => {
  const health = await request.get("/health");
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ status: "ok" });
  const protectedSettings = await request.get("/api/settings");
  expect(protectedSettings.status()).toBe(401);
  expect(await protectedSettings.text()).not.toContain("timezone");
  for (const width of [1280, 320]) {
    await page.context().clearCookies();
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    await expect(page.getByTestId("access-gate-form")).toBeVisible();
    await page.getByLabel("Access token").fill(accessToken);
    await page.getByRole("button", { name: "Enter" }).click();
    await expect(page.getByTestId("access-gate-form")).toHaveCount(0);
    await expect(page.locator("#root")).not.toBeEmpty();
    await expect(page.locator("#root")).toContainText(/\S/);
    await expect(page.getByRole("heading", { name: /Marplanner/i })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
  }
  const serverArtifact = await page.request.get("/server/index.js");
  expect(serverArtifact.status()).toBe(404);
});
