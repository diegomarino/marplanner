import { expect, test, type Page } from "@playwright/test";
import { expectAdminSectionListed, openAdminSection } from "./admin-nav";

import { messages, resolveLang } from "../../src/client/i18n/messages";
import { PLUGIN_IDS, type PluginCatalogEntry } from "../../src/shared/plugins";
import { unlockAdmin } from "./admin-unlock";
import { startFreshPluginLifecycleServer } from "./plugin-lifecycle-server";

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";
const BOOTSTRAP_KEY = process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key";
const MP_ADMIN_PIN = process.env.MP_ADMIN_PIN ?? "1234";
let server: Awaited<ReturnType<typeof startFreshPluginLifecycleServer>>;

test.beforeAll(async () => {
  server = await startFreshPluginLifecycleServer();
});

test.afterAll(async () => {
  await server.stop();
});

async function readCatalog(page: Page, origin: string): Promise<PluginCatalogEntry[]> {
  const response = await page.request.get(`${origin}/api/plugins`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { plugins: PluginCatalogEntry[] }).plugins;
}

test("fresh lifecycle catalog keeps API and UI aligned across a repeat activation cycle", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto(server.origin);
  await expect(page.getByTestId("access-gate-form")).toBeVisible();
  await page.getByTestId("access-gate-form").locator('input[name="token"]').fill(ACCESS_TOKEN);
  await page.getByRole("button", { name: "Enter" }).click();
  await expect(page.getByRole("button", { name: "Provision Device" })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByLabel("Bootstrap key").fill(BOOTSTRAP_KEY);
  await page.getByRole("button", { name: "Provision Device" }).click();
  await expect(page.getByTestId("home-surface")).toBeVisible({ timeout: 15_000 });

  const settingsResponse = await page.request.get(`${server.origin}/api/settings`);
  expect(settingsResponse.status()).toBe(200);
  const settings = (await settingsResponse.json()) as { locale?: { language?: string } };
  const copy = messages[resolveLang(settings.locale?.language)];

  const freshCatalog = await readCatalog(page, server.origin);
  expect(freshCatalog.map(({ id }) => id)).toEqual(PLUGIN_IDS);
  expect(freshCatalog.every(({ state }) => state === "inactive")).toBe(true);
  expect(freshCatalog.some(({ id }) => id === ("external-calendar-sync" as never))).toBe(false);

  await unlockAdmin(page, MP_ADMIN_PIN);
  await openAdminSection(page, "admin-nav-plugins");
  const rows = page.getByTestId(/^plugin-row-/);
  await expect(rows).toHaveCount(9);
  expect(
    await rows.evaluateAll((elements) => elements.map((element) => element.dataset.pluginId))
  ).toEqual(PLUGIN_IDS);
  for (const pluginId of PLUGIN_IDS) {
    await expect(page.getByTestId(`plugin-state-${pluginId}`)).toHaveText(
      copy["plugins.state.inactive"]
    );
  }
  await expectAdminSectionListed(page, "admin-nav-weather", false, "admin-nav-plugins");

  const weather = page.getByTestId("plugin-row-weather");
  for (let cycle = 0; cycle < 2; cycle += 1) {
    const activateResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/plugins/weather/activate") &&
        response.request().method() === "POST"
    );
    await weather
      .getByRole("button", {
        name: copy["plugins.weather.label"],
        pressed: false,
      })
      .click();
    expect((await activateResponse).status()).toBe(200);
    await expect(page.getByTestId("plugin-state-weather")).toHaveText(copy["plugins.state.active"]);
    await expectAdminSectionListed(page, "admin-nav-weather", true, "admin-nav-plugins");
    await expect(page.getByTestId(/^plugin-row-/)).toHaveCount(9);
    await expect(page.getByTestId("plugin-row-weather")).toHaveCount(1);
    await expect(
      weather.getByRole("button", {
        name: copy["plugins.weather.label"],
        pressed: true,
      })
    ).toHaveCount(1);
    expect((await readCatalog(page, server.origin)).find(({ id }) => id === "weather")?.state).toBe(
      "active"
    );

    const deactivateResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/plugins/weather/deactivate") &&
        response.request().method() === "POST"
    );
    await weather
      .getByRole("button", {
        name: copy["plugins.weather.label"],
        pressed: true,
      })
      .click();
    expect((await deactivateResponse).status()).toBe(200);
    await expect(page.getByTestId("plugin-state-weather")).toHaveText(
      copy["plugins.state.inactive"]
    );
    await expectAdminSectionListed(page, "admin-nav-weather", false, "admin-nav-plugins");
    await expect(page.getByTestId(/^plugin-row-/)).toHaveCount(9);
    await expect(page.getByTestId("plugin-row-weather")).toHaveCount(1);
    await expect(
      weather.getByRole("button", {
        name: copy["plugins.weather.label"],
        pressed: false,
      })
    ).toHaveCount(1);
    expect((await readCatalog(page, server.origin)).find(({ id }) => id === "weather")?.state).toBe(
      "inactive"
    );
  }

  const finalCatalog = await readCatalog(page, server.origin);
  expect(finalCatalog.map(({ id }) => id)).toEqual(PLUGIN_IDS);
  expect(finalCatalog).toHaveLength(9);
  await expect(page.getByTestId("plugin-row-weather")).toHaveCount(1);
});
