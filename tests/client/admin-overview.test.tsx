import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminOverview } from "@/admin/AdminOverview";
import { AdminRoutes, adminBreadcrumb } from "@/admin/AdminRoutes";
import type { ClientLogRow, SystemStatus } from "../../src/shared";

const STATUS: SystemStatus = {
  status: "ok",
  checkedAt: "2026-10-13T13:20:15.000Z",
  build: { sha: "abc1234", subject: "fix: deliver briefings", builtAt: null },
};

function row(id: string, level: ClientLogRow["level"], receivedAt: number): ClientLogRow {
  return {
    id,
    eventId: id,
    eventTime: null,
    receivedAt,
    level,
    component: "event-bus",
    message: `message ${id}`,
    data: null,
  };
}

function mockBackend(options: { status?: unknown; statusCode?: number } = {}) {
  const fetchMock = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = String(input);
    if (url.includes("/api/telemetry/system-status")) {
      return new Response(JSON.stringify(options.status ?? STATUS), {
        status: options.statusCode ?? 200,
      });
    }
    if (url.includes("level=warn")) {
      return new Response(JSON.stringify({ rows: [row("w1", "warn", 100)], nextCursor: null }));
    }
    if (url.includes("level=error")) {
      return new Response(JSON.stringify({ rows: [row("e1", "error", 200)], nextCursor: null }));
    }
    return new Response(JSON.stringify({ plugins: [] }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("AdminOverview", () => {
  it("shows what the server runs and lists warnings and errors newest first", async () => {
    mockBackend();
    render(<AdminOverview sections={null} onOpenTelemetry={vi.fn()} />);

    expect(await screen.findByText("abc1234")).toBeInTheDocument();
    expect(screen.getByText("fix: deliver briefings")).toBeInTheDocument();
    // Neither the server (run from source) nor this test bundle was built.
    expect(screen.getAllByText("running from source")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "This device" })).toBeInTheDocument();

    const logs = within(await screen.findByTestId("admin-overview-logs")).getAllByRole("listitem");
    expect(logs.map((item) => item.textContent)).toEqual([
      expect.stringContaining("message e1"),
      expect.stringContaining("message w1"),
    ]);
  });

  it("reads the status again on Check now and opens telemetry on request", async () => {
    const fetchMock = mockBackend();
    const onOpenTelemetry = vi.fn();
    render(<AdminOverview sections={null} onOpenTelemetry={onOpenTelemetry} />);
    await screen.findByText("abc1234");
    const statusReads = () =>
      fetchMock.mock.calls.filter(([input]) => String(input).includes("system-status")).length;
    expect(statusReads()).toBe(1);

    fireEvent.click(screen.getByTestId("admin-overview-check"));
    await waitFor(() => expect(statusReads()).toBe(2));

    fireEvent.click(screen.getByRole("button", { name: "Open telemetry" }));
    expect(onOpenTelemetry).toHaveBeenCalledTimes(1);
  });

  it("announces an unreadable status without inventing a deploy", async () => {
    mockBackend({ status: [], statusCode: 200 });
    render(<AdminOverview sections={null} onOpenTelemetry={vi.fn()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not read the system status.");
    expect(screen.getByText("unreachable")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-overview-build-match")).not.toBeInTheDocument();
  });
});

describe("Admin shell navigation", () => {
  it("keeps Overview and Lock in the sidebar on every admin page", () => {
    const onLock = vi.fn();
    mockBackend();
    render(<AdminRoutes pathname="/admin/telemetry" onLock={onLock} />);

    const sidebar = within(screen.getByTestId("admin-sidebar"));
    expect(sidebar.getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/admin");
    expect(sidebar.getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current");
    fireEvent.click(sidebar.getByTestId("admin-lock-button"));
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it("marks Overview as the current page on the landing page and lists every section there", async () => {
    mockBackend();
    render(<AdminRoutes pathname="/admin" onLock={vi.fn()} />);

    expect(
      within(screen.getByTestId("admin-sidebar")).getByRole("link", { name: "Overview" })
    ).toHaveAttribute("aria-current", "page");
    expect(await screen.findByTestId("admin-nav-members-management")).toBeInTheDocument();
    expect(screen.getByTestId("admin-nav-calendar")).toBeInTheDocument();
  });

  it("builds the breadcrumb trail from every registered page on the way", () => {
    expect(adminBreadcrumb("/admin")).toEqual([]);
    expect(adminBreadcrumb("/admin/members").map((step) => step.path)).toEqual(["/admin/members"]);
    expect(adminBreadcrumb("/admin/not-a-page")).toEqual([]);
  });
});
