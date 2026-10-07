import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import expected from "../fixtures/assembly-cohort.json";
import { Shell } from "@/shell/Shell";
import { familyRoutes, resolveHouseholdRoute } from "@/shell/routes";
import { MembersManagement } from "@/admin/MembersManagement";
import { AdminUnlockProvider, useAdminUnlock } from "@/lib/adminUnlock";
import { LanguageProvider } from "@/i18n";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

function UnlockNow() {
  const { setUnlocked } = useAdminUnlock();
  useEffect(() => setUnlocked(true), [setUnlocked]);
  return <MembersManagement />;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.cookie = "mp_provisioned=; Max-Age=0; Path=/";
  window.history.replaceState(null, "", "/");
  document.documentElement.removeAttribute("data-density");
});

describe("B1 shell boundary", () => {
  it("matches the reviewed complete family and admin route cohort", () => {
    expect(expected.batch).toBe("BFULL");
    expect(expected.installedPluginIds).toHaveLength(9);
    expect(familyRoutes.map((route) => route.id)).toEqual(expected.familyRouteIds);
    expect(resolveHouseholdRoute("/admin")).toMatchObject({ kind: "admin", id: "member-create" });
    expect(resolveHouseholdRoute("/admin/members")).toMatchObject({ kind: "admin", id: "members" });
    for (const path of ["/calendar", "/chores", "/meals"]) {
      expect(resolveHouseholdRoute(path).kind).toBe("family");
    }
    for (const path of ["/weather", "/backups"]) {
      expect(resolveHouseholdRoute(path).kind).toBe("unknown-family");
    }
    expect(resolveHouseholdRoute("/admin/future").kind).toBe("unknown-admin");
  });

  it("keeps an unprovisioned direct admin route behind the gate without any request", async () => {
    window.history.replaceState(null, "", "/admin/members");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<Shell />);
    expect(await screen.findByTestId("provisioning-gate-panel")).toBeVisible();
    expect(screen.queryByTestId("admin-pin-keypad")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("mounts the protected member shell after provisioning and keeps admin PIN locked", async () => {
    document.cookie = "mp_provisioned=1; Path=/";
    window.history.replaceState(null, "", "/admin/members");
    const fetchMock = vi.fn((input: string | URL) => {
      if (String(input).includes("/api/settings")) {
        return Promise.resolve(
          json({ locale: { timezone: "Europe/Madrid", language: "en", weekStartDay: 1 } })
        );
      }
      if (String(input) === "/api/plugins")
        return Promise.resolve(json({ message: "Catalog unavailable" }, 503));
      if (
        [
          "/api/members?lifecycle=active",
          "/api/members?lifecycle=all",
          "/api/day-periods",
        ].includes(String(input)) ||
        String(input).startsWith("/api/calendar/events?") ||
        String(input).startsWith("/api/chores/board?")
      )
        return Promise.resolve(json([]));
      throw new Error(`unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Shell />);
    expect(await screen.findByTestId("admin-pin-keypad")).toBeVisible();
    expect(screen.queryByTestId("members-card-grid")).not.toBeInTheDocument();
    expect(screen.queryByTestId("provisioning-gate-panel")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input]) => String(input) === "/api/settings")
      ).toHaveLength(1)
    );
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain("/api/plugins");
  });

  it("offers member admin navigation when the plugin catalog is unavailable", async () => {
    document.cookie = "mp_provisioned=1; Path=/";
    const fetchMock = vi.fn((input: string | URL) => {
      if (String(input).includes("/api/settings")) {
        return Promise.resolve(
          json({ locale: { timezone: "Europe/Madrid", language: "en", weekStartDay: 1 } })
        );
      }
      if (String(input) === "/api/plugins")
        return Promise.resolve(json({ message: "Catalog unavailable" }, 503));
      if (
        [
          "/api/members?lifecycle=active",
          "/api/members?lifecycle=all",
          "/api/day-periods",
        ].includes(String(input)) ||
        String(input).startsWith("/api/calendar/events?") ||
        String(input).startsWith("/api/chores/board?")
      )
        return Promise.resolve(json([]));
      throw new Error(`unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Shell />);
    expect(await screen.findByTestId("home-surface")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Options" }));
    expect(screen.queryByTestId("density-control-toggle")).not.toBeInTheDocument();
    const affordance = screen.getByTestId("admin-affordance");
    fireEvent.pointerDown(affordance, { button: 1, pointerId: 1 });
    expect(affordance).toHaveAttribute("data-hold-state", "idle");
    fireEvent.pointerDown(affordance, { button: 0, pointerId: 1 });
    expect(affordance).toHaveAttribute("data-hold-state", "holding");
    fireEvent.pointerCancel(affordance, { pointerId: 1 });
    expect(affordance).toHaveAttribute("data-hold-state", "idle");
    fireEvent.keyDown(affordance, { key: "Enter", repeat: false });
    expect(affordance).toHaveAttribute("data-hold-state", "holding");
    fireEvent.keyUp(affordance, { key: "Enter" });
    expect(affordance).toHaveAttribute("data-hold-state", "idle");
    await new Promise((resolve) => setTimeout(resolve, 1));
    fireEvent.click(screen.getByTestId("admin-affordance"), { detail: 0 });
    expect(await screen.findByTestId("admin-pin-keypad")).toBeVisible();
    expect(window.location.pathname).toBe("/admin");
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === "/api/settings")
    ).toHaveLength(1);
  });

  it("renders an unknown family URL as a localized not-found surface", async () => {
    document.cookie = "mp_provisioned=1; Path=/";
    window.history.replaceState(null, "", "/unknown-family");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ locale: { language: "en" } })));
    render(<Shell />);
    expect(await screen.findByRole("heading", { name: /not found/i })).toBeVisible();
    expect(screen.queryByTestId("home-surface")).not.toBeInTheDocument();
  });

  it("edits, archives and restores a member through the protected management UI", async () => {
    let member = {
      id: "synthetic-member",
      displayName: "Ava",
      role: "parent",
      colorKey: "blue",
      lifecycle: "active",
      birthDate: null,
      createdAt: 1,
      updatedAt: 1,
    };
    const fetchMock = vi.fn((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      if (url === "/api/settings") return Promise.resolve(json({ locale: { language: "en" } }));
      if (url === "/api/members")
        return Promise.resolve(json(member.lifecycle === "active" ? [member] : []));
      if (url === "/api/members?lifecycle=archived")
        return Promise.resolve(json(member.lifecycle === "archived" ? [member] : []));
      if (url === "/api/members/synthetic-member" && init?.method === "PATCH") {
        member = { ...member, ...JSON.parse(String(init.body)) };
        return Promise.resolve(json(member));
      }
      if (url === "/api/members/synthetic-member/archive") {
        member = { ...member, lifecycle: "archived" };
        return Promise.resolve(json(member));
      }
      if (url === "/api/members/synthetic-member/restore") {
        member = { ...member, lifecycle: "active" };
        return Promise.resolve(json(member));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <LanguageProvider>
        <AdminUnlockProvider>
          <UnlockNow />
        </AdminUnlockProvider>
      </LanguageProvider>
    );
    const card = await screen.findByTestId("member-card-synthetic-member");
    fireEvent.click(within(card).getByRole("button", { name: "Edit" }));
    fireEvent.change(document.getElementById("member-edit-display-name")!, {
      target: { value: "Ava Edited" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(card).toHaveTextContent("Ava Edited"));
    fireEvent.click(within(card).getByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(screen.queryByTestId("member-card-synthetic-member")).not.toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    const archived = await screen.findByTestId("member-card-synthetic-member");
    expect(archived).toHaveTextContent("Ava Edited");
    fireEvent.click(within(archived).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(member.lifecycle).toBe("active"));
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain(
      "/api/members/synthetic-member/restore"
    );
  });
});
