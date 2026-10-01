import { describe, expect, it } from "vitest";
import { memberEventStyle } from "@/calendar/member-event-style";

describe("memberEventStyle", () => {
  it("keeps unassigned events neutral", () => {
    expect(memberEventStyle([])).toEqual({});
  });

  it("uses a soft surface and identity border for one member", () => {
    expect(memberEventStyle(["rose"])).toEqual({
      "--member-event-background":
        "color-mix(in oklch, var(--color-member-rose-500) 22%, var(--member-mix-ground))",
      "--member-event-border": "var(--color-member-rose-500)",
    });
  });

  it("uses ordered diagonal bands for distinct member colours", () => {
    const style = memberEventStyle(["rose", "blue", "rose"]);
    expect(style["--member-event-border"]).toBe("var(--color-member-rose-500)");
    expect(style["--member-event-background"]).toContain("repeating-linear-gradient(135deg");
    expect(style["--member-event-background"]).toContain("var(--color-member-rose-500)");
    expect(style["--member-event-background"]).toContain("var(--color-member-blue-500)");
    expect(style["--member-event-background"]?.match(/member-rose-500/g)).toHaveLength(1);
  });
});
