import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { messages, resolveLang } from "../../src/client/i18n/messages";

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";
const BOOTSTRAP_KEY = process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key";

function todayInTimezone(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
}

function addDays(date: string, delta: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + delta));
  return `${result.getUTCFullYear()}-${String(result.getUTCMonth() + 1).padStart(2, "0")}-${String(
    result.getUTCDate()
  ).padStart(2, "0")}`;
}

function weekdayCode(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" })
    .format(new Date(Date.UTC(year, month - 1, day)))
    .slice(0, 3)
    .toLowerCase();
}

type CreatedResources = {
  members: string[];
  routines: string[];
  events: string[];
  meals: string[];
};

function emptyCreatedResources(): CreatedResources {
  return { members: [], routines: [], events: [], meals: [] };
}

let created = emptyCreatedResources();

test.beforeEach(() => {
  created = emptyCreatedResources();
});

test.afterEach(async ({ page }) => {
  // Playwright runs afterEach with its own teardown timeout, including after a timed-out test
  // body. Detach this test's state first so a retry never inherits stale resource IDs.
  const resources = created;
  created = emptyCreatedResources();

  // Teardown is bounded to this run's IDs: no shared names, broad deletes, or fixture reset.
  // Run every operation before asserting so one failed cleanup cannot skip the remaining IDs.
  const cleanupOperations = [
    ...resources.events.map((eventId) => ({
      label: `calendar event ${eventId}`,
      expectedStatus: 204,
      run: () => page.request.delete(`/api/calendar/events/${eventId}`),
    })),
    ...resources.meals.map((mealId) => ({
      label: `meal entry ${mealId}`,
      expectedStatus: 204,
      run: () => page.request.delete(`/api/meal-entries/${mealId}`),
    })),
    ...resources.routines.map((routineId) => ({
      label: `routine ${routineId}`,
      expectedStatus: 204,
      run: () => page.request.delete(`/api/routines/${routineId}`),
    })),
    ...resources.members.map((memberId) => ({
      label: `member ${memberId}`,
      expectedStatus: 200,
      run: () => page.request.post(`/api/members/${memberId}/archive`),
    })),
  ];
  const cleanupFailures: string[] = [];
  for (const cleanup of cleanupOperations) {
    try {
      const response = await cleanup.run();
      if (response.status() !== cleanup.expectedStatus) {
        cleanupFailures.push(
          `${cleanup.label}: expected ${cleanup.expectedStatus}, received ${response.status()}`
        );
      }
    } catch (error) {
      cleanupFailures.push(`${cleanup.label}: ${(error as Error).message}`);
    }
  }
  expect(cleanupFailures).toEqual([]);
});

async function provision(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("access-gate-form")).toBeVisible();
  await page.getByTestId("access-gate-form").locator('input[name="token"]').fill(ACCESS_TOKEN);
  await page.getByRole("button", { name: "Enter", exact: true }).click();
  await expect(page.getByRole("button", { name: "Provision Device" })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByLabel("Bootstrap key").fill(BOOTSTRAP_KEY);
  await page.getByRole("button", { name: "Provision Device" }).click();
  await expect(page.getByTestId("home-surface")).toBeVisible({ timeout: 15_000 });
}

async function expectStatus(
  response: Awaited<ReturnType<APIRequestContext["post"]>>,
  status: number
) {
  expect(response.status()).toBe(status);
  return response;
}

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

test("household dashboard: integrated family flow remains independently usable", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 800 });

  // A run-local namespace avoids assumptions about the shared e2e database. The production
  // regression this catches is a shell/dashboard change that couples a widget, period state,
  // family navigation, or the printer/admin entry point to another surface.
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const firstChildName = `Dashboard first child ${runId}`;
  const secondChildName = `Dashboard second child ${runId}`;
  const mealNote = `Dashboard meal ${runId}`;
  const agendaTitle = `Dashboard agenda ${runId}`;
  const choreName = `Dashboard chore ${runId}`;
  const agendaEndpoint = /\/api\/calendar\/events\?/;
  await provision(page);
  const settingsResponse = await page.request.get("/api/settings");
  expect(settingsResponse.status()).toBe(200);
  const settings = (await settingsResponse.json()) as {
    locale: { language?: string; timezone: string };
  };
  const m = messages[resolveLang(settings.locale.language)];
  const today = todayInTimezone(settings.locale.timezone);
  const adjacentDay = addDays(today, 1);
  const weekdays = [weekdayCode(today), weekdayCode(adjacentDay)];

  for (const displayName of [firstChildName, secondChildName]) {
    const response = await expectStatus(
      await page.request.post("/api/members", { data: { displayName, role: "child" } }),
      201
    );
    created.members.push(((await response.json()) as { id: string }).id);
  }
  const [firstChildId, secondChildId] = created.members;

  const routineResponse = await expectStatus(
    await page.request.post("/api/routines", {
      data: { name: `Dashboard routine ${runId}`, dayPeriodId: "morning" },
    }),
    201
  );
  const routineId = ((await routineResponse.json()) as { id: string }).id;
  created.routines.push(routineId);
  const choreResponse = await expectStatus(
    await page.request.post(`/api/routines/${routineId}/chores`, { data: { name: choreName } }),
    201
  );
  const choreId = ((await choreResponse.json()) as { id: string }).id;
  for (const memberId of created.members) {
    expect(
      (
        await page.request.put(`/api/routines/${routineId}/assignments/${memberId}`, {
          data: { weekdays, active: true },
        })
      ).status()
    ).toBe(200);
  }

  // A page can cross the household's local midnight after this date is read. Seed only the
  // adjacent household day too, so the real widgets remain populated on either side of that
  // one crossing without fabricating browser time.
  for (const date of [today, adjacentDay]) {
    const mealResponse = await expectStatus(
      await page.request.post("/api/meal-entries", {
        data: { kind: "oneoff", date, slot: "dinner", note: mealNote },
      }),
      201
    );
    created.meals.push(((await mealResponse.json()) as { id: string }).id);
  }

  const eventResponse = await expectStatus(
    await page.request.post("/api/calendar/events", {
      data: {
        title: agendaTitle,
        allDay: true,
        startDate: today,
        endDate: addDays(adjacentDay, 1),
      },
    }),
    201
  );
  const eventId = ((await eventResponse.json()) as { id: string }).id;
  created.events.push(eventId);
  expect(
    (
      await page.request.put(`/api/calendar/events/${eventId}/assignments`, {
        data: { memberIds: [firstChildId, secondChildId] },
      })
    ).status()
  ).toBe(200);

  // The failed request is at the real HTTP boundary. The shell, chores, and meals stay real;
  // this is deliberately not a DOM-only mock of a widget's rendered state.
  await page.route(agendaEndpoint, async (route) => {
    await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: m["agenda.title"] })).toBeVisible();
  await expect(page.getByText(m["agenda.error"], { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: m["todayChores.title"] })).toBeVisible();
  await expect(page.getByRole("heading", { name: m["todayMeals.title"] })).toBeVisible();
  await expect(page.getByTestId("today-meals-strip")).toContainText(mealNote);

  // A real chore action must remain available while Agenda is degraded, not merely after retry.
  const firstColumn = page.getByTestId(`today-chores-column-${firstChildId}`);
  const secondColumn = page.getByTestId(`today-chores-column-${secondChildId}`);
  await expect(firstColumn).toBeVisible();
  await expect(secondColumn).toBeVisible();
  await selectPeriod(
    firstColumn,
    "morning",
    m["todayChores.previousPeriod"],
    m["todayChores.nextPeriod"]
  );
  const choreToggle = page.getByTestId(`today-chore-toggle-${firstChildId}-${choreId}`);
  const complete = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/chores/${choreId}/completions`) &&
      response.request().method() === "POST"
  );
  await choreToggle.click();
  expect((await complete).status()).toBe(204);
  await expect(choreToggle).toHaveAttribute("aria-pressed", "true");

  await choreToggle.click();
  await expect(page.getByTestId("today-chores-uncomplete-confirm")).toBeVisible();
  const uncomplete = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/chores/${choreId}/completions`) &&
      response.request().method() === "DELETE"
  );
  await page.getByTestId("today-chores-uncomplete-confirm").click();
  expect((await uncomplete).status()).toBe(204);
  await expect(choreToggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText(m["agenda.error"], { exact: true })).toBeVisible();

  await page.unroute(agendaEndpoint);
  await page.getByRole("button", { name: m["agenda.retry"], exact: true }).click();
  const agendaItem = page.getByRole("listitem").filter({ hasText: agendaTitle });
  await expect(agendaItem).toBeVisible();
  // Both names are textual children of the agenda item, so identity survives without colour.
  await expect(agendaItem.getByText(firstChildName, { exact: true })).toBeVisible();
  await expect(agendaItem.getByText(secondChildName, { exact: true })).toBeVisible();

  await selectPeriod(
    secondColumn,
    "evening",
    m["todayChores.previousPeriod"],
    m["todayChores.nextPeriod"]
  );
  await expect(firstColumn.getByTestId("today-chores-active-period")).toHaveAttribute(
    "data-period-id",
    "morning"
  );
  await expect(secondColumn.getByTestId("today-chores-active-period")).toHaveAttribute(
    "data-period-id",
    "evening"
  );

  const attentionPill = page.getByTestId("printer-attention-pill");
  await expect(attentionPill).toBeVisible();
  await attentionPill.click();
  await expect(page.getByTestId("printer-attention-dialog")).toBeVisible();
  await page.getByRole("button", { name: m["printing.attention.dismiss"], exact: true }).click();
  await expect(attentionPill).toBeFocused();

  const nav = page.getByRole("navigation", { name: m["shell.nav.label"] });
  for (const destination of ["/calendar", "/chores", "/meals", "/"] as const) {
    await nav.locator(`a[href="${destination}"]`).click();
    await expect(page).toHaveURL(destination === "/" ? /\/$/ : new RegExp(`${destination}$`));
    await test.info().attach(`family-${destination.replaceAll("/", "") || "home"}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  }

  await page.goto("/daily-briefing");
  await expect(page.getByRole("heading", { name: m["shell.notFound.title"] })).toBeVisible();
  await expect(page.getByTestId("home-surface")).toHaveCount(0);

  await page.goto("/");
  await page.getByRole("button", { name: m["shell.options.label"], exact: true }).click();
  const adminButton = page.getByRole("button", { name: m["shell.options.admin"], exact: true });
  await adminButton.hover();
  await page.mouse.down();
  await expect(page.getByTestId("admin-pin-keypad")).toBeVisible({ timeout: 6_000 });
  await page.mouse.up();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByTestId("admin-panel-scope")).toHaveCount(0);
});
