// admin-unlock.ts — the ONE shared admin unlock for e2e specs.
//
// This preamble was once inlined at 16 call sites across 15 spec files; keep it shared so the
// entry gesture and PIN flow change in one place. The Admin affordance opens the PIN gate on a
// plain tap (ADR-034), and the gate submits automatically once the PIN is complete.

import { expect, type Page } from "@playwright/test";

export const DEFAULT_ADMIN_PIN = process.env.MP_ADMIN_PIN ?? "1234";

/** Tap the Admin affordance (the Options button itself while Admin is its only entry,
 * otherwise the Admin item inside the Options menu) when entering from a family route.
 * Waits for the affordance itself first, so callers do not each repeat that expectation.
 */
export async function openAdminPinGate(page: Page): Promise<void> {
  const currentUrl = new URL(page.url());
  const isAdminPath = currentUrl.pathname === "/admin" || currentUrl.pathname.startsWith("/admin/");
  if (isAdminPath) return;

  const adminButton = page.getByTestId("admin-affordance");
  if (!(await adminButton.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: /options|opciones/i }).click();
  }
  await expect(adminButton).toBeVisible({ timeout: 15_000 });
  await adminButton.click();
  await expect(page).toHaveURL(
    (url) => url.origin === currentUrl.origin && url.pathname === "/admin"
  );
}

export async function unlockAdmin(page: Page, adminPin: string = DEFAULT_ADMIN_PIN): Promise<void> {
  await openAdminPinGate(page);

  await expect(page.getByTestId("admin-pin-keypad")).toBeVisible({ timeout: 15_000 });
  for (const digit of adminPin) {
    await page.getByTestId(`admin-pin-digit-${digit}`).click();
  }
  // The completed PIN submits itself; no Unlock press is needed.
  await expect(page.getByTestId("admin-pin-keypad")).toBeHidden({ timeout: 15_000 });
}
