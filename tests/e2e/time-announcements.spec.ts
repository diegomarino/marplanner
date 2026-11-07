import { expect, test, type Page } from "@playwright/test";
import { RULES_CHANGED_EVENT } from "../../src/client/time-announcements/events";
import { openAdminPinGate, unlockAdmin } from "./admin-unlock";

/** — Time Announcements audio-free e2e (quickstart §3).
 * Not part of CI acceptance. Run locally with `npm run test:e2e:time-announcements`.
 * On a pull request, add the `e2e-time-announcements` label or dispatch
 * `Time announcements browser check` for that branch.
 * Shared `webServer` (no own-server need) — `VITE_E2E_HOOKS=true` is already set in that
 * webServer's `env` (playwright.config.ts, 013), so `window.__mpAnnouncements` (the
 * seams.ts sink) exists in this real, built-and-started process.
 * Rules are seeded via `page.request.post` (raw HTTP, same precedent as
 * `admin-household-timezone-defaults.spec.ts`'s member/reminder seeding) rather than
 * through the admin panel UI — but the client's headless `AnnouncementService` only
 * refetches rules on mount, a slow 5-minute interval, or the `RULES_CHANGED_EVENT` window
 * event the admin panel dispatches after a save (`src/client/time-announcements/events.ts`
 * — the single source of truth for the literal, imported here rather than duplicated,
 * 2026-09-04). Seeding via raw HTTP bypasses that dispatch, so each seed is
 * followed by manually firing the SAME event via `page.evaluate` — the exact equivalent of
 * what the admin panel's own save path would have triggered.
 * `test.use({ timezoneId })` forces the BROWSER timezone to Pacific/Pago_Pago (UTC-11),
 * as far from the household's default Europe/Madrid as practical — a correct fire proves
 * household-timezone resolution (FR-008), never the browser's own.
 * The e2e clock is REAL (no `page.clock`) — seeding ahead means this spec genuinely waits;
 * `test.setTimeout` is raised accordingly and every wait is a generous `expect.poll`, never
 * a duration assertion (repo "no wall-clock-dependent assertions" convention). Seed times are
 * derived from the NEXT minute boundary at least 45s out (2026-09-04) rather than
 * a flat "N seconds from now", which floored as low as ~11s of real arming headroom whenever
 * the test happened to start late in a minute.
 * (Traces: TIME-ANNOUNCEMENTS-AC-03, TIME-ANNOUNCEMENTS-AC-04,
 * KIOSK-SHELL-NAVIGATION-AC-07 — announcements half; FR-007, FR-008, FR-009, FR-015)
 */

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";
const BOOTSTRAP_KEY = process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key";
const MP_ADMIN_PIN = process.env.MP_ADMIN_PIN ?? "1234";

/** The household's default timezone (see admin-household-timezone-defaults.spec.ts). */
const HOUSEHOLD_TZ = "Europe/Madrid";

/** Minimum real-time headroom (ms) between "now" and a seeded rule's target instant. */
const ARM_HEADROOM_MS = 45_000;

// The kiosk/browser is signed as far from Madrid as practical (American Samoa, UTC-11).
test.use({ timezoneId: "Pacific/Pago_Pago" });

async function provision(page: Page): Promise<void> {
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
}

/** One user gesture anywhere in the shell primes speech (D6/FR-014). Use the product's
 * same-document Options-to-Admin transition so the family route does not assume AdminGate mounts
 * outside the protected subtree.
 */
async function primeSpeech(page: Page): Promise<void> {
  await openAdminPinGate(page);
}

/** HH:MM (strict 24h) + canonical weekday code, as `instant` reads in `tz`. */
function partsInTz(instant: Date, tz: string): { time: string; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    time: `${get("hour")}:${get("minute")}`,
    weekday: get("weekday").toLowerCase().slice(0, 3),
  };
}

/** The next whole-minute boundary that is still at least `ARM_HEADROOM_MS` past `nowMs`
 * (2026-09-04). A flat "N seconds from now" can land anywhere inside the
 * CURRENT minute — starting the test at second:49 with a flat 60s-ahead target left as
 * little as ~11s of real arming headroom once request/dispatch latency is subtracted. Since
 * the result is always a minute boundary, real headroom here is always in
 * `[ARM_HEADROOM_MS, ARM_HEADROOM_MS + 59_999]`.
 */
function nextArmableMinute(nowMs: number): number {
  return Math.ceil((nowMs + ARM_HEADROOM_MS) / 60_000) * 60_000;
}

/** Rule ids seeded by the CURRENTLY RUNNING test — deleted in `test.afterEach` below. */
let seededRuleIds: string[] = [];

/** Seed one rule via raw HTTP, then notify the already-mounted service (see docblock). */
async function seedRule(
  page: Page,
  ahead: { time: string; weekday: string },
  ...notify: Page[]
): Promise<{ id: string }> {
  const response = await page.request.post("/api/time-announcements", {
    data: { time: ahead.time, weekDays: [ahead.weekday], isActive: true },
  });
  expect(response.status()).toBe(201);
  const rule = (await response.json()) as { id: string };
  seededRuleIds.push(rule.id);
  for (const target of notify.length > 0 ? notify : [page]) {
    await target.evaluate(
      (eventName) => window.dispatchEvent(new CustomEvent(eventName)),
      RULES_CHANGED_EVENT
    );
  }
  return rule;
}

interface MirrorEntry {
  ruleId: string;
  phrase: string;
  lang: string;
  at: number;
}

async function mirrorEntries(page: Page): Promise<MirrorEntry[]> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __mpAnnouncements?: { entries: MirrorEntry[] } })
      .__mpAnnouncements;
    return hook?.entries ?? [];
  });
}

test.describe("time-announcements audio-free e2e", () => {
  // Serial (not parallel workers): both tests seed rules against the SAME shared webServer's
  // live database (this suite has no own-server, per the task). Two workers computing
  // "N seconds from now" concurrently can land on the identical household HH:MM + weekday and
  // trip the server's real active-overlap 409 (INV-04) against each other's rows — a test
  // ordering artifact, not a product bug. Serial execution guarantees the second test's seed
  // time is real minutes away from the first test's, which never collides in practice.
  test.describe.configure({ mode: "serial" });

  // (2026-09-04): delete every rule THIS test seeded, so a CI retry within the
  // same minute can't re-trip the active-overlap 409 against a leftover row. This also preserves
  // isolation when a caller intentionally supplies a persistent E2E_DATA_DIR. Runs against the
  // CURRENT test's own `page` fixture, which still carries that test's provisioned device-key
  // cookie.
  test.afterEach(async ({ page }) => {
    const ids = seededRuleIds.splice(0, seededRuleIds.length);
    for (const id of ids) {
      await page.request.delete(`/api/time-announcements/${id}`).catch(() => {
        // best-effort teardown only — never fail the test run over cleanup
      });
    }
  });

  test("fires at the seeded household-local minute, keeps firing on an admin route, mirrors {ruleId,phrase,lang}", async ({
    page,
  }) => {
    test.setTimeout(300_000);

    await provision(page);
    await primeSpeech(page);

    const base = nextArmableMinute(Date.now());
    const first = partsInTz(new Date(base), HOUSEHOLD_TZ);
    const second = partsInTz(new Date(base + 120_000), HOUSEHOLD_TZ);

    const firstRule = await seedRule(page, first);
    const secondRule = await seedRule(page, second);

    // Await the FIRST fire. The e2e clock is real — this genuinely waits; never assert a
    // duration, only the eventual mirrored entry.
    await expect
      .poll(async () => (await mirrorEntries(page)).some((e) => e.ruleId === firstRule.id), {
        timeout: 150_000,
        intervals: [2_000],
      })
      .toBe(true);

    const afterFirst = await mirrorEntries(page);
    const firstEntry = afterFirst.find((e) => e.ruleId === firstRule.id)!;
    expect(firstEntry.phrase.length).toBeGreaterThan(0);
    expect(["en", "es"]).toContain(firstEntry.lang);

    // Navigate to an admin route BEFORE the second seeded fire — the headless service is
    // shell-mounted at the US0 hoist, present on every route, so it must keep
    // firing there too (KIOSK-SHELL-NAVIGATION-AC-07 — announcements half).
    await unlockAdmin(page, MP_ADMIN_PIN);
    await expect(page.getByTestId("admin-overview")).toBeVisible({ timeout: 10_000 });

    await expect
      .poll(async () => (await mirrorEntries(page)).some((e) => e.ruleId === secondRule.id), {
        timeout: 180_000,
        intervals: [2_000],
      })
      .toBe(true);

    // Still on the admin route — the fire neither navigated away nor crashed the surface.
    await expect(page.getByTestId("admin-overview")).toBeVisible();

    const afterSecond = await mirrorEntries(page);
    const secondEntry = afterSecond.find((e) => e.ruleId === secondRule.id)!;
    expect(secondEntry.phrase.length).toBeGreaterThan(0);
    expect(["en", "es"]).toContain(secondEntry.lang);
  });

  test("two tabs of the same browser: exactly ONE mirrors the announcement (leader election, AC-04)", async ({
    context,
    page,
  }) => {
    test.setTimeout(240_000);

    await provision(page);
    await primeSpeech(page);

    const page2 = await context.newPage();
    await page2.goto("/");
    await expect(page2.getByTestId("home-surface")).toBeVisible({ timeout: 15_000 });
    await primeSpeech(page2);

    const base = nextArmableMinute(Date.now());
    const target = partsInTz(new Date(base), HOUSEHOLD_TZ);
    const rule = await seedRule(page, target, page, page2);

    // Web Locks (Chromium) partition per storage origin — two Pages sharing one
    // BrowserContext share the SAME lock manager, so exactly one of the two services
    // should be elected leader and record the mirror; the other stays silent.
    async function mirroredCount(): Promise<number> {
      const [entries1, entries2] = await Promise.all([mirrorEntries(page), mirrorEntries(page2)]);
      const count1 = entries1.filter((e) => e.ruleId === rule.id).length;
      const count2 = entries2.filter((e) => e.ruleId === rule.id).length;
      return count1 + count2;
    }

    // (2026-09-04): `expect.poll` resolves on the FIRST sample satisfying
    // `.toBe(1)` — a broken election where BOTH tabs mirror ~100ms apart could be sampled
    // exactly when only one of the two writes has landed, passing on a race. Assert
    // `<= 1` on every sample (so a second mirror arriving between polls fails immediately,
    // not just gets missed), THEN settle past the announce window and re-check the final
    // count is still exactly 1 — proving no second mirror ever lands, not merely that one
    // hadn't yet at some sampled instant.
    await expect
      .poll(
        async () => {
          const count = await mirroredCount();
          expect(count).toBeLessThanOrEqual(1);
          return count;
        },
        { timeout: 150_000, intervals: [2_000] }
      )
      .toBe(1);
    await page.waitForTimeout(5_000); // settle past the announce window
    expect(await mirroredCount()).toBe(1);

    await page2.close();
  });
});
