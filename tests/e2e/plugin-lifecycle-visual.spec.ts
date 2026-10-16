import { join } from "node:path";
import { expectAdminSectionListed } from "./admin-nav";

import { expect, test, type Locator, type Page } from "@playwright/test";
import Database from "better-sqlite3";

import { messages, resolveLang } from "../../src/client/i18n/messages";
import { PLUGIN_IDS, type PluginId, type PluginPublicErrorCode } from "../../src/shared/plugins";
import { startFreshPluginLifecycleServer } from "./plugin-lifecycle-server";

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";
const BOOTSTRAP_KEY = process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key";
const ADMIN_PIN = process.env.ADMIN_PIN ?? "1234";
const FIXED_AT = "2026-09-28T09:00:00.000Z";

const VIEWPORTS = [
  { name: "narrow-320", width: 320, height: 800 },
  { name: "wide-1440", width: 1440, height: 900 },
] as const;

const LABEL_KEYS: Record<PluginId, keyof typeof messages.en> = {
  "daily-briefing": "plugins.dailyBriefing.label",
  printing: "plugins.printing.label",
  weather: "plugins.weather.label",
  "time-announcements": "plugins.timeAnnouncements.label",
  backups: "plugins.backups.label",
  "network-devices": "plugins.networkDevices.label",
  "meals-recipes": "plugins.mealsRecipes.label",
  reminders: "plugins.reminders.label",
  "daily-messages": "plugins.dailyMessages.label",
};

const ERROR_KEYS: Record<PluginPublicErrorCode, keyof typeof messages.en> = {
  settings_initialization_failed: "plugins.error.settings",
  migration_failed: "plugins.error.migration",
  runtime_mount_failed: "plugins.error.mount",
  drain_failed: "plugins.error.drain",
  runtime_unmount_failed: "plugins.error.unmount",
  contribution_failed: "plugins.error.contribution",
  reconciliation_failed: "plugins.error.reconciliation",
};

type Copy = (typeof messages)[ReturnType<typeof resolveLang>];
let server: Awaited<ReturnType<typeof startFreshPluginLifecycleServer>>;

test.describe.configure({ mode: "serial", timeout: 120_000 });

test.beforeAll(async () => {
  server = await startFreshPluginLifecycleServer();
});

test.afterAll(async () => {
  await server.stop();
});

function openFixtureDatabase(dataDir: string): InstanceType<typeof Database> {
  return new Database(join(dataDir, "marplanner.db"));
}

function seedFixture(
  dataDir: string,
  lineage: "fresh" | "prior_baseline",
  defaultState: "active" | "inactive",
  overrides: Partial<
    Record<
      PluginId,
      {
        state: "active" | "inactive" | "errored";
        errorCode?: PluginPublicErrorCode;
        operation?: { targetState: "active" | "inactive"; phase: string };
      }
    >
  > = {}
): void {
  const db = openFixtureDatabase(dataDir);
  try {
    db.pragma("busy_timeout = 5000");
    db.transaction(() => {
      db.prepare("DELETE FROM plugin_lifecycle_operations").run();
      db.prepare(
        `UPDATE installation_lineage
         SET kind = ?, pre_run_migration_files = ?, captured_at = ?
         WHERE singleton_id = 1`
      ).run(lineage, lineage === "fresh" ? "[]" : '["0000_current_baseline.sql"]', FIXED_AT);
      db.prepare(
        `UPDATE plugin_activation_registry
         SET state = ?,
             activated_at = CASE WHEN ? = 'active' THEN ? ELSE NULL END,
             updated_at = ?,
             error_code = NULL,
             error_message = NULL`
      ).run(defaultState, defaultState, FIXED_AT, FIXED_AT);

      for (const [pluginId, override] of Object.entries(overrides) as Array<
        [PluginId, NonNullable<(typeof overrides)[PluginId]>]
      >) {
        const errorCode = override.errorCode ?? null;
        const errorMessage =
          errorCode === null
            ? null
            : {
                settings_initialization_failed: "Plugin settings could not be prepared.",
                migration_failed: "Plugin data could not be prepared.",
                runtime_mount_failed: "Plugin services could not be started.",
                drain_failed: "Plugin work could not stop safely.",
                runtime_unmount_failed: "Plugin services could not be stopped.",
                contribution_failed: "A plugin contribution failed.",
                reconciliation_failed: "Plugin recovery requires attention.",
              }[errorCode];
        db.prepare(
          `UPDATE plugin_activation_registry
           SET state = ?,
               activated_at = CASE WHEN ? = 'active' THEN ? ELSE activated_at END,
               updated_at = ?,
               error_code = ?,
               error_message = ?
           WHERE plugin_id = ?`
        ).run(
          override.state,
          override.state,
          FIXED_AT,
          FIXED_AT,
          errorCode,
          errorMessage,
          pluginId
        );
        if (override.operation) {
          db.prepare(
            `INSERT INTO plugin_lifecycle_operations
               (operation_id, plugin_id, target_state, phase, started_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(
            `visual-${pluginId}`,
            pluginId,
            override.operation.targetState,
            override.operation.phase,
            FIXED_AT,
            FIXED_AT
          );
        }
      }
    })();
  } finally {
    db.close();
  }
}

async function tabTo(page: Page, target: Locator, limit = 100): Promise<void> {
  await target.waitFor({ state: "visible" });
  for (let index = 0; index < limit; index += 1) {
    if (await target.evaluate((element) => document.activeElement === element)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Keyboard tab order did not reach ${await target.getAttribute("data-testid")}`);
}

async function provisionWithKeyboard(page: Page, origin: string): Promise<Copy> {
  await page.goto(origin);
  const accessInput = page.getByTestId("access-gate-form").locator('input[name="token"]');
  await tabTo(page, accessInput);
  await page.keyboard.type(ACCESS_TOKEN);
  const enter = page.getByRole("button", { name: "Enter", exact: true });
  await tabTo(page, enter);
  await page.keyboard.press("Enter");

  const bootstrapInput = page.getByLabel("Bootstrap key");
  await bootstrapInput.waitFor({ state: "visible" });
  await tabTo(page, bootstrapInput);
  await page.keyboard.type(BOOTSTRAP_KEY);
  const provision = page.getByRole("button", { name: "Provision Device", exact: true });
  await tabTo(page, provision);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("home-surface")).toBeVisible({ timeout: 15_000 });

  const settingsResponse = await page.request.get(`${origin}/api/settings`);
  expect(settingsResponse.status()).toBe(200);
  const settings = (await settingsResponse.json()) as { locale?: { language?: string } };
  return messages[resolveLang(settings.locale?.language)];
}

async function unlockCurrentAdminRouteWithKeyboard(page: Page): Promise<void> {
  await expect(page.getByTestId("admin-pin-keypad")).toBeVisible();
  for (const digit of ADMIN_PIN) {
    const digitButton = page.getByTestId(`admin-pin-digit-${digit}`);
    await tabTo(page, digitButton);
    await page.keyboard.press("Enter");
  }
  const unlock = page.getByTestId("admin-pin-unlock");
  await tabTo(page, unlock);
  await page.keyboard.press("Enter");
  // Unlocked: the admin sidebar is on every admin page, whichever one was requested.
  await expect(page.getByTestId("admin-sidebar")).toBeVisible({ timeout: 10_000 });
}

async function navigateFromHomeToPluginManagementWithKeyboard(
  page: Page,
  copy: Copy
): Promise<void> {
  // With Admin as its only entry, Options is the long-press Admin affordance itself.
  const admin = page.getByRole("button", { name: copy["shell.options.label"], exact: true });
  await tabTo(page, admin);
  await page.keyboard.down("Enter");
  await expect(page).toHaveURL(/\/admin$/, { timeout: 5_500 });
  await page.keyboard.up("Enter");
  await expect(page).toHaveURL(/\/admin$/);
  await unlockCurrentAdminRouteWithKeyboard(page);
  const plugins = page.getByTestId("admin-nav-plugins");
  await tabTo(page, plugins);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/admin\/plugins$/);
  await expect(page.getByTestId("plugin-catalog")).toBeVisible();
}

async function openAdminRoute(page: Page, origin: string, path: string): Promise<void> {
  await page.goto(`${origin}${path}`);
  await unlockCurrentAdminRouteWithKeyboard(page);
}

async function expectNoHorizontalPageOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect.soft(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
}

async function expectCatalogOrderAndActions(
  page: Page,
  copy: Copy,
  expectedState: "active" | "inactive"
): Promise<void> {
  const rows = page.getByTestId(/^plugin-row-/);
  await expect(rows).toHaveCount(9);
  expect(
    await rows.evaluateAll((elements) => elements.map((element) => element.dataset.pluginId))
  ).toEqual(PLUGIN_IDS);
  for (const pluginId of PLUGIN_IDS) {
    const label = copy[LABEL_KEYS[pluginId]];
    await expect(page.getByRole("heading", { name: label, exact: true })).toBeVisible();
    await expect(page.getByTestId(`plugin-state-${pluginId}`)).toHaveText(
      copy[`plugins.state.${expectedState}`]
    );
    await expect(
      page.getByRole("button", {
        name: label,
        pressed: expectedState === "active",
        exact: true,
      })
    ).toBeVisible();
  }
  await expectNoHorizontalPageOverflow(page);
}

async function expectKeyboardActionOrder(page: Page): Promise<void> {
  const actionOrder: string[] = [];
  for (let index = 0; index < 100 && actionOrder.length < PLUGIN_IDS.length; index += 1) {
    await page.keyboard.press("Tab");
    const focusedPlugin = await page.evaluate(
      () => document.activeElement?.closest<HTMLElement>("[data-plugin-id]")?.dataset.pluginId
    );
    if (focusedPlugin && actionOrder.at(-1) !== focusedPlugin) actionOrder.push(focusedPlugin);
  }
  expect(actionOrder).toEqual(PLUGIN_IDS);
}

async function maybePauseForHumanReview(page: Page): Promise<void> {
  await test.info().attach(`plugin-state-${test.info().attachments.length}`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  if (process.env.MP_VISUAL_REVIEW === "1") await page.pause();
}

test("prepares every visual-review fixture at narrow and wide viewports", async ({ page }) => {
  for (const viewport of VIEWPORTS) {
    await test.step(viewport.name, async () => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.context().clearCookies();

      await test.step("fresh installation and keyboard-only entry", async () => {
        seedFixture(server.dataDir, "fresh", "inactive");
        const copy = await provisionWithKeyboard(page, server.origin);
        await navigateFromHomeToPluginManagementWithKeyboard(page, copy);
        await expectCatalogOrderAndActions(page, copy, "inactive");
        await expectKeyboardActionOrder(page);
        await maybePauseForHumanReview(page);

        const weatherAction = page.getByRole("button", {
          name: copy[LABEL_KEYS.weather],
          pressed: false,
          exact: true,
        });
        await tabTo(page, weatherAction);
        const activation = page.waitForResponse(
          (response) =>
            response.url().endsWith("/api/plugins/weather/activate") &&
            response.request().method() === "POST"
        );
        await page.keyboard.press("Enter");
        expect((await activation).status()).toBe(200);
        await expect(page.getByTestId("plugin-state-weather")).toHaveText(
          copy["plugins.state.active"]
        );
        await expect
          .soft(
            page.getByRole("button", {
              name: copy[LABEL_KEYS.weather],
              pressed: true,
              exact: true,
            })
          )
          .toBeFocused({ timeout: 500 });
        // Checked after the focus assertion: looking at the section list means leaving this page.
        await expectAdminSectionListed(page, "admin-nav-weather", true, "admin-nav-plugins");
      });

      await test.step("supported prior baseline", async () => {
        seedFixture(server.dataDir, "prior_baseline", "active");
        await openAdminRoute(page, server.origin, "/admin/plugins");
        const settings = (await (
          await page.request.get(`${server.origin}/api/settings`)
        ).json()) as {
          locale?: { language?: string };
        };
        const copy = messages[resolveLang(settings.locale?.language)];
        await expectCatalogOrderAndActions(page, copy, "active");
        await maybePauseForHumanReview(page);
        await expectAdminSectionListed(page, "admin-nav-daily-briefing-management", true);
        await expectAdminSectionListed(page, "admin-nav-weather", true);
        await expectAdminSectionListed(page, "admin-nav-printing", true, "admin-nav-plugins");
      });

      await test.step("busy drain keeps canonical Active and unrelated actions usable", async () => {
        seedFixture(server.dataDir, "prior_baseline", "active", {
          "daily-briefing": {
            state: "active",
            operation: { targetState: "inactive", phase: "draining" },
          },
        });
        await openAdminRoute(page, server.origin, "/admin/plugins");
        const settings = (await (
          await page.request.get(`${server.origin}/api/settings`)
        ).json()) as {
          locale?: { language?: string };
        };
        const copy = messages[resolveLang(settings.locale?.language)];
        await expectCatalogOrderAndActions(page, copy, "active");

        const busyRow = page.getByTestId("plugin-row-daily-briefing");
        await expect(page.getByTestId("plugin-state-daily-briefing")).toHaveText(
          copy["plugins.state.active"]
        );
        const stopping = busyRow.getByText(copy["plugins.operation.deactivating"], { exact: true });
        await expect(stopping).toHaveAttribute("aria-live", "polite");
        const busyAction = busyRow.getByRole("button", {
          name: copy[LABEL_KEYS["daily-briefing"]],
          pressed: true,
          exact: true,
        });
        await expect(busyAction).toBeDisabled();
        await expect(busyAction).toHaveAttribute(
          "aria-describedby",
          "plugin-operation-daily-briefing"
        );
        await expect(page.getByTestId("plugin-health-indicator")).toHaveText(
          copy["plugins.health.activity"]
        );

        const printingAction = page.getByRole("button", {
          name: copy[LABEL_KEYS.printing],
          pressed: true,
          exact: true,
        });
        await expect(printingAction).toBeEnabled();
        await maybePauseForHumanReview(page);
        await tabTo(page, printingAction);
        const deactivation = page.waitForResponse(
          (response) =>
            response.url().endsWith("/api/plugins/printing/deactivate") &&
            response.request().method() === "POST"
        );
        await page.keyboard.press("Enter");
        expect((await deactivation).status()).toBe(200);
        await expect.soft(page.getByTestId("admin-affordance")).toHaveCount(0, { timeout: 500 });
        if (await page.getByTestId("admin-affordance").isVisible()) {
          await unlockCurrentAdminRouteWithKeyboard(page);
        }
        await expect(page.getByTestId("plugin-state-printing")).toHaveText(
          copy["plugins.state.inactive"]
        );
        await expect
          .soft(
            page.getByRole("button", {
              name: copy[LABEL_KEYS.printing],
              pressed: false,
              exact: true,
            })
          )
          .toBeFocused({ timeout: 500 });
        await expectNoHorizontalPageOverflow(page);
        await expectAdminSectionListed(page, "admin-nav-weather", true, "admin-nav-plugins");
      });

      await test.step("errored state exposes only safe text and focuses the affected row", async () => {
        seedFixture(server.dataDir, "prior_baseline", "active", {
          weather: { state: "errored", errorCode: "reconciliation_failed" },
        });
        await page.goto(server.origin);
        const settings = (await (
          await page.request.get(`${server.origin}/api/settings`)
        ).json()) as {
          locale?: { language?: string };
        };
        const copy = messages[resolveLang(settings.locale?.language)];
        const health = page.getByRole("button", {
          name: copy["plugins.health.attention"],
          exact: true,
        });
        await tabTo(page, health);
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(/\/admin\/plugins#plugin-weather$/);
        await unlockCurrentAdminRouteWithKeyboard(page);

        const weatherHeading = page.getByRole("heading", {
          name: copy[LABEL_KEYS.weather],
          exact: true,
        });
        await expect(weatherHeading).toBeFocused();
        await expect(page.getByTestId("plugin-state-weather")).toHaveText(
          copy["plugins.state.errored"]
        );
        const safeError = page
          .getByRole("alert")
          .filter({ hasText: copy[ERROR_KEYS.reconciliation_failed] });
        await expect(safeError).toHaveAttribute("aria-live", "polite");
        await expect(safeError).toHaveText(copy[ERROR_KEYS.reconciliation_failed]);
        const bodyText = await page.locator("body").innerText();
        expect(bodyText).not.toMatch(
          /(?:mpk-|mpg-|\/Users\/|https?:\/\/|sqlite|SELECT|INSERT|UPDATE)/i
        );
        await expect(page.getByTestId("admin-nav-members-management")).toBeVisible();
        await expectNoHorizontalPageOverflow(page);
        await maybePauseForHumanReview(page);
        await expectAdminSectionListed(page, "admin-nav-weather", false);
        await expectAdminSectionListed(
          page,
          "admin-nav-daily-briefing-management",
          true,
          "admin-nav-plugins"
        );
      });

      await test.step("inactive direct route returns to catalog without mounting the contribution", async () => {
        seedFixture(server.dataDir, "prior_baseline", "active", {
          backups: { state: "inactive" },
        });
        await openAdminRoute(page, server.origin, "/admin/backups");
        const settings = (await (
          await page.request.get(`${server.origin}/api/settings`)
        ).json()) as {
          locale?: { language?: string };
        };
        const copy = messages[resolveLang(settings.locale?.language)];
        await expect(
          page.getByRole("heading", { name: copy["plugins.unavailable.title"], exact: true })
        ).toBeVisible();
        await expect(page.getByTestId("backups-management")).toHaveCount(0);
        await expect(page.getByTestId("admin-nav-members-management")).toBeVisible();
        await expectNoHorizontalPageOverflow(page);
        await maybePauseForHumanReview(page);
        await expectAdminSectionListed(page, "admin-nav-backups", false);
        await expectAdminSectionListed(page, "admin-nav-printing", true, "back");
        await expect(
          page.getByRole("heading", { name: copy["plugins.unavailable.title"], exact: true })
        ).toBeVisible();

        const returnAction = page.getByRole("link", {
          name: copy["plugins.unavailable.return"],
          exact: true,
        });
        await tabTo(page, returnAction);
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(/\/admin\/plugins$/);
        await expect(page.getByTestId("plugin-catalog")).toBeVisible();
        await expect(page.getByTestId(/^plugin-row-/)).toHaveCount(9);
      });
    });
  }
});
