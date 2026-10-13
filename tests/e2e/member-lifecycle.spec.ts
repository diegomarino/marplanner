import { test, expect, type Locator, type Page } from "@playwright/test";
import { createMember, openAdminSection } from "./admin-nav";
import { messages, resolveLang } from "../../src/client/i18n/messages";
import { unlockAdmin } from "./admin-unlock";

/** — complete member lifecycle through the real built application.
 * The run-local member is created and edited through the visible Admin UI. Calendar,
 * Daily Messages, and Chores then prove active-picker membership and shared semantic colour
 * identity. Archival removes the member from active consumers while preserving an authored
 * Daily Message, Calendar event, and archived label; restoration reactivates the same identity
 * and the Calendar assignment without recreating either record.
 */

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";
const BOOTSTRAP_KEY = process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key";
const ADMIN_PIN = process.env.ADMIN_PIN ?? "1234";

type MemberRecord = {
  id: string;
  displayName: string;
  colorKey: string;
  role: "parent" | "child";
  lifecycle: "active" | "archived";
};

type CalendarItem = {
  id: string;
  title: string;
  assignedTo: string[];
};

function householdDate(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
}

function addDays(date: string, days: number): string {
  const instant = new Date(`${date}T00:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

function weekdayCode(date: string): string {
  const instant = new Date(`${date}T00:00:00.000Z`);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
  })
    .format(instant)
    .toLowerCase();
}

async function inlineStyle(locator: Locator, property: string): Promise<string> {
  return locator.evaluate((element, name) => {
    return (element as HTMLElement).style.getPropertyValue(name as string).trim();
  }, property);
}

async function activeMembers(page: Page): Promise<MemberRecord[]> {
  const response = await page.request.get("/api/members");
  expect(response.status()).toBe(200);
  return (await response.json()) as MemberRecord[];
}

test.describe.configure({ mode: "serial" });

test("member lifecycle preserves active choices, historical reads, and colour identity", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const originalName = `Member ${runId}`;
  const editedName = `Household Member ${runId}`;
  const eventTitle = `Member history ${runId}`;
  const messageText = `Historical message ${runId}`;

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

  const settingsResponse = await page.request.get("/api/settings");
  expect(settingsResponse.status()).toBe(200);
  const settings = (await settingsResponse.json()) as {
    locale: { language?: string; timezone: string };
  };
  const m = messages[resolveLang(settings.locale.language)];
  const today = householdDate(settings.locale.timezone);

  await unlockAdmin(page, ADMIN_PIN);

  // The server picks the first free colour; which one depends on the members other specs have
  // created in this shared database, so the spec reads colours back instead of naming them.
  await createMember(page, originalName, { roleOption: m["members.create.child"] });

  const created = (await activeMembers(page)).find((member) => member.displayName === originalName);
  expect(created).toMatchObject({
    displayName: originalName,
    role: "child",
    lifecycle: "active",
  });
  expect(created?.id).toBeTruthy();
  const memberId = created!.id;

  await openAdminSection(page, "admin-nav-members-management");
  const originalCard = page.getByTestId(`member-card-${memberId}`);
  await expect(originalCard).toContainText(originalName);
  await originalCard.click();
  const editDialog = page.getByRole("dialog", {
    name: `${m["members.action.edit"]} ${originalName}`,
  });
  await editDialog.getByLabel(m["members.create.displayName"]).fill(editedName);
  const editResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/members/${memberId}`) && response.request().method() === "PATCH"
  );
  await editDialog.getByRole("button", { name: m["members.action.save"] }).click();
  expect((await editResponse).status()).toBe(200);

  // The colour is left as the server assigned it. Changing it here would race the other specs
  // that create members in this shared database; member-management.spec.ts covers the change on
  // a server of its own.
  const edited = (await activeMembers(page)).find((member) => member.id === memberId);
  expect(edited).toMatchObject({
    id: memberId,
    displayName: editedName,
    role: "child",
    lifecycle: "active",
  });
  const memberColour = edited!.colorKey;
  expect(memberColour).toBe(created!.colorKey);
  await expect(page.getByTestId(`member-card-${memberId}`)).toContainText(editedName);

  const messageResponse = await page.request.put("/api/daily-messages", {
    data: { memberId, date: today, text: messageText },
  });
  expect(messageResponse.status()).toBe(200);

  const eventResponse = await page.request.post("/api/calendar/events", {
    data: {
      title: eventTitle,
      allDay: true,
      startDate: today,
      endDate: addDays(today, 1),
    },
  });
  expect(eventResponse.status()).toBe(201);
  const eventId = ((await eventResponse.json()) as { id: string }).id;
  const assignmentResponse = await page.request.put(`/api/calendar/events/${eventId}/assignments`, {
    data: { memberIds: [memberId] },
  });
  expect(assignmentResponse.status()).toBe(200);

  const routineResponse = await page.request.post("/api/routines", {
    data: { name: `Member colour routine ${runId}`, dayPeriodId: "morning" },
  });
  expect(routineResponse.status()).toBe(201);
  const routineId = ((await routineResponse.json()) as { id: string }).id;
  const choreResponse = await page.request.post(`/api/routines/${routineId}/chores`, {
    data: { name: `Member colour chore ${runId}` },
  });
  expect(choreResponse.status()).toBe(201);
  const routineAssignmentResponse = await page.request.put(
    `/api/routines/${routineId}/assignments/${memberId}`,
    { data: { weekdays: [weekdayCode(today)], active: true } }
  );
  expect(routineAssignmentResponse.status()).toBe(200);

  await openAdminSection(page, "admin-nav-daily-messages-management");
  const messagePicker = page.getByTestId("daily-messages-select-member");
  await expect(messagePicker.locator(`option[value="${memberId}"]`)).toHaveText(editedName);

  await page.goto("/calendar");
  await expect(page.getByText(/cargando calendario|loading calendar/i)).toHaveCount(0, {
    timeout: 15_000,
  });
  const memberFilter = page.getByRole("checkbox", { name: editedName });
  await expect(memberFilter).toBeVisible();
  await memberFilter.check();
  const eventRow = page.getByTestId("calendar-event-row").filter({ hasText: eventTitle });
  await expect(eventRow).toBeVisible();
  expect(await inlineStyle(eventRow, "--member-event-border")).toBe(
    `var(--color-member-${memberColour}-500)`
  );

  await page.goto("/chores");
  const choreColumn = page.getByTestId(`chores-board-column-${memberId}`);
  await expect(choreColumn).toBeVisible({ timeout: 15_000 });
  expect(await inlineStyle(choreColumn, "--member-color")).toBe(
    `var(--color-member-${memberColour}-500)`
  );

  await unlockAdmin(page, ADMIN_PIN);
  await openAdminSection(page, "admin-nav-members-management");
  const activeCard = page.getByTestId(`member-card-${memberId}`);
  await expect(activeCard).toContainText(editedName);
  const archiveResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/members/${memberId}/archive`) &&
      response.request().method() === "POST"
  );
  // Archive lives in the member's form and asks once more.
  await activeCard.click();
  await page.getByTestId("member-archive").click();
  await page.getByTestId("member-lifecycle-confirm").click();
  expect((await archiveResponse).status()).toBe(200);
  await expect(activeCard).toHaveCount(0);

  await page.getByTestId("members-tab-archived").click();
  const archivedCard = page.getByTestId(`member-card-${memberId}`);
  await expect(archivedCard).toContainText(editedName);
  const archivedResponse = await page.request.get("/api/members?lifecycle=archived");
  expect(archivedResponse.status()).toBe(200);
  expect((await archivedResponse.json()) as MemberRecord[]).toContainEqual(
    expect.objectContaining({
      id: memberId,
      displayName: editedName,
      colorKey: memberColour,
      lifecycle: "archived",
    })
  );

  await openAdminSection(page, "admin-nav-daily-messages-management");
  await expect(messagePicker.locator(`option[value="${memberId}"]`)).toHaveCount(0);
  const historicalMessageResponse = await page.request.get(
    `/api/daily-messages/current?memberId=${memberId}&date=${today}`
  );
  expect(historicalMessageResponse.status()).toBe(200);
  expect(await historicalMessageResponse.json()).toMatchObject({
    memberId,
    date: today,
    text: messageText,
  });

  await page.goto("/calendar");
  await expect(page.getByRole("checkbox", { name: editedName })).toHaveCount(0);
  await expect(page.getByTestId("calendar-event-row").filter({ hasText: eventTitle })).toBeVisible({
    timeout: 15_000,
  });
  const archivedScopedResponse = await page.request.get(
    `/api/calendar/events?source=all&from=${today}&to=${addDays(today, 2)}&assignedTo=${memberId}`
  );
  expect(archivedScopedResponse.status()).toBe(200);
  expect(await archivedScopedResponse.json()).toEqual([]);

  await page.goto("/chores");
  await expect(page.getByTestId(`chores-board-column-${memberId}`)).toHaveCount(0, {
    timeout: 15_000,
  });

  await unlockAdmin(page, ADMIN_PIN);
  await openAdminSection(page, "admin-nav-members-management");
  await page.getByTestId("members-tab-archived").click();
  const restoreCard = page.getByTestId(`member-card-${memberId}`);
  await expect(restoreCard).toContainText(editedName);
  const restoreResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/members/${memberId}/restore`) &&
      response.request().method() === "POST"
  );
  await restoreCard.click();
  await page.getByTestId("member-restore").click();
  await page.getByTestId("member-lifecycle-confirm").click();
  expect((await restoreResponse).status()).toBe(200);

  // An archived member holds no colour, so another spec's member may have taken it meanwhile.
  // The restored member then has the first free one; either way it is one colour everywhere.
  const restored = (await activeMembers(page)).find((member) => member.id === memberId);
  expect(restored).toMatchObject({
    id: memberId,
    displayName: editedName,
    lifecycle: "active",
  });
  const restoredColour = restored!.colorKey;
  expect(restoredColour).toBeTruthy();

  await openAdminSection(page, "admin-nav-daily-messages-management");
  await expect(messagePicker.locator(`option[value="${memberId}"]`)).toHaveText(editedName);

  const restoredScopedResponse = await page.request.get(
    `/api/calendar/events?source=all&from=${today}&to=${addDays(today, 2)}&assignedTo=${memberId}`
  );
  expect(restoredScopedResponse.status()).toBe(200);
  const restoredScopedItems = (await restoredScopedResponse.json()) as CalendarItem[];
  expect(restoredScopedItems).toContainEqual(
    expect.objectContaining({ id: eventId, title: eventTitle, assignedTo: [memberId] })
  );

  await page.goto("/chores");
  const restoredChoreColumn = page.getByTestId(`chores-board-column-${memberId}`);
  await expect(restoredChoreColumn).toBeVisible({ timeout: 15_000 });
  expect(await inlineStyle(restoredChoreColumn, "--member-color")).toBe(
    `var(--color-member-${restoredColour}-500)`
  );
});
