import { expect, type Page } from "@playwright/test";

/** Admin pages are reached from the sidebar. These helpers keep that detail out of the specs. */

/** Shows the admin overview. */
export async function showAdminOverview(page: Page): Promise<void> {
  if (await page.getByTestId("admin-overview").isVisible()) return;
  await page.getByTestId("admin-sidebar").getByRole("link").first().click();
  await expect(page.getByTestId("admin-overview")).toBeVisible();
}

/** Opens an admin section by its `admin-nav-*` id, from wherever in admin the page is. */
export async function openAdminSection(page: Page, testId: string): Promise<void> {
  const entry = page.getByTestId(testId);
  if (!(await entry.isVisible())) await showAdminOverview(page);
  await entry.click();
}

/** Returns to the household screens: the admin bar has a home icon, not the household nav. */
export async function leaveAdmin(page: Page): Promise<void> {
  const home = page.getByTestId("admin-topbar-home");
  if (await home.isVisible()) await home.click();
  await expect(page.getByTestId("household-nav")).toBeVisible();
}

/** Creates a member through the Members page's form and waits for their card. */
export async function createMember(
  page: Page,
  displayName: string,
  options: { roleOption?: string | RegExp } = {}
): Promise<void> {
  await openAdminSection(page, "admin-nav-members-management");
  await page.getByTestId("members-add-member").click();
  const form = page.getByTestId("member-form-dialog");
  await form.locator("#member-edit-display-name").fill(displayName);
  await form.locator("#member-edit-role").click();
  if (options.roleOption) await page.getByRole("option", { name: options.roleOption }).click();
  else await page.getByRole("option").first().click();
  await form.getByTestId("member-save").click();
  await expect(form).toBeHidden();
  await expect(page.getByTestId("members-card-grid")).toContainText(displayName);
}

/** Sections that are part of another page: where they are shown, and the panel to look for. */
const EMBEDDED_SECTIONS: Record<string, { host: string; panel: string }> = {
  "admin-nav-weather": { host: "admin-nav-settings", panel: "weather-management" },
};

/** Checks whether a section is offered in admin (a sidebar entry, or a panel on the page that
 * hosts it), then goes back to `returnTo` (a section id, or "back" for the previous page) so the
 * spec carries on where it was.
 */
export async function expectAdminSectionListed(
  page: Page,
  testId: string,
  listed: boolean,
  returnTo?: string
): Promise<void> {
  const embedded = EMBEDDED_SECTIONS[testId];
  if (embedded) {
    await openAdminSection(page, embedded.host);
    await expect(page.getByTestId("settings-management")).toBeVisible();
    // The host page loads its own values first; the hosted panel follows.
    await expect(page.getByTestId("settings-save")).toBeVisible();
    await expect(page.getByTestId(embedded.panel)).toHaveCount(listed ? 1 : 0);
  } else {
    await showAdminOverview(page);
    await expect(page.getByTestId(testId)).toHaveCount(listed ? 1 : 0);
  }
  if (returnTo === "back") await page.goBack();
  else if (returnTo) await openAdminSection(page, returnTo);
}
