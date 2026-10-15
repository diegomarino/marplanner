/** RoutinesManagement — master/detail admin page for routines, chores and weekday assignments.
 * Pins: grouping/selection, Retry on load errors, routine and chore dialogs, the streak-warning
 * confirmations (routine/chore delete, period move, existing assignment change, deactivate),
 * keyboard drag reorder, Spanish labels and kiosk density.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RoutinesManagement } from "@/admin/RoutinesManagement";
import { LanguageProvider } from "@/i18n";
import { DensityViolationError, assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

// Radix Select scrolls the chosen option into view; jsdom has no scrollIntoView
// (same file-local stub as members-admin.test.tsx).
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? ((() => {}) as never);

type Json = Record<string, unknown>;
interface Call {
  url: string;
  method: string;
  body: unknown;
}

const MORNING = { id: "morning", labelKey: "dayPeriod.morning", start: "06:00", sortOrder: 0 };
const AFTERNOON = {
  id: "afternoon",
  labelKey: "dayPeriod.afternoon",
  start: "12:00",
  sortOrder: 1,
};
const EVENING = { id: "evening", labelKey: "dayPeriod.evening", start: "17:00", sortOrder: 2 };
const ROUTINE = { id: "r1", name: "Morning Routine", dayPeriodId: "morning", active: true };
const ROUTINE_EVENING = { id: "r2", name: "Evening Routine", dayPeriodId: "evening", active: true };
const CHORES = [
  { id: "c1", routineId: "r1", name: "Brush teeth", icon: "🪥", sortOrder: 0, active: true },
  { id: "c2", routineId: "r1", name: "Make bed", icon: null, sortOrder: 1, active: true },
  { id: "c3", routineId: "r1", name: "Pack bag", icon: "🎒", sortOrder: 2, active: true },
];
const EVENING_CHORE = {
  id: "c9",
  routineId: "r2",
  name: "Set table",
  icon: null,
  sortOrder: 0,
  active: true,
};
const member = (id: string, displayName: string, role: string, colorKey: string) => ({
  id,
  displayName,
  role,
  colorKey,
  lifecycle: "active",
  createdAt: 0,
  updatedAt: 0,
});
const CHILD = member("m1", "Ari", "child", "red");
const CHILD_2 = member("m2", "Bo", "child", "teal");
const PARENT = member("p1", "Pat", "parent", "blue");

interface Backend {
  routines?: Json[];
  dayPeriods?: Json[];
  chores?: Json[];
  choresFor?: (routineId: string) => Promise<Json[]>;
  assignments?: Json[];
  members?: Json[];
  language?: string;
  /** Return true to answer that request with a 500. */
  fail?: (url: string, method: string) => boolean;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function mockBackend(backend: Backend = {}): Call[] {
  const calls: Call[] = [];
  let routines: Json[] = [...(backend.routines ?? [ROUTINE, ROUTINE_EVENING])];
  const mockFetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (backend.fail?.(url, method)) return json({ error: "internal_error", message: "x" }, 500);
    if (url.includes("/api/settings")) {
      return json({ locale: { timezone: "UTC", language: backend.language ?? "en" } });
    }
    if (url === "/api/day-periods")
      return json(backend.dayPeriods ?? [MORNING, AFTERNOON, EVENING]);
    if (url === "/api/members") return json(backend.members ?? [CHILD, PARENT]);
    if (url === "/api/routines" && method === "GET") return json(routines);
    if (url === "/api/routines" && method === "POST") {
      const created = { id: "r-new", active: true, ...(body as Json) };
      routines = [...routines, created];
      return json(created, 201);
    }
    const routineMatch = url.match(/^\/api\/routines\/([^/]+)$/);
    if (routineMatch && method === "PATCH") {
      routines = routines.map((r) => (r.id === routineMatch[1] ? { ...r, ...(body as Json) } : r));
      return json(routines.find((r) => r.id === routineMatch[1]));
    }
    if (routineMatch && method === "DELETE") {
      routines = routines.filter((r) => r.id !== routineMatch[1]);
      return new Response(null, { status: 204 });
    }
    const choresMatch = url.match(/^\/api\/routines\/([^/]+)\/chores$/);
    if (choresMatch && method === "GET") {
      return json(
        backend.choresFor ? await backend.choresFor(choresMatch[1]) : (backend.chores ?? CHORES)
      );
    }
    if (choresMatch && method === "POST") {
      return json(
        { id: "c-new", routineId: choresMatch[1], sortOrder: 3, active: true, ...(body as Json) },
        201
      );
    }
    if (/\/chores\/order$/.test(url) && method === "PUT") {
      const ids = (body as { choreIds: string[] }).choreIds;
      return json(ids.map((id, sortOrder) => ({ ...CHORES.find((c) => c.id === id), sortOrder })));
    }
    if (/^\/api\/chores\/[^/]+$/.test(url) && method === "PATCH")
      return json({ ...CHORES[0], ...(body as Json) });
    if (/^\/api\/chores\/[^/]+$/.test(url) && method === "DELETE")
      return new Response(null, { status: 204 });
    if (/\/assignments$/.test(url) && method === "GET") return json(backend.assignments ?? []);
    const assignmentMatch = url.match(/\/assignments\/([^/]+)$/);
    if (assignmentMatch && method === "PUT") {
      return json({ id: "a-new", memberId: assignmentMatch[1], ...(body as Json) });
    }
    if (assignmentMatch && method === "DELETE") {
      return json({ id: "a1", memberId: assignmentMatch[1], weekdays: ["mon"], active: false });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", mockFetch);
  return calls;
}

const callsTo = (calls: Call[], method: string, url: string) =>
  calls.filter((call) => call.method === method && call.url === url);

function renderPage() {
  return render(
    <LanguageProvider>
      <RoutinesManagement />
    </LanguageProvider>
  );
}

async function selectRoutine(id = "r1") {
  fireEvent.click(await screen.findByTestId(`routine-list-item-${id}`));
  return screen.findByTestId("routine-detail");
}

async function chooseOption(comboboxName: string, optionText: string) {
  fireEvent.click(screen.getByRole("combobox", { name: comboboxName }));
  const options = await screen.findAllByRole("option");
  fireEvent.click(options.find((option) => option.textContent === optionText)!);
}

function choreOrder(): string[] {
  return screen.getAllByTestId(/^chore-c\d+$/).map((row) => row.dataset.testid ?? "");
}

async function keyboardDragFirstChoreDown() {
  const handle = screen.getByRole("button", { name: "Reorder Brush teeth" });
  screen.getAllByTestId(/^chore-c\d+$/).forEach((row, index) => {
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: index * 60,
      top: index * 60,
      left: 0,
      bottom: index * 60 + 50,
      right: 200,
      width: 200,
      height: 50,
      toJSON: () => ({}),
    });
  });
  handle.focus();
  await act(async () => {
    fireEvent.keyDown(handle, { key: "Space", code: "Space", keyCode: 32 });
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    fireEvent.keyDown(handle, { key: "ArrowDown", code: "ArrowDown", keyCode: 40 });
  });
  await act(async () => {
    fireEvent.keyDown(handle, { key: "Space", code: "Space", keyCode: 32 });
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  cleanup();
  document.documentElement.removeAttribute("data-density");
});

describe("RoutinesManagement — list and selection", () => {
  it("groups routines by day period in start order, names the page like the sidebar and asks for a selection", async () => {
    mockBackend({ routines: [ROUTINE_EVENING, ROUTINE] });
    renderPage();

    await screen.findByTestId("routine-list-item-r1");
    expect(screen.getAllByTestId(/^routine-list-item-/).map((item) => item.dataset.testid)).toEqual(
      ["routine-list-item-r1", "routine-list-item-r2"]
    );
    expect(screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent)).toEqual([
      "Morning",
      "Evening",
    ]);
    expect(screen.getByTestId("routines-select-prompt")).toHaveTextContent(
      "Select a routine to manage its chores"
    );
    expect(screen.getByRole("region", { name: "Routines & Chores" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "Routines & Chores" })
    ).toBeInTheDocument();
  });

  it("shows the empty message without routines", async () => {
    mockBackend({ routines: [] });
    renderPage();
    expect(await screen.findByTestId("routines-empty")).toHaveTextContent("No routines found.");
  });

  it("announces a load failure and Retry loads again", async () => {
    let failOnce = true;
    mockBackend({
      fail: (url, method) => {
        if (url === "/api/routines" && method === "GET" && failOnce) {
          failOnce = false;
          return true;
        }
        return false;
      },
    });
    renderPage();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load data.");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    fireEvent.click(screen.getByTestId("routines-retry"));
    expect(await screen.findByTestId("routine-list-item-r1")).toBeInTheDocument();
  });

  it("shows the selected routine's header and chores in order, with the vendored Noto icon", async () => {
    mockBackend();
    renderPage();
    const detail = await selectRoutine("r1");

    expect(within(detail).getByRole("heading", { name: "Morning Routine" })).toBeInTheDocument();
    expect(detail).toHaveTextContent("Morning");
    await waitFor(() => expect(choreOrder()).toEqual(["chore-c1", "chore-c2", "chore-c3"]));
    expect(screen.getByTestId("routine-list-item-r1")).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId("routine-list-item-r2")).not.toHaveAttribute("aria-current");
    expect(screen.getByTestId("chore-c1").querySelector("img")).toHaveAttribute(
      "src",
      expect.stringContaining("emoji_u1faa5")
    );
  });

  it("shows the empty chore message for a routine without chores", async () => {
    mockBackend({ chores: [] });
    renderPage();
    const detail = await selectRoutine("r1");
    expect(within(detail).getByTestId("routine-chores-empty")).toHaveTextContent(
      "No chores yet. Add one above."
    );
  });

  it("announces a detail load failure and Retry loads it again", async () => {
    let failOnce = true;
    mockBackend({
      fail: (url) => {
        if (url === "/api/routines/r1/chores" && failOnce) {
          failOnce = false;
          return true;
        }
        return false;
      },
    });
    renderPage();
    fireEvent.click(await screen.findByTestId("routine-list-item-r1"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Failed to load this routine's chores and assignments."
    );
    fireEvent.click(screen.getByTestId("routine-detail-retry"));
    expect(await screen.findByTestId("routine-detail")).toBeInTheDocument();
  });

  it("ignores a stale detail response after switching routines", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mockBackend({
      choresFor: async (routineId) => {
        if (routineId === "r1") {
          await gate;
          return CHORES;
        }
        return [EVENING_CHORE];
      },
    });
    renderPage();
    fireEvent.click(await screen.findByTestId("routine-list-item-r1"));
    const detail = await selectRoutine("r2");
    expect(await within(detail).findByText("Set table")).toBeInTheDocument();

    await act(async () => {
      releaseFirst();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByTestId("routine-detail")).toHaveAttribute("data-routine-id", "r2");
    expect(screen.queryByText("Brush teeth")).not.toBeInTheDocument();
  });

  it("week grid shows only active assignments, per weekday, and opens the assignment dialog", async () => {
    mockBackend({
      members: [CHILD, CHILD_2, PARENT],
      assignments: [
        { id: "a1", memberId: "m1", weekdays: ["mon", "wed"], active: true },
        { id: "a2", memberId: "m2", weekdays: ["mon"], active: false },
      ],
    });
    renderPage();
    await selectRoutine("r1");

    expect(screen.getByTestId("routine-week-day-mon")).toHaveTextContent("Ari");
    expect(screen.getByTestId("routine-week-day-mon")).not.toHaveTextContent("Bo");
    expect(screen.getByTestId("routine-week-day-tue")).not.toHaveTextContent("Ari");
    expect(screen.getByTestId("routine-week-day-wed")).toHaveTextContent("Ari");

    fireEvent.click(screen.getByRole("button", { name: "Manage assignments" }));
    expect(await screen.findByTestId("assignment-dialog")).toBeInTheDocument();
  });
});

describe("RoutinesManagement — routine dialog", () => {
  it("creates a routine: first period by default, submit disabled until named, new routine selected", async () => {
    const calls = mockBackend();
    renderPage();
    fireEvent.click(await screen.findByTestId("routines-new"));
    const dialog = await screen.findByTestId("routine-form-dialog");

    expect(within(dialog).getByTestId("routine-form-submit")).toBeDisabled();
    expect(within(dialog).getByRole("combobox", { name: "Day period" })).toHaveTextContent(
      "Morning"
    );
    fireEvent.change(within(dialog).getByTestId("routine-form-name"), {
      target: { value: "  Homework  " },
    });
    fireEvent.click(within(dialog).getByTestId("routine-form-submit"));

    await waitFor(() =>
      expect(callsTo(calls, "POST", "/api/routines")[0]?.body).toEqual({
        name: "Homework",
        dayPeriodId: "morning",
      })
    );
    const detail = await screen.findByTestId("routine-detail");
    expect(detail).toHaveAttribute("data-routine-id", "r-new");
    expect(screen.queryByTestId("routine-form-dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("routine-list-item-r-new")).toHaveAttribute("aria-current", "true");
  });

  it("renames a routine without a confirmation", async () => {
    const calls = mockBackend();
    renderPage();
    await selectRoutine("r1");
    fireEvent.click(screen.getByTestId("routine-edit"));
    const dialog = await screen.findByTestId("routine-form-dialog");
    fireEvent.change(within(dialog).getByTestId("routine-form-name"), {
      target: { value: "Sunrise" },
    });
    fireEvent.click(within(dialog).getByTestId("routine-form-submit"));

    await waitFor(() =>
      expect(callsTo(calls, "PATCH", "/api/routines/r1")[0]?.body).toEqual({
        name: "Sunrise",
        dayPeriodId: "morning",
      })
    );
    expect(screen.queryByTestId("routine-period-confirm")).not.toBeInTheDocument();
    expect(await screen.findByTestId("routine-list-item-r1")).toHaveTextContent("Sunrise");
  });

  it("moving a routine to another period asks for the streak confirmation first", async () => {
    const calls = mockBackend();
    renderPage();
    await selectRoutine("r1");
    fireEvent.click(screen.getByTestId("routine-edit"));
    await screen.findByTestId("routine-form-dialog");
    await chooseOption("Day period", "Evening");

    fireEvent.click(screen.getByTestId("routine-form-submit"));
    expect(await screen.findByText("This will change the live streak.")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("routine-period-cancel"));
    await waitFor(() =>
      expect(screen.queryByTestId("routine-period-confirm")).not.toBeInTheDocument()
    );
    expect(callsTo(calls, "PATCH", "/api/routines/r1")).toHaveLength(0);

    fireEvent.click(screen.getByTestId("routine-form-submit"));
    fireEvent.click(await screen.findByTestId("routine-period-confirm"));
    await waitFor(() =>
      expect(callsTo(calls, "PATCH", "/api/routines/r1")[0]?.body).toEqual({
        name: "Morning Routine",
        dayPeriodId: "evening",
      })
    );
    await waitFor(() => expect(screen.getByTestId("routine-detail")).toHaveTextContent("Evening"));
  });

  it("keeps the dialog open and announces a failed save", async () => {
    mockBackend({ fail: (url, method) => url === "/api/routines" && method === "POST" });
    renderPage();
    fireEvent.click(await screen.findByTestId("routines-new"));
    const dialog = await screen.findByTestId("routine-form-dialog");
    fireEvent.change(within(dialog).getByTestId("routine-form-name"), {
      target: { value: "Homework" },
    });
    fireEvent.click(within(dialog).getByTestId("routine-form-submit"));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The routine could not be saved."
    );
    expect(screen.getByTestId("routine-form-dialog")).toBeInTheDocument();
  });

  it("deletes a routine only after confirmation and clears the selection", async () => {
    const calls = mockBackend();
    renderPage();
    await selectRoutine("r1");

    fireEvent.click(screen.getByTestId("routine-delete"));
    expect(await screen.findByText(/This will change the live streak\./)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("routine-delete-cancel-r1"));
    await waitFor(() =>
      expect(screen.queryByTestId("routine-delete-confirm-r1")).not.toBeInTheDocument()
    );
    expect(callsTo(calls, "DELETE", "/api/routines/r1")).toHaveLength(0);

    fireEvent.click(screen.getByTestId("routine-delete"));
    fireEvent.click(await screen.findByTestId("routine-delete-confirm-r1"));
    await waitFor(() => expect(callsTo(calls, "DELETE", "/api/routines/r1")).toHaveLength(1));
    expect(await screen.findByTestId("routines-select-prompt")).toBeInTheDocument();
    expect(screen.queryByTestId("routine-list-item-r1")).not.toBeInTheDocument();
  });
});

describe("RoutinesManagement — chores", () => {
  it("adds a chore from the dialog: blank disables submit, Enter submits with the icon", async () => {
    const calls = mockBackend();
    renderPage();
    await selectRoutine("r1");
    fireEvent.click(screen.getByTestId("routine-add-chore"));
    const dialog = await screen.findByTestId("chore-form-dialog");

    expect(within(dialog).getByTestId("chore-form-submit")).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Select chore icon" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Select Backpack" }));
    const input = within(dialog).getByTestId("chore-form-name");
    fireEvent.change(input, { target: { value: "Pack lunch" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() =>
      expect(callsTo(calls, "POST", "/api/routines/r1/chores")[0]?.body).toEqual({
        name: "Pack lunch",
        icon: "🎒",
      })
    );
    await waitFor(() => expect(screen.queryByTestId("chore-form-dialog")).not.toBeInTheDocument());
  });

  it("Enter twice creates the chore once", async () => {
    const calls = mockBackend();
    renderPage();
    await selectRoutine("r1");
    fireEvent.click(screen.getByTestId("routine-add-chore"));
    const input = within(await screen.findByTestId("chore-form-dialog")).getByTestId(
      "chore-form-name"
    );
    fireEvent.change(input, { target: { value: "Pack lunch" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() => expect(screen.queryByTestId("chore-form-dialog")).not.toBeInTheDocument());
    expect(callsTo(calls, "POST", "/api/routines/r1/chores")).toHaveLength(1);
  });

  it("edits a chore and clears its icon", async () => {
    const calls = mockBackend();
    renderPage();
    await selectRoutine("r1");
    fireEvent.click(await screen.findByRole("button", { name: "Edit Brush teeth" }));
    const dialog = await screen.findByTestId("chore-form-dialog");

    expect(within(dialog).getByTestId("chore-form-name")).toHaveValue("Brush teeth");
    fireEvent.click(within(dialog).getByRole("button", { name: "Selected icon: 🪥. Change icon" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear icon" }));
    fireEvent.click(within(dialog).getByTestId("chore-form-submit"));

    await waitFor(() =>
      expect(callsTo(calls, "PATCH", "/api/chores/c1")[0]?.body).toEqual({
        name: "Brush teeth",
        icon: null,
      })
    );
  });

  it("announces a failed chore save inside the dialog", async () => {
    mockBackend({ fail: (url, method) => url === "/api/routines/r1/chores" && method === "POST" });
    renderPage();
    await selectRoutine("r1");
    fireEvent.click(screen.getByTestId("routine-add-chore"));
    const dialog = await screen.findByTestId("chore-form-dialog");
    fireEvent.change(within(dialog).getByTestId("chore-form-name"), {
      target: { value: "New chore" },
    });
    fireEvent.click(within(dialog).getByTestId("chore-form-submit"));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The chore could not be saved."
    );
  });

  it("deletes a chore only after confirmation", async () => {
    const calls = mockBackend();
    renderPage();
    await selectRoutine("r1");

    fireEvent.click(await screen.findByRole("button", { name: "Delete Brush teeth" }));
    fireEvent.click(await screen.findByTestId("routine-r1-chore-delete-cancel"));
    await waitFor(() =>
      expect(screen.queryByTestId("routine-r1-chore-delete-confirm")).not.toBeInTheDocument()
    );
    expect(callsTo(calls, "DELETE", "/api/chores/c1")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Delete Brush teeth" }));
    fireEvent.click(await screen.findByTestId("routine-r1-chore-delete-confirm"));
    await waitFor(() => expect(callsTo(calls, "DELETE", "/api/chores/c1")).toHaveLength(1));
  });

  it("keyboard drag persists the complete new order", async () => {
    const calls = mockBackend();
    renderPage();
    await selectRoutine("r1");
    await screen.findByTestId("chore-c3");

    await keyboardDragFirstChoreDown();

    await waitFor(() =>
      expect(callsTo(calls, "PUT", "/api/routines/r1/chores/order")[0]?.body).toEqual({
        choreIds: ["c2", "c1", "c3"],
      })
    );
    await waitFor(() => expect(choreOrder()).toEqual(["chore-c2", "chore-c1", "chore-c3"]));
  });

  it("a failed reorder restores the order and announces it", async () => {
    mockBackend({ fail: (url) => url === "/api/routines/r1/chores/order" });
    renderPage();
    await selectRoutine("r1");
    await screen.findByTestId("chore-c3");

    await keyboardDragFirstChoreDown();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Failed to save the new order. Please try again."
    );
    await waitFor(() => expect(choreOrder()).toEqual(["chore-c1", "chore-c2", "chore-c3"]));
  });
});

describe("RoutinesManagement — assignments", () => {
  async function openAssignments() {
    await selectRoutine("r1");
    fireEvent.click(screen.getByTestId("routine-assign"));
    return screen.findByTestId("assignment-dialog");
  }

  it("lists children only, and a brand-new assignment saves without confirmation", async () => {
    const calls = mockBackend();
    renderPage();
    const dialog = await openAssignments();

    expect(within(dialog).queryByText("Pat")).not.toBeInTheDocument();
    const row = within(dialog).getByTestId("routine-assignment-m1");
    fireEvent.click(within(row).getByRole("checkbox", { name: "Mon" }));
    fireEvent.click(within(row).getByRole("button", { name: "Save Assignment" }));

    await waitFor(() =>
      expect(callsTo(calls, "PUT", "/api/routines/r1/assignments/m1")[0]?.body).toEqual({
        weekdays: ["mon"],
        active: true,
      })
    );
    expect(screen.queryByTestId("routines-assignment-m1-save-confirm")).not.toBeInTheDocument();
  });

  it("changing an existing assignment asks for the streak confirmation", async () => {
    const calls = mockBackend({
      assignments: [{ id: "a1", memberId: "m1", weekdays: ["mon"], active: true }],
    });
    renderPage();
    const row = within(await openAssignments()).getByTestId("routine-assignment-m1");

    expect(within(row).getByRole("button", { name: "Save Assignment" })).toBeDisabled();
    fireEvent.click(within(row).getByRole("checkbox", { name: "Tue" }));
    fireEvent.click(within(row).getByRole("button", { name: "Save Assignment" }));
    fireEvent.click(await screen.findByTestId("routines-assignment-m1-save-cancel"));
    expect(callsTo(calls, "PUT", "/api/routines/r1/assignments/m1")).toHaveLength(0);

    fireEvent.click(within(row).getByRole("button", { name: "Save Assignment" }));
    fireEvent.click(await screen.findByTestId("routines-assignment-m1-save-confirm"));
    await waitFor(() =>
      expect(callsTo(calls, "PUT", "/api/routines/r1/assignments/m1")[0]?.body).toEqual({
        weekdays: ["mon", "tue"],
        active: true,
      })
    );
  });

  it("deactivates only after confirmation", async () => {
    const calls = mockBackend({
      assignments: [{ id: "a1", memberId: "m1", weekdays: ["mon"], active: true }],
    });
    renderPage();
    const row = within(await openAssignments()).getByTestId("routine-assignment-m1");

    fireEvent.click(within(row).getByRole("button", { name: "Deactivate" }));
    fireEvent.click(await screen.findByTestId("routines-assignment-m1-deactivate-cancel"));
    expect(callsTo(calls, "DELETE", "/api/routines/r1/assignments/m1")).toHaveLength(0);

    fireEvent.click(within(row).getByRole("button", { name: "Deactivate" }));
    fireEvent.click(await screen.findByTestId("routines-assignment-m1-deactivate-confirm"));
    await waitFor(() =>
      expect(callsTo(calls, "DELETE", "/api/routines/r1/assignments/m1")).toHaveLength(1)
    );
  });

  it("a deactivated assignment starts empty and re-saving it asks for confirmation", async () => {
    mockBackend({
      assignments: [{ id: "a1", memberId: "m1", weekdays: ["mon"], active: false }],
    });
    renderPage();
    const row = within(await openAssignments()).getByTestId("routine-assignment-m1");

    expect(within(row).getByRole("checkbox", { name: "Mon" })).not.toBeChecked();
    expect(within(row).queryByRole("button", { name: "Deactivate" })).not.toBeInTheDocument();
    fireEvent.click(within(row).getByRole("checkbox", { name: "Wed" }));
    fireEvent.click(within(row).getByRole("button", { name: "Save Assignment" }));
    expect(await screen.findByTestId("routines-assignment-m1-save-confirm")).toBeInTheDocument();
  });

  it("announces a failed assignment save inside the dialog", async () => {
    mockBackend({ fail: (url, method) => /\/assignments\/m1$/.test(url) && method === "PUT" });
    renderPage();
    const dialog = await openAssignments();
    const row = within(dialog).getByTestId("routine-assignment-m1");
    fireEvent.click(within(row).getByRole("checkbox", { name: "Mon" }));
    fireEvent.click(within(row).getByRole("button", { name: "Save Assignment" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Failed to update assignment."
    );
  });

  it("explains how to add a child when there is none", async () => {
    mockBackend({ members: [PARENT] });
    renderPage();
    expect(await openAssignments()).toHaveTextContent(
      "There are no children to assign yet. Add one in Members."
    );
  });
});

describe("RoutinesManagement — Spanish labels", () => {
  it("renders period groups, the page name, weekday labels and period options in Spanish", async () => {
    mockBackend({ language: "es", routines: [ROUTINE, ROUTINE_EVENING] });
    renderPage();

    expect(await screen.findByRole("heading", { level: 4, name: "Mañana" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 4, name: "Tarde" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Rutinas y tareas" })).toBeInTheDocument();

    await selectRoutine("r1");
    fireEvent.click(screen.getByTestId("routine-assign"));
    const row = await screen.findByTestId("routine-assignment-m1");
    expect(
      within(row)
        .getAllByRole("checkbox")
        .map((checkbox) => checkbox.closest("label")?.textContent?.trim())
    ).toEqual(["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]);
  });

  it("lists each period under its own Spanish label in the routine dialog", async () => {
    mockBackend({ language: "es" });
    renderPage();
    await screen.findByRole("heading", { level: 4, name: "Mañana" });
    fireEvent.click(screen.getByTestId("routines-new"));
    await screen.findByTestId("routine-form-dialog");

    fireEvent.click(screen.getByRole("combobox", { name: "Período del día" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["Mañana", "Mediodía", "Tarde"]);
  });
});

describe("RoutinesManagement — kiosk density (SC-001, SC-002, SC-003)", () => {
  it("meets kiosk density with a routine selected and with the assignment dialog open", async () => {
    mockBackend({
      assignments: [{ id: "a1", memberId: "m1", weekdays: ["mon"], active: true }],
    });
    const uninject = await injectDensityStyles({
      extraCandidates: ["size-[var(--control-height)]"],
    });
    document.documentElement.setAttribute("data-density", "kiosk");
    try {
      renderPage();
      await selectRoutine("r1");
      await screen.findByTestId("chore-c3");
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      fireEvent.click(screen.getByTestId("routine-assign"));
      await screen.findByTestId("routine-assignment-m1");
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("DELIBERATE NEGATIVE — forcing the New routine button below the kiosk minimum fails", async () => {
    mockBackend();
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");
    try {
      const { container } = renderPage();
      const button = await screen.findByTestId("routines-new");
      button.style.height = "10px";
      button.style.fontSize = "8px";

      let thrown: unknown;
      try {
        assertKioskDensityCompliant(container);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(DensityViolationError);
      expect((thrown as DensityViolationError).message).toMatch(
        /height 10px is below the kiosk minimum 48px/
      );

      button.style.height = "";
      button.style.fontSize = "";
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });
});
