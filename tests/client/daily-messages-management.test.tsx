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

function member(): Member {
  return {
    id: "member-1",
    displayName: "Alex",
    colorKey: "blue",
    role: Role.child,
    lifecycle: "active",
    createdAt: 0,
    updatedAt: 0,
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

function renderManagement(messages: DailyMessage[] = []) {
  const mockFetch = vi.fn((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url === "/api/settings") {
      return Promise.resolve(jsonResponse({ locale: { timezone: "UTC", language: "en" } }));
    }
    if (url === "/api/members" && method === "GET") {
      return Promise.resolve(jsonResponse([member()]));
    }
    if (url.startsWith("/api/daily-messages?") && method === "GET") {
      return Promise.resolve(jsonResponse(messages));
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

  it("keeps the loaded editor visible when the active member is selected again", async () => {
    renderManagement([message()]);
    expect(await screen.findAllByTestId(/^daily-messages-day-/)).toHaveLength(14);

    fireEvent.change(screen.getByTestId("daily-messages-select-member"), {
      target: { value: "member-1" },
    });

    expect(screen.getAllByTestId(/^daily-messages-day-/)).toHaveLength(14);
    expect(screen.getByTestId("daily-messages-text-2026-01-15")).toHaveValue("Have a great day!");
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
