import { test, expect, type Locator } from "@playwright/test";
import { messages, resolveLang } from "../../src/client/i18n/messages";

/** — chores board critical-flow e2e, reproducing
 * quickstart.md Scenarios A–E against the LIVE app.
 * Flow: gate → provision → API-seed a child + routine + chore + today's
 * assignment (RoutinesManagement has no data-testids yet, so configuration is
 * seeded via the device-cookie-authorized `page.request`, same technique
 * `calendar.spec.ts` uses for its recurring-event seed) → load `/chores` and
 * complete the chore via the real board tap target (`chore-toggle-*`, no PIN
 * gate, FR-019) → reload proves server-side persistence → soft-delete the
 * routine → tap the SAME (now-stale) toggle again and confirm the un-complete
 * ConfirmDialog (FR-008/DP2 — un-completing is the ONE direction this
 * dialog guards; completing above stayed a single, ungated tap): the uncomplete DELETE is
 * unconditional (FR-009/AC-01) and succeeds even though the routine is
 * inactive, and the chore then drops off the next refetch — proving the
 * asymmetry through the real client code path, not a raw API call → a SECOND,
 * still-active routine proves a non-today date is directly markable with no
 * admin-override route (FR-010) → streak/todayProgress are present (API AND
 * the RENDERED column) on today and null on any other date (FR-014) →
 * archiving this run's own child proves it (and only it) drops off the
 * board (FR-018) — scoped to avoid disturbing other specs' members under a
 * shared DATA_DIR; the zero-active-children empty-state guarantee
 * itself (FR-017/018) is covered in isolation at the boundary layer
 * (tests/boundary/routines-board.test.ts).
 * The board has no date-navigation UI at all (by design — "today-only view",
 * ChoresBoard.tsx) so the past-date scenario is driven directly against
 * `GET/POST /api/chores/board|completions`, exactly as quickstart Scenario B
 * describes ("mark/unmark there directly; no admin-override route exists").
 * The same lack of a non-today UI means the "streak/progress absent
 * elsewhere" side stays API-only — there's no other-date column to render.
 */

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";
const BOOTSTRAP_KEY = process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key";

/** Household-local YYYY-MM-DD (en-CA formats that way), mirroring ChoresBoard.tsx. */
function todayInTimezone(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
}

/** mon..sun — mirrors src/server/lib/household-date.ts's `weekdayOf` exactly (UTC-invariant). */
function weekdayCode(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const instant = new Date(Date.UTC(y, m - 1, d));
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" });
  return formatter.format(instant).substring(0, 3).toLowerCase();
}

/** `date` shifted by `delta` calendar days (UTC arithmetic — timezone-invariant). */
function addDays(date: string, delta: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate()
  ).padStart(2, "0")}`;
}

type BoardChoreLike = { id: string; completed: boolean };
type BoardColumnLike = {
  memberId: string;
  streak: number | null;
  todayProgress: { completed: number; total: number } | null;
  dayPeriods: Array<{ id: string; chores: BoardChoreLike[] }>;
};

async function selectPeriod(
  column: Locator,
  periodId: "morning" | "afternoon" | "evening" | "night",
  previousLabel: string,
  nextLabel: string
): Promise<void> {
  const periodOrder = ["morning", "afternoon", "evening", "night"] as const;
  const activePeriod = column.getByTestId("today-chores-active-period");

  for (let attempt = 0; attempt < periodOrder.length; attempt += 1) {
    const currentPeriodId = await activePeriod.getAttribute("data-period-id");
    if (currentPeriodId === periodId) return;

    const currentIndex = periodOrder.indexOf(currentPeriodId as (typeof periodOrder)[number]);
    const targetIndex = periodOrder.indexOf(periodId);
    const directionLabel = currentIndex > targetIndex ? previousLabel : nextLabel;
    await column.getByRole("button", { name: directionLabel, exact: true }).click();
  }

  await expect(activePeriod).toHaveAttribute("data-period-id", periodId);
}

test.describe.configure({ mode: "serial" });

test("chores board critical flow: configure → board → complete → streak (#331)", async ({
  page,
}) => {
  test.setTimeout(120_000);

  // Unique per-run suffix — the managed webServer persists a shared DATA_DIR
  // across runs/specs, so titles/members from earlier runs can linger.
  const rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  // 1) Access gate → provisioning (on /).
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

  // Locale-robust text assertions below key off the LIVE settings response,
  // never a hardcoded language (household default is en, ADR-015).
  const settingsResp = await page.request.get("/api/settings");
  expect(settingsResp.status()).toBe(200);
  const settings = await settingsResp.json();
  const tz = settings.locale.timezone as string;
  const m = messages[resolveLang(settings.locale?.language)];

  const todayStr = todayInTimezone(tz);
  const yesterdayStr = addDays(todayStr, -1);
  const todayCode = weekdayCode(todayStr);
  const yesterdayCode = weekdayCode(yesterdayStr);

  // 2) API-seed an active child member (the board renders one column per
  // active child; RoutinesManagement/MemberCreateForm parity aside, seeding
  // via the device-cookie-authorized request is the established pattern
  // for admin surfaces without data-testids, calendar.spec.ts:59-63).
  const memberResp = await page.request.post("/api/members", {
    data: { displayName: `Chore Kid ${rid}`, role: "child" },
  });
  expect(memberResp.status()).toBe(201);
  const memberId = (await memberResp.json()).id as string;

  // 3) Configure routine A + chore A + today's assignment (US1, quickstart A).
  const routineAResp = await page.request.post("/api/routines", {
    data: { name: `Morning Routine ${rid}`, dayPeriodId: "morning" },
  });
  expect(routineAResp.status()).toBe(201);
  const routineAId = (await routineAResp.json()).id as string;

  const choreAResp = await page.request.post(`/api/routines/${routineAId}/chores`, {
    data: { name: `Brush Teeth ${rid}` },
  });
  expect(choreAResp.status()).toBe(201);
  const choreAId = (await choreAResp.json()).id as string;

  const assignAResp = await page.request.put(
    `/api/routines/${routineAId}/assignments/${memberId}`,
    { data: { weekdays: [todayCode], active: true } }
  );
  expect(assignAResp.status()).toBe(200);

  // Every column payload always includes all four day periods, even ones with nothing
  // scheduled for that child (FR-017, DAY-PERIODS-AC-05).
  const seedBoardResp = await page.request.get(`/api/chores/board?date=${todayStr}`);
  expect(seedBoardResp.status()).toBe(200);
  const seedColumns = (await seedBoardResp.json()) as BoardColumnLike[];
  const seedColumn = seedColumns.find((c) => c.memberId === memberId);
  expect(seedColumn?.dayPeriods).toHaveLength(4);

  // 4) See it on the /chores board (US1) — load the SPA board surface.
  const boardFetch = page.waitForResponse(
    (r) => r.url().includes("/api/chores/board") && r.request().method() === "GET"
  );
  await page.goto("/chores");
  await expect(page.getByRole("heading", { name: m["chores.board.title"] })).toBeVisible();
  expect((await boardFetch).status()).toBe(200);
  await expect(page.getByText(m["chores.board.loading"])).toHaveCount(0, { timeout: 15_000 });

  const memberColumn = page.getByTestId(`chores-board-column-${memberId}`);
  await expect(memberColumn).toBeVisible({
    timeout: 10_000,
  });
  await selectPeriod(
    memberColumn,
    "morning",
    m["todayChores.previousPeriod"],
    m["todayChores.nextPeriod"]
  );
  const toggleA = page.getByTestId(`chore-toggle-${choreAId}`);
  await expect(toggleA).toBeVisible();
  await expect(toggleA).toHaveAttribute("aria-pressed", "false");

  // 5) Complete it via the real tap target (US2) — no admin unlock needed (FR-019).
  const completeResp = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/chores/${choreAId}/completions`) && r.request().method() === "POST"
  );
  await toggleA.click();
  expect((await completeResp).status()).toBe(204);
  await expect(toggleA).toHaveAttribute("aria-pressed", "true");

  // 6) Reload → still complete (server-side persistence, not optimistic-only state).
  const reloadedBoard = page.waitForResponse(
    (r) => r.url().includes("/api/chores/board") && r.request().method() === "GET"
  );
  await page.reload();
  expect((await reloadedBoard).status()).toBe(200);
  await expect(page.getByText(m["chores.board.loading"])).toHaveCount(0, { timeout: 15_000 });
  await selectPeriod(
    memberColumn,
    "morning",
    m["todayChores.previousPeriod"],
    m["todayChores.nextPeriod"]
  );
  await expect(page.getByTestId(`chore-toggle-${choreAId}`)).toHaveAttribute(
    "aria-pressed",
    "true",
    { timeout: 15_000 }
  );

  // 7) Soft-delete the routine (admin CRUD has no testids yet — API, same
  // seeding technique as step 3).
  const deleteRoutineResp = await page.request.delete(`/api/routines/${routineAId}`);
  expect(deleteRoutineResp.status()).toBe(204);

  // 8) Uncomplete still succeeds — the asymmetry (FR-009/AC-01). Tap the
  // SAME still-rendered (stale, pre-delete) toggle: its DELETE is
  // unconditional even though the routine is now inactive/unmarkable.
  // (FR-008/DP2): the un-complete direction is now gated behind a
  // ConfirmDialog — tapping an already-completed chore's toggle opens it rather than
  // firing the DELETE immediately (completing stays the original single, ungated tap).
  // Confirm it here so the underlying asymmetry this step exists to prove is unaffected.
  await page.getByTestId(`chore-toggle-${choreAId}`).click();
  const uncompleteResp = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/chores/${choreAId}/completions`) && r.request().method() === "DELETE"
  );
  await page.getByTestId("chores-uncomplete-confirm").click();
  expect((await uncompleteResp).status()).toBe(204);
  // No toggle error surfaced...
  await expect(page.getByText(m["chores.board.toggleError"])).toHaveCount(0);
  //...and the chore drops off the refetched board (its routine is inactive).
  await expect(page.getByTestId(`chore-toggle-${choreAId}`)).toHaveCount(0, { timeout: 10_000 });

  // 9) A SECOND, still-active routine — mark a PAST date directly. No
  // admin-override route exists for this (quickstart Scenario B / FR-010);
  // the board has no date-nav UI either, so this is driven via the API,
  // the same surface a kiosk left open across midnight would use.
  const routineBResp = await page.request.post("/api/routines", {
    data: { name: `Evening Routine ${rid}`, dayPeriodId: "evening" },
  });
  expect(routineBResp.status()).toBe(201);
  const routineBId = (await routineBResp.json()).id as string;

  const choreBResp = await page.request.post(`/api/routines/${routineBId}/chores`, {
    data: { name: `Pack Bag ${rid}` },
  });
  expect(choreBResp.status()).toBe(201);
  const choreBId = (await choreBResp.json()).id as string;

  const assignBResp = await page.request.put(
    `/api/routines/${routineBId}/assignments/${memberId}`,
    { data: { weekdays: [todayCode, yesterdayCode], active: true } }
  );
  expect(assignBResp.status()).toBe(200);

  const boardYesterdayBefore = await page.request.get(`/api/chores/board?date=${yesterdayStr}`);
  expect(boardYesterdayBefore.status()).toBe(200);
  const yesterdayColsBefore = (await boardYesterdayBefore.json()) as BoardColumnLike[];
  const yesterdayColBefore = yesterdayColsBefore.find((c) => c.memberId === memberId);
  const choreBYesterdayBefore = yesterdayColBefore?.dayPeriods
    .flatMap((dp) => dp.chores)
    .find((c) => c.id === choreBId);
  expect(choreBYesterdayBefore?.completed).toBe(false);
  // Streak/todayProgress are ABSENT (null) on any non-today date (FR-014).
  expect(yesterdayColBefore?.streak).toBeNull();
  expect(yesterdayColBefore?.todayProgress).toBeNull();

  const markPastResp = await page.request.post(`/api/chores/${choreBId}/completions`, {
    data: { memberId, date: yesterdayStr },
  });
  expect(markPastResp.status()).toBe(204);

  const boardYesterdayAfter = await page.request.get(`/api/chores/board?date=${yesterdayStr}`);
  const yesterdayColsAfter = (await boardYesterdayAfter.json()) as BoardColumnLike[];
  const choreBYesterdayAfter = yesterdayColsAfter
    .find((c) => c.memberId === memberId)
    ?.dayPeriods.flatMap((dp) => dp.chores)
    .find((c) => c.id === choreBId);
  expect(choreBYesterdayAfter?.completed).toBe(true);

  // 10) Streak/todayProgress are PRESENT (non-null) on today (FR-013/014).
  // Reload to sync the client with routine B + yesterday's completion,
  // then assert BOTH the API payload AND the actual RENDERED column —
  // an API-only check would miss a client-side regression that drops the
  // streak/progress badge from the board. The "absent on any other date"
  // side (already proven above for yesterday) has no UI equivalent to
  // check: the board has no date-navigation UI at all (by design,
  // "today-only view", ChoresBoard.tsx), so it necessarily stays API-only.
  await page.reload();
  // Read through the device-authenticated API context: a browser response from
  // the old document can lose its body when reload destroys it.
  const todayBoardRes = await page.request.get(`/api/chores/board?date=${todayStr}`);
  expect(todayBoardRes.status()).toBe(200);
  const todayCols = (await todayBoardRes.json()) as BoardColumnLike[];
  const todayCol = todayCols.find((c) => c.memberId === memberId);
  expect(todayCol?.streak).not.toBeNull();
  expect(typeof todayCol?.streak).toBe("number");
  expect(todayCol?.todayProgress).toEqual(
    expect.objectContaining({ completed: expect.any(Number), total: expect.any(Number) })
  );

  await expect(page.getByText(m["chores.board.loading"])).toHaveCount(0, { timeout: 15_000 });
  const todayColumn = page.getByTestId(`chores-board-column-${memberId}`);
  await expect(
    todayColumn.getByText(`${m["chores.board.streakLabel"]} ${todayCol!.streak}`)
  ).toBeVisible();
  await expect(
    todayColumn.getByText(
      `${m["chores.board.progressLabel"]} ${todayCol!.todayProgress!.completed}/${
        todayCol!.todayProgress!.total
      }`
    )
  ).toBeVisible();

  // 11) Archiving a child removes it (and only it) from the board (FR-018).
  // Scoped to ONLY the member this spec created: all specs share
  // one DATA_DIR, so archiving every active child (as this test used to)
  // hit OTHER specs' members too — truly concurrently under local
  // `fullyParallel` runs, or via cross-spec state pollution within a
  // single CI worker's sequential run — causing unrelated flakes/hangs.
  // The zero-active-children empty-board guarantee itself (FR-017/018,
  // quickstart Scenario E) is covered with an isolated DB at the
  // boundary layer — tests/boundary/routines-board.test.ts ("GET
  // /api/chores/board with zero active children → 200 empty array").
  const preArchiveBoardResp = await page.request.get(`/api/chores/board?date=${todayStr}`);
  expect(preArchiveBoardResp.status()).toBe(200);
  const preArchiveMemberIds = ((await preArchiveBoardResp.json()) as BoardColumnLike[]).map(
    (c) => c.memberId
  );
  expect(preArchiveMemberIds).toContain(memberId);

  const archiveResp = await page.request.post(`/api/members/${memberId}/archive`);
  expect(archiveResp.status()).toBe(200);

  const postArchiveBoardResp = await page.request.get(`/api/chores/board?date=${todayStr}`);
  expect(postArchiveBoardResp.status()).toBe(200);
  const postArchiveMemberIds = ((await postArchiveBoardResp.json()) as BoardColumnLike[]).map(
    (c) => c.memberId
  );
  expect(postArchiveMemberIds).not.toContain(memberId);

  const postArchiveBoardFetch = page.waitForResponse(
    (r) => r.url().includes("/api/chores/board") && r.request().method() === "GET"
  );
  await page.reload();
  expect((await postArchiveBoardFetch).status()).toBe(200);
  await expect(page.getByText(m["chores.board.loading"])).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText(m["chores.board.error"])).toHaveCount(0);
  await expect(page.getByTestId(`chores-board-column-${memberId}`)).toHaveCount(0);
});

/** (independent): a long, realistic chore name routed through
 * `StatusToggle` -> `Button` (whose base class forces `whitespace-nowrap` + a fixed
 * `h-[var(--control-height)]`, see `components/ui/button.tsx`) never wraps — it paints past its
 * own box into the neighbouring column, and once enough columns fill a row, that overflow
 * reaches past the LAST column and grows `document.body.scrollWidth` beyond `clientWidth`: a
 * real page-level horizontal scrollbar on a kiosk surface. The frozen density helper
 * (`tests/client/helpers/density.ts`) measures height and font-size only — it has no concept of
 * overflow, so this shipped green through every jsdom spec. This is the "make something able to
 * fail" this surface needs: a real-browser assertion that the board never scrolls horizontally
 * with a realistic long name, at BOTH densities (comfortable — the default, no `data-density`
 * attribute — and kiosk).
 * Reproduction recipe: the overflowing name must land in
 * the LAST column of a FULLY-populated row — an interior column's overflow only bleeds into a
 * neighbour's empty space without pushing the page's own scrollWidth past its clientWidth, and a
 * column alone in a partially-filled row grows (flex-grow) to absorb the overflow instead of
 * exposing it. Six active children (five fill the first 1280px-viewport row exactly, one wraps
 * to a second row alone) with the long name on the FIFTH (rightmost, first-row) child reproduces
 * it deterministically.
 */
test("a long chore name wraps instead of scrolling the page horizontally, at both densities (HIGH-1, #779 independent review)", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 800 });

  const rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const LONG_NAME = `Poner la mesa y recoger los platos del lavavajillas ${rid}`;

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

  const settingsResp = await page.request.get("/api/settings");
  const settings = await settingsResp.json();
  const tz = settings.locale.timezone as string;
  const m = messages[resolveLang(settings.locale?.language)];
  const todayStr = todayInTimezone(tz);
  const todayCode = weekdayCode(todayStr);

  const memberIds: string[] = [];
  for (let i = 0; i < 6; i++) {
    const memberResp = await page.request.post("/api/members", {
      data: { displayName: `Overflow Kid ${rid}-${i}`, role: "child" },
    });
    expect(memberResp.status()).toBe(201);
    memberIds.push((await memberResp.json()).id as string);
  }

  // The long chore lands on the FIFTH member (index 4) — the rightmost column in a full first
  // row at 1280px — the one placement that turns paint-only overflow into a real page scrollbar
  // (see the reproduction-recipe comment above).
  const overflowMemberId = memberIds[4];
  const routineResp = await page.request.post("/api/routines", {
    data: { name: `Overflow Routine ${rid}`, dayPeriodId: "morning" },
  });
  expect(routineResp.status()).toBe(201);
  const routineId = (await routineResp.json()).id as string;

  const choreResp = await page.request.post(`/api/routines/${routineId}/chores`, {
    data: { name: LONG_NAME },
  });
  expect(choreResp.status()).toBe(201);
  const choreId = (await choreResp.json()).id as string;

  const assignResp = await page.request.put(
    `/api/routines/${routineId}/assignments/${overflowMemberId}`,
    { data: { weekdays: [todayCode], active: true } }
  );
  expect(assignResp.status()).toBe(200);

  await page.goto("/chores");
  const overflowMemberColumn = page.getByTestId(`chores-board-column-${overflowMemberId}`);
  await expect(overflowMemberColumn).toBeVisible({
    timeout: 10_000,
  });
  await selectPeriod(
    overflowMemberColumn,
    "morning",
    m["todayChores.previousPeriod"],
    m["todayChores.nextPeriod"]
  );
  await expect(page.getByTestId(`chore-toggle-${choreId}`)).toBeVisible();

  // Assert containment PER CONTROL, in BOTH axes — not `document.body.scrollWidth`.
  //
  // The page-level width check was the first shape of this test and it is too weak in two ways the
  // independent review proved by mutation:
  //
  // 1. It is HORIZONTAL ONLY. Dropping `h-auto` while keeping `whitespace-normal` reinstates the
  // primitive's fixed height, the text wraps to a second line that renders OUTSIDE the button
  // box, and it overlaps the next chore's control — a genuinely broken board. Measured:
  // width overflow 0, HEIGHT overflow 97. jsdom green, check:standard green, and the
  // page-level assertion green too.
  // 2. It depended on a COLUMN-COUNT ACCIDENT. It only fired when the long name landed in the
  // rightmost column of a full row, so seeding one, two or three extra children into the
  // shared e2e DATA_DIR made the bug pass. The board renders every active child, the suite is
  // `fullyParallel` with one shared DATA_DIR, and other specs create children into it.
  //
  // Per-control containment kills all three mutants (drop the override, drop `whitespace-normal`,
  // drop `h-auto`), needs no placement recipe, and is MONOTONE in column count: more children make
  // cards narrower, so pollution STRENGTHENS the assertion instead of nullifying it.
  //
  // This is the shape the remaining batches should copy for — every surface putting
  // user-authored text into a `Button` has the same failure mode.
  const measureToggles = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid^="chore-toggle-"]')).map((el) => ({
        id: el.getAttribute("data-testid") ?? "",
        wOver: el.scrollWidth - el.clientWidth,
        hOver: el.scrollHeight - el.clientHeight,
      }))
    );

  // Comfortable density (the default — no `data-density` attribute at all).
  const comfortable = await measureToggles();
  expect(comfortable.length, "expected at least one chore toggle to measure").toBeGreaterThan(0);
  for (const t of comfortable) {
    expect(
      t.wOver,
      `comfortable: ${t.id} overflows horizontally by ${t.wOver}px`
    ).toBeLessThanOrEqual(0);
    expect(
      t.hOver,
      `comfortable: ${t.id} overflows vertically by ${t.hOver}px`
    ).toBeLessThanOrEqual(0);
  }

  // Kiosk density — larger control height/text; the wrapping guarantee must still hold. No
  // reload needed: the density tokens are consumed live via CSS custom properties on the root.
  await page.evaluate(() => document.documentElement.setAttribute("data-density", "kiosk"));
  const kiosk = await measureToggles();
  for (const t of kiosk) {
    expect(t.wOver, `kiosk: ${t.id} overflows horizontally by ${t.wOver}px`).toBeLessThanOrEqual(0);
    expect(t.hOver, `kiosk: ${t.id} overflows vertically by ${t.hOver}px`).toBeLessThanOrEqual(0);
  }

  // Cleanup — archive every member this test created (shared DATA_DIR across specs).
  for (const id of memberIds) {
    await page.request.post(`/api/members/${id}/archive`);
  }
});
