// admin-unlock.ts — the ONE shared admin long-press unlock for e2e specs.
//
// WHY THIS FILE EXISTS: this preamble was inlined at 16 call sites across 15 spec files, and two of
// them had grown their OWN local `unlockAdmin`, each citing the other as "the shared e2e pattern".
// A layout shift during the three-second hold can move the unlock element away from a stationary
// pointer. Pointer capture keeps the press active across that movement. A retry loop would hide
// a cancelled hold and inflate unlock time, so this helper makes only one attempt.
// `admin-unlock-resilience.spec.ts` exercises the layout-shift case directly.
//
// The three-second hold owns deliberate accidental-touch friction. The timeout below adds room
// for render and scheduler drift without hiding a cancelled-hold regression behind a retry.

import { expect, type Page } from "@playwright/test";

/** Must match `HouseholdChrome.tsx`'s `ADMIN_HOLD_MS`. */
const HOLD_MS = 3_000;

/** The hold plus generous room for render and Playwright's visibility check. */
const UNLOCK_TIMEOUT_MS = HOLD_MS + 2_500;

export const DEFAULT_ADMIN_PIN = process.env.ADMIN_PIN ?? "1234";

/** Long-press the Admin affordance (the Options button itself while Admin is its only entry,
 * otherwise the Admin item inside the Options menu) when entering from a family route,
 * then use the touch keypad shown directly on the protected route.
 * Waits for the affordance itself first, so callers do not each repeat that expectation.
 * With pointer capture in place, a cancelled press is a real regression and must fail loudly,
 * not be absorbed by a retry.
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
  await adminButton.hover();
  await page.mouse.down();
  try {
    await expect(page).toHaveURL(
      (url) => url.origin === currentUrl.origin && url.pathname === "/admin",
      { timeout: UNLOCK_TIMEOUT_MS }
    );
  } finally {
    await page.mouse.up();
  }
}

export async function unlockAdmin(page: Page, adminPin: string = DEFAULT_ADMIN_PIN): Promise<void> {
  await openAdminPinGate(page);

  await expect(page.getByTestId("admin-pin-keypad")).toBeVisible({ timeout: 15_000 });
  for (const digit of adminPin) {
    await page.getByTestId(`admin-pin-digit-${digit}`).click();
  }
  await page.getByTestId("admin-pin-unlock").click();
}
