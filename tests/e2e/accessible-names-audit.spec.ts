import { test, expect, type Page } from "@playwright/test";
import { openAdminSection } from "./admin-nav";
import { unlockAdmin } from "./admin-unlock";

/** accessible-names-audit.spec.ts — runtime companion to `tools/dev/audit-accessible-names.mjs`
 * (follow-up).
 * WHY BOTH a static script AND an e2e spec exist for the same guarantee (SC-012's "reachable AND
 * OPERABLE" criterion): they cover different failure classes, and neither subsumes the other.
 * - The STATIC audit (`tools/dev/audit-accessible-names.mjs`) sees every file in one run,
 * including surfaces this spec never visits, and it is fast enough to run on every commit. It
 * CANNOT see anything that only exists at runtime: real DOM layout, the browser's actual
 * accessible-name computation (translation catalogue resolution, CSS-driven visibility), or
 * focus order.
 * - This E2E spec computes the accessible name the SAME way a real screen reader would — via
 * Playwright's `ariaSnapshotJSON`, which reads the browser engine's own accessibility tree —
 * so it catches anything the static heuristic gets conservatively wrong (an `aria-label={t(key)}`
 * that resolves to an empty string, a control hidden by CSS, etc.). It CANNOT see every file:
 * it only walks the surfaces this spec actually navigates to, and it is far slower to run.
 * Reuses the existing kiosk-provision + PIN-unlock harness from `tests/e2e/day-periods.spec.ts` —
 * no new setup. The independent review on measured this exact prelude + a targeted
 * assertion at ~193ms `vite build` + ~8s test run + ~2 minutes to author; nothing here required
 * standing up new infrastructure.
 * KNOWN-VIOLATION TESTS ASSERT THE EXACT SET, NOT `test.fail` (re-finding).
 * Historically two "known, not yet fixed" specs asserted the CURRENT, real violation array as
 * ordinary passing tests rather than using `test.fail` to assert the eventual `[]`; both offenders
 * are now fixed, so those specs assert the empty set — the rationale below still
 * governs any FUTURE known-violation test. `test.fail`'s * "an unexpected pass forces removal of the annotation" property is real, but it has a proven
 * false-green channel: it also passes when the assertion fails for ANY reason, including the
 * harness itself breaking before the real assertion runs (proven: pointing `reachAdmin` at a wrong
 * PIN produced `1 failed, 2 passed` — both `test.fail` specs went green while asserting nothing).
 * Asserting the exact known set closes that gap: green means "exactly these known offenders, no
 * new ones, harness reached the screen and computed real ARIA data"; it fails on the fix (the set
 * changes), on a regression elsewhere on the same screen (the set changes shape, not just size),
 * and on harness breakage (an empty or different set, or the test erroring outright) — each a
 * distinct, diagnosable failure instead of one indistinguishable green.
 */

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";
const BOOTSTRAP_KEY = process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key";
const ADMIN_PIN = process.env.ADMIN_PIN ?? "1234";

// Interactive ARIA roles that MUST carry a non-empty accessible name to be operable by
// assistive tech. Mirrors `INTERACTIVE_ROLES` in tools/dev/audit-accessible-names.mjs, plus the
// native roles Chromium itself assigns to <input>/<select> (textbox/combobox/spinbutton/etc.) —
// the static script matches on JSX shape, this one matches on the BROWSER'S OWN role computation.
const NAMEABLE_ROLES = new Set([
  "textbox",
  "searchbox",
  "spinbutton",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "button",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "tab",
]);

interface AriaNode {
  role?: string;
  name?: string;
  children?: AriaNode[];
}

interface Violation {
  role: string;
  ancestry: string;
}

// `ariaSnapshotJSON`'s ROOT return value is a bare ARRAY of sibling nodes (verified by dumping
// the real tree against the DayPeriods edit-mode screen), not a single object with a `children`
// property — an object-shaped root was tried first and silently walked nothing (`tree.children`
// on an array is `undefined`), which is exactly the false-green failure class this whole census
// exists to eliminate. `walk` therefore accepts either an array (root call) or a single node
// (every recursive call).
function walk(node: AriaNode | AriaNode[] | undefined, ancestry: string[], out: Violation[]): void {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, ancestry, out);
    return;
  }
  const role = node.role;
  const name = (node.name ?? "").trim();
  if (role && NAMEABLE_ROLES.has(role) && name.length === 0) {
    out.push({ role, ancestry: ancestry.join(" > ") || "(root)" });
  }
  const label = role ? `${role}${name ? ` "${name}"` : ""}` : "(text)";
  for (const child of node.children ?? []) {
    walk(child, ancestry.concat(label), out);
  }
}

async function reachAdmin(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("access-gate-form")).toBeVisible();
  await page.getByTestId("access-gate-form").locator('input[name="token"]').fill(ACCESS_TOKEN);
  await page.getByRole("button", { name: "Enter" }).click();
  await expect(page.getByRole("button", { name: "Provision Device" })).toBeVisible({
    timeout: 15000,
  });

  await page.getByLabel("Bootstrap key").fill(BOOTSTRAP_KEY);
  await page.getByRole("button", { name: "Provision Device" }).click();
  await expect(page.getByTestId("home-surface")).toBeVisible({ timeout: 15_000 });

  await unlockAdmin(page, ADMIN_PIN);

  await expect(page.getByTestId("admin-overview")).toBeVisible({ timeout: 10_000 });
}

// FIXED by (token-dialect migration of MembersManagement.tsx/
// MemberCreateForm.tsx): the birthdate month/day `SelectTrigger`s now carry an explicit
// `aria-label` (`t("members.birthdate.selectMonth")` / `t("members.birthdate.selectDay")`), so the
// real Chromium accessibility tree computes a non-empty name for both — the two known offenders
// this test used to assert (`MemberCreateForm.tsx:188`/`:205`) are gone. Converted from the
// exact-known-violation-set shape (re-finding) to the same `toEqual([])` shape
// `Day Periods list (default view)` already uses below, now that there is nothing left to pin.
test("runtime accessible-name audit: default admin screen (member create) has no unnamed control", async ({
  page,
}) => {
  await reachAdmin(page);

  const tree = (await page.locator("body").ariaSnapshotJSON()) as AriaNode[];
  const violations: Violation[] = [];
  walk(tree, [], violations);

  expect(violations, `Unnamed controls found:\n${JSON.stringify(violations, null, 2)}`).toEqual([]);
});

test("runtime accessible-name audit: Day Periods list (default view) has no unnamed control", async ({
  page,
}) => {
  await reachAdmin(page);
  await openAdminSection(page, "admin-nav-settings");
  await expect(page.getByTestId(/^day-period-/)).toHaveCount(4, { timeout: 10_000 });

  const tree = (await page.locator("body").ariaSnapshotJSON()) as AriaNode[];
  const violations: Violation[] = [];
  walk(tree, [], violations);

  expect(violations, `Unnamed controls found:\n${JSON.stringify(violations, null, 2)}`).toEqual([]);
});

// FIXED by — the start-time editor (formerly DayPeriodsManagement.tsx:256, quickstart.md
// S9) now carries a real Field label, so this asserts the empty set.
//
// re-finding — same conversion as the member-create test above, same reason:
// `test.fail` has a proven false-green channel (a broken `reachAdmin` prelude — e.g. a wrong PIN —
// produced `1 failed, 2 passed` with BOTH `test.fail` specs going green while asserting nothing).
// FIXED by (token-dialect migration of DayPeriodsManagement.tsx): the start-time
// editor now renders inside the shared `Field` L2 component, which associates a visible label
// ("Start time" / "Hora de inicio") via `<label for>` — the real Chromium accessibility tree
// computes a non-empty name for it, so the previously-known single violation is gone. Converted
// from the exact-known-violation-set shape to the same `toEqual([])` shape the member-create test
// above already uses, now that there is nothing left to pin.
test("runtime accessible-name audit: Day Periods (always editable) has no unnamed control", async ({
  page,
}) => {
  await reachAdmin(page);
  await openAdminSection(page, "admin-nav-settings");
  await expect(page.getByTestId(/^day-period-/)).toHaveCount(4, { timeout: 10_000 });

  // An unsaved draft, so the enabled Save state is audited too.
  const afternoonInput = page.getByTestId("day-periods-start-input-afternoon");
  await expect(afternoonInput).toBeVisible({ timeout: 5000 });
  await afternoonInput.fill("11:31");
  await expect(page.getByTestId("day-periods-save-afternoon")).toBeEnabled();

  const tree = (await page.locator("body").ariaSnapshotJSON()) as AriaNode[];
  const violations: Violation[] = [];
  walk(tree, [], violations);

  expect(violations, `Unnamed controls found:\n${JSON.stringify(violations, null, 2)}`).toEqual([]);
});
