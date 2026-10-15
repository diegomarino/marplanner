import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BriefingScheduleTab,
  scheduleSummary,
  type BriefingScheduleTabProps,
} from "@/daily-briefing/admin/BriefingScheduleTab";
import { BriefingAutomationCard } from "@/daily-briefing/admin/BriefingAutomationCard";
import { messages } from "@/i18n/messages";
import { Role, type MemberDTO } from "../../src/shared";

afterEach(cleanup);

const t = (key: keyof typeof messages.en) => messages.en[key];
const member = (id: string, name: string): MemberDTO => ({
  id,
  displayName: name,
  colorKey: "blue" as const,
  role: Role.child,
  lifecycle: "active" as const,
  createdAt: 1,
  updatedAt: 1,
  birthDate: null,
});

function renderTab(overrides: Partial<BriefingScheduleTabProps> = {}) {
  const props: BriefingScheduleTabProps = {
    members: [member("m-lisa", "Lisa"), member("m-bart", "Bart")],
    optIns: { "m-lisa": true },
    pendingOptInIds: new Set(),
    optInLocked: false,
    onOptInChange: vi.fn(),
    schedules: { "m-lisa": ["mon", "tue", "wed", "thu", "fri"] },
    automation: { generationTime: "06:00", autoPrintBound: false },
    onAutomationSaved: vi.fn(),
    date: null,
    today: "2026-10-15",
    onDateChange: vi.fn(),
    generatingAll: false,
    canGenerateAll: true,
    generateAllInfo: null,
    onGenerateAll: vi.fn(),
    results: null,
    onOpen: vi.fn(),
    weekStartDay: 1,
    ...overrides,
  };
  render(<BriefingScheduleTab {...props} />);
  return props;
}

describe("scheduleSummary", () => {
  const monFirst = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
  const sunFirst = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
  it("says every day, paused every day, or the days in display order", () => {
    expect(scheduleSummary(undefined, monFirst, t)).toBe("Every day");
    expect(scheduleSummary([], monFirst, t)).toBe("Paused every day");
    expect(scheduleSummary(["mon", "sun"], sunFirst, t)).toBe("Sun, Mon");
  });
});

describe("BriefingScheduleTab", () => {
  it("lists every member with the opt-in, days and open buttons", () => {
    const props = renderTab();
    expect(screen.getByRole("checkbox", { name: "Lisa: On" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Bart: On" })).not.toBeChecked();
    expect(screen.getByTestId("daily-briefing-member-days-m-lisa")).toHaveTextContent(
      "Mon, Tue, Wed, Thu, Fri"
    );
    expect(screen.getByTestId("daily-briefing-member-days-m-bart")).toHaveTextContent("—");
    fireEvent.click(screen.getByTestId("daily-briefing-opt-in-m-bart"));
    expect(props.onOptInChange).toHaveBeenCalledWith("m-bart", true);
    fireEvent.click(screen.getByRole("button", { name: "Open blocks for Bart" }));
    expect(props.onOpen).toHaveBeenCalledWith("m-bart", "blocks");
    fireEvent.click(screen.getByTestId("daily-briefing-open-briefings-m-lisa"));
    expect(props.onOpen).toHaveBeenCalledWith("m-lisa", "preview");
  });

  it("labels each cell for the stacked phone layout with its column name", () => {
    renderTab();
    expect(screen.getByTestId("daily-briefing-member-days-m-lisa")).toHaveAttribute(
      "data-label",
      "Days"
    );
    expect(screen.getByTestId("daily-briefing-member-status-m-lisa")).toHaveAttribute(
      "data-label",
      "Result for 2026-10-15"
    );
  });

  it("shows the household today in the date input and reports a new date", () => {
    const props = renderTab();
    const input = screen.getByTestId("daily-briefing-generate-date");
    expect(input).toHaveValue("2026-10-15");
    fireEvent.change(input, { target: { value: "2026-10-12" } });
    expect(props.onDateChange).toHaveBeenCalledWith("2026-10-12");
  });

  it("titles the result column with the date and shows each member's result", () => {
    renderTab({
      date: "2026-10-12",
      results: { date: "2026-10-12", statuses: { "m-lisa": "ready", "m-bart": "paused" } },
    });
    expect(screen.getByText("Result for 2026-10-12")).toBeVisible();
    expect(screen.getByTestId("daily-briefing-member-status-m-lisa")).toHaveTextContent("Ready");
    expect(screen.getByTestId("daily-briefing-member-status-m-bart")).toHaveTextContent("Paused");
  });

  it("hides results that belong to another date", () => {
    renderTab({
      date: "2026-10-13",
      results: { date: "2026-10-12", statuses: { "m-lisa": "ready" } },
    });
    expect(screen.getByTestId("daily-briefing-member-status-m-lisa")).toHaveTextContent("—");
  });

  it("disables Generate for all members when it cannot run, with the hint", () => {
    renderTab({ canGenerateAll: false, optIns: {} });
    expect(screen.getByTestId("daily-briefing-generate-all")).toBeDisabled();
    expect(screen.getByText("Turn on the daily briefing for a member below to generate.")).toBeVisible();
  });

  it("does not render the automation card until settings load", () => {
    renderTab({ automation: null, schedules: null });
    expect(screen.queryByTestId("daily-briefing-admin-settings-save")).toBeNull();
    expect(screen.getByTestId("daily-briefing-member-days-m-lisa")).toHaveTextContent("—");
  });
});

describe("BriefingAutomationCard", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

  it("enables Save only while a value differs from the stored one, then saves", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          generationTime: "07:30",
          autoPrintTrigger: "morning_complete",
          updatedAt: 1,
        }),
        { status: 200 }
      )
    );
    const onSaved = vi.fn();
    render(
      <BriefingAutomationCard
        stored={{ generationTime: "06:00", autoPrintBound: false }}
        onSaved={onSaved}
      />
    );
    const save = screen.getByTestId("daily-briefing-admin-settings-save");
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByTestId("daily-briefing-admin-generation-time"), {
      target: { value: "07:30" },
    });
    expect(save).toBeEnabled();
    fireEvent.change(screen.getByTestId("daily-briefing-admin-generation-time"), {
      target: { value: "06:00" },
    });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByTestId("daily-briefing-admin-generation-time"), {
      target: { value: "07:30" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Auto-print after morning chores" }));
    fireEvent.click(save);
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith({ generationTime: "07:30", autoPrintBound: true })
    );
    expect(JSON.parse(String(vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.body))).toEqual({
      generationTime: "07:30",
      autoPrintTrigger: "morning_complete",
    });
  });
});
