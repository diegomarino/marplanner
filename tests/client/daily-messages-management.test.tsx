import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DailyMessagesManagement } from "@/admin/DailyMessagesManagement";
import { LanguageProvider } from "@/i18n";
import { HouseholdSettingsProvider } from "@/lib/householdSettings";
import { Role, type DailyMessage, type Member } from "../../src/shared";

const TODAY = "2026-01-15";

vi.mock("@/lib/household-date", () => ({
  todayInHouseholdTimezone: () => TODAY,
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status });
}

function member(overrides: Partial<Member> = {}): Member {
  return {
    id: "member-1",
    displayName: "Alex",
    colorKey: "blue",
    role: Role.child,
    lifecycle: "active",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function message(overrides: Partial<DailyMessage> = {}): DailyMessage {
  return {
    id: "message-1",
    memberId: "member-1",
    date: TODAY,
    text: "Have a great day!",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function renderManagement(
  messages: DailyMessage[] = [],
  options: {
    members?: Member[];
    weekStartDay?: 0 | 1;
    byMember?: Record<string, DailyMessage[]>;
  } = {}
) {
  const mockFetch = vi.fn((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url === "/api/settings") {
      return Promise.resolve(
        jsonResponse({
          locale: {
            timezone: "UTC",
            language: "en",
            ...(options.weekStartDay === undefined ? {} : { weekStartDay: options.weekStartDay }),
          },
        })
      );
    }
    if (url === "/api/members" && method === "GET") {
      return Promise.resolve(jsonResponse(options.members ?? [member()]));
    }
    if (url.startsWith("/api/daily-messages?") && method === "GET") {
      const memberId = new URL(url, "http://x").searchParams.get("memberId") ?? "";
      return Promise.resolve(jsonResponse(options.byMember?.[memberId] ?? messages));
    }
    if (url === "/api/daily-messages" && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as {
        memberId: string;
        date: string;
        text: string;
      };
      return Promise.resolve(jsonResponse(message(body)));
    }

    throw new Error(`unexpected fetch: ${url} (${method})`);
  });
  vi.stubGlobal("fetch", mockFetch);

  render(
    <HouseholdSettingsProvider>
      <LanguageProvider>
        <DailyMessagesManagement />
      </LanguageProvider>
    </HouseholdSettingsProvider>
  );

  return mockFetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("DailyMessagesManagement 14-day editor", () => {
  it("renders every household date from today through the next thirteen days", async () => {
    renderManagement([message()]);

    expect(await screen.findAllByTestId(/^daily-messages-day-/)).toHaveLength(14);
    expect(screen.getByTestId("daily-messages-text-2026-01-15")).toHaveValue("Have a great day!");
    expect(screen.getByTestId("daily-messages-text-2026-01-28")).toHaveValue("");
    expect(screen.getByText("2026-01-15 Thu")).toHaveAttribute(
      "for",
      "daily-messages-text-2026-01-15"
    );
  });

  it("upserts a changed non-empty row when its textarea loses focus", async () => {
    const mockFetch = renderManagement();
    const textarea = await screen.findByTestId("daily-messages-text-2026-01-16");

    fireEvent.change(textarea, { target: { value: "Tomorrow's note" } });
    fireEvent.blur(textarea);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/daily-messages",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            memberId: "member-1",
            date: "2026-01-16",
            text: "Tomorrow's note",
          }),
        })
      );
    });
  });

  it("preserves an existing note when its native textarea is cleared or blurred unchanged", async () => {
    const mockFetch = renderManagement([message()]);
    const textarea = await screen.findByTestId("daily-messages-text-2026-01-15");
    fireEvent.blur(textarea);
    fireEvent.change(textarea, { target: { value: "   " } });
    fireEvent.blur(textarea);
    await waitFor(() => expect(textarea).toHaveValue("Have a great day!"));
    expect(mockFetch.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
  });

  it("keeps the loaded editor visible when the checked member pill is clicked again", async () => {
    const mockFetch = renderManagement([message()]);
    expect(await screen.findAllByTestId(/^daily-messages-day-/)).toHaveLength(14);
    const callsBefore = mockFetch.mock.calls.length;

    fireEvent.click(screen.getByTestId("daily-messages-member-member-1"));

    expect(screen.getAllByTestId(/^daily-messages-day-/)).toHaveLength(14);
    expect(screen.getByTestId("daily-messages-text-2026-01-15")).toHaveValue("Have a great day!");
    expect(mockFetch.mock.calls.length).toBe(callsBefore);
  });

  it("selects members with pills, defaults to the first and loads the picked member's window", async () => {
    renderManagement([], {
      members: [member(), member({ id: "member-2", displayName: "Bo", colorKey: "green" })],
      byMember: { "member-2": [message({ id: "m2", memberId: "member-2", text: "Bo's note" })] },
    });
    expect(await screen.findAllByTestId(/^daily-messages-day-/)).toHaveLength(14);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Member" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Alex/ })).toBeChecked();

    fireEvent.click(screen.getByRole("radio", { name: /Bo/ }));

    await waitFor(() =>
      expect(screen.getByTestId("daily-messages-text-2026-01-15")).toHaveValue("Bo's note")
    );
    expect(screen.getByRole("radio", { name: /Bo/ })).toBeChecked();
  });

  it("moves through 14-day windows without allowing navigation before today", async () => {
    const mockFetch = renderManagement();
    expect(await screen.findAllByTestId(/^daily-messages-day-/)).toHaveLength(14);

    const previousButton = screen.getByTestId("daily-messages-previous-window");
    expect(previousButton).toBeDisabled();
    expect(screen.getByTestId("daily-messages-window-range")).toHaveTextContent(
      "2026-01-15 – 2026-01-28"
    );

    fireEvent.click(screen.getByTestId("daily-messages-next-window"));

    expect(await screen.findByTestId("daily-messages-day-2026-01-29")).toBeInTheDocument();
    expect(screen.getByTestId("daily-messages-day-2026-02-11")).toBeInTheDocument();
    expect(previousButton).toBeEnabled();
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/daily-messages?memberId=member-1&from=2026-01-29&days=14",
      { credentials: "include" }
    );

    fireEvent.click(previousButton);

    expect(await screen.findByTestId("daily-messages-day-2026-01-15")).toBeInTheDocument();
    expect(previousButton).toBeDisabled();
  });
});

describe("DailyMessagesManagement week zebra", () => {
  const bandOf = (date: string) =>
    screen.getByTestId(`daily-messages-day-${date}`).getAttribute("data-week-band");

  it("bands the 14 days by week from a Monday week start: plain, shaded, plain", async () => {
    renderManagement([], { weekStartDay: 1 });
    await screen.findAllByTestId(/^daily-messages-day-/);
    await waitFor(() => expect(bandOf("2026-01-19")).toBe("shaded"));
    expect(bandOf("2026-01-15")).toBe("plain");
    expect(bandOf("2026-01-18")).toBe("plain");
    expect(bandOf("2026-01-25")).toBe("shaded");
    expect(bandOf("2026-01-26")).toBe("plain");
    expect(screen.getByTestId("daily-messages-day-2026-01-19")).toHaveClass("bg-muted/50");
    expect(screen.getByTestId("daily-messages-day-2026-01-15")).not.toHaveClass("bg-muted/50");
  });

  it("bands from a Sunday week start", async () => {
    renderManagement([], { weekStartDay: 0 });
    await screen.findAllByTestId(/^daily-messages-day-/);
    await waitFor(() => expect(bandOf("2026-01-18")).toBe("shaded"));
    expect(bandOf("2026-01-17")).toBe("plain");
    expect(bandOf("2026-01-24")).toBe("shaded");
    expect(bandOf("2026-01-25")).toBe("plain");
  });
});

describe("DailyMessagesManagement load failures can be retried", () => {
  function stubFetch(handlers: { members: () => Response; messages: () => Response }) {
    const mockFetch = vi.fn((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/settings") {
        return Promise.resolve(jsonResponse({ locale: { timezone: "UTC", language: "en" } }));
      }
      if (url === "/api/members" && method === "GET") return Promise.resolve(handlers.members());
      if (url.startsWith("/api/daily-messages?") && method === "GET") {
        return Promise.resolve(handlers.messages());
      }
      throw new Error(`unexpected fetch: ${url} (${method})`);
    });
    vi.stubGlobal("fetch", mockFetch);
    render(
      <HouseholdSettingsProvider>
        <LanguageProvider>
          <DailyMessagesManagement />
        </LanguageProvider>
      </HouseholdSettingsProvider>
    );
    return mockFetch;
  }

  it("offers Retry when the members request fails and recovers on click", async () => {
    let membersFail = true;
    stubFetch({
      members: () => (membersFail ? jsonResponse(null, 500) : jsonResponse([member()])),
      messages: () => jsonResponse([]),
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to load daily messages.");
    expect(screen.queryByTestId("daily-messages-no-members")).not.toBeInTheDocument();

    membersFail = false;
    fireEvent.click(screen.getByTestId("daily-messages-retry"));

    expect(await screen.findAllByTestId(/^daily-messages-day-/)).toHaveLength(14);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByTestId("daily-messages-retry")).not.toBeInTheDocument();
  });

  it("hides the day editor and offers Retry when the messages request fails", async () => {
    let messagesFail = true;
    stubFetch({
      members: () => jsonResponse([member()]),
      messages: () => (messagesFail ? jsonResponse(null, 500) : jsonResponse([message()])),
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to load daily messages.");
    expect(screen.queryAllByTestId(/^daily-messages-day-/)).toHaveLength(0);

    messagesFail = false;
    fireEvent.click(screen.getByTestId("daily-messages-retry"));

    expect(await screen.findAllByTestId(/^daily-messages-day-/)).toHaveLength(14);
    expect(screen.getByTestId("daily-messages-text-2026-01-15")).toHaveValue("Have a great day!");
  });
});

describe("DailyMessagesManagement members response landing after unmount", () => {
  /** The members request stays pending until the test settles it, after unmounting the page. */
  function renderWithPendingMembers() {
    let resolveMembers!: (response: Response) => void;
    let rejectMembers!: (error: Error) => void;
    const members = new Promise<Response>((resolve, reject) => {
      resolveMembers = resolve;
      rejectMembers = reject;
    });
    const mockFetch = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url === "/api/settings")
        return Promise.resolve(jsonResponse({ locale: { timezone: "UTC", language: "en" } }));
      if (url === "/api/members") return members;
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", mockFetch);
    const view = render(
      <HouseholdSettingsProvider>
        <LanguageProvider>
          <DailyMessagesManagement />
        </LanguageProvider>
      </HouseholdSettingsProvider>
    );
    const requestedUrls = () => mockFetch.mock.calls.map(([input]) => String(input));
    return { members, resolveMembers, rejectMembers, requestedUrls, unmount: view.unmount };
  }

  /** Every continuation of the settled request is a microtask; one macrotask drains them all. */
  const drainMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("drops a members list that arrives after unmount without loading any messages", async () => {
    const page = renderWithPendingMembers();
    await waitFor(() => expect(page.requestedUrls()).toContain("/api/members"));
    page.unmount();

    const json = vi.fn(() => Promise.resolve([member()]));
    page.resolveMembers({ ok: true, status: 200, json } as unknown as Response);
    await waitFor(() => expect(json).toHaveBeenCalled());
    await drainMicrotasks();

    expect(page.requestedUrls().some((url) => url.startsWith("/api/daily-messages"))).toBe(false);
  });

  it("swallows a members failure that arrives after unmount", async () => {
    const page = renderWithPendingMembers();
    await waitFor(() => expect(page.requestedUrls()).toContain("/api/members"));
    page.unmount();

    page.rejectMembers(new Error("network down"));
    await page.members.catch(() => undefined);
    await drainMicrotasks();

    expect(page.requestedUrls().some((url) => url.startsWith("/api/daily-messages"))).toBe(false);
  });
});
