import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemberPills, type MemberPillsMember } from "@/components/MemberPills";
import { assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-density");
});

const MEMBERS: MemberPillsMember[] = [
  { id: "ada", displayName: "Ada", colorKey: "blue" },
  { id: "ben", displayName: "Ben", colorKey: "green" },
  { id: "cleo", displayName: "Cleo", colorKey: "pink" },
];

describe("MemberPills — multi (default)", () => {
  it("is a named group of checkboxes, one per member, in order", () => {
    render(<MemberPills members={MEMBERS} value={["ben"]} onChange={() => {}} groupLabel="Who" />);
    const boxes = within(screen.getByRole("group", { name: "Who" })).getAllByRole("checkbox");
    expect(boxes.map((b) => b.closest("label")?.textContent)).toEqual(["Ada", "Ben", "Cleo"]);
    expect(screen.getByRole("checkbox", { name: "Ben" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Ada" })).not.toBeChecked();
  });

  it("emits the selection in members order, not click order", () => {
    const onChange = vi.fn();
    render(
      <MemberPills
        members={MEMBERS}
        value={["cleo"]}
        onChange={onChange}
        groupLabel="Who"
        testIdPrefix="who"
      />
    );
    fireEvent.click(screen.getByTestId("who-ada"));
    expect(onChange).toHaveBeenCalledWith(["ada", "cleo"]);
  });

  it("removes a member that is already selected", () => {
    const onChange = vi.fn();
    render(
      <MemberPills members={MEMBERS} value={["ada", "ben"]} onChange={onChange} groupLabel="Who" />
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Ada" }));
    expect(onChange).toHaveBeenCalledWith(["ben"]);
  });

  it("keeps selected ids that are not shown", () => {
    const onChange = vi.fn();
    render(
      <MemberPills members={MEMBERS} value={["gone", "ben"]} onChange={onChange} groupLabel="Who" />
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Ada" }));
    expect(onChange).toHaveBeenCalledWith(["ada", "ben", "gone"]);
  });

  it("disables one member or the whole group", () => {
    const { rerender } = render(
      <MemberPills
        members={[MEMBERS[0], { ...MEMBERS[1], disabled: true }]}
        value={[]}
        onChange={() => {}}
        groupLabel="Who"
      />
    );
    expect(screen.getByRole("checkbox", { name: "Ada" })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: "Ben" })).toBeDisabled();
    rerender(
      <MemberPills members={MEMBERS} value={[]} onChange={() => {}} groupLabel="Who" disabled />
    );
    expect(screen.getByRole("checkbox", { name: "Ada" })).toBeDisabled();
  });

  it("draws an off member as a bordered, unselectable pill named with its marker", () => {
    const onChange = vi.fn();
    render(
      <MemberPills
        members={[MEMBERS[0], { ...MEMBERS[1], offLabel: "off" }]}
        value={[]}
        onChange={onChange}
        groupLabel="Who"
      />
    );
    const box = screen.getByRole("checkbox", { name: "Ben (off)" });
    expect(box).toBeDisabled();
    const pill = box.closest("label");
    expect(pill).not.toHaveClass("border-dashed");
    expect(pill).toHaveClass("bg-transparent", "border-border", "font-normal");
    expect(pill).not.toHaveClass("opacity-50");
    fireEvent.click(box);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("never returns an off member in onChange, even when it was selected", () => {
    const onChange = vi.fn();
    render(
      <MemberPills
        members={[MEMBERS[0], { ...MEMBERS[1], offLabel: "off" }]}
        value={["ben"]}
        onChange={onChange}
        groupLabel="Who"
      />
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Ada" }));
    expect(onChange).toHaveBeenCalledWith(["ada"]);
  });

  it("fills a selected member with their solid colour and white text, without a dot", () => {
    const { rerender } = render(
      <MemberPills members={MEMBERS} value={[]} onChange={() => {}} groupLabel="Who" />
    );
    const pill = () => screen.getByRole("checkbox", { name: "Ada" }).closest("label");
    expect(pill()?.getAttribute("style")).toContain("--color-member-blue-500");
    expect(pill()).toHaveClass("bg-muted", "text-muted-foreground", "border-transparent");
    expect(pill()?.querySelector("[aria-hidden='true'] .rounded-full")).toBeNull();
    rerender(
      <MemberPills members={MEMBERS} value={["ada"]} onChange={() => {}} groupLabel="Who" />
    );
    expect(pill()).toHaveClass(
      "has-[:checked]:bg-[var(--member-color)]",
      "has-[:checked]:text-member-avatar-foreground",
      "has-[:checked]:font-semibold"
    );
  });

  it("reserves the bold label width so selecting never shifts its neighbours", () => {
    render(<MemberPills members={MEMBERS} value={[]} onChange={() => {}} groupLabel="Who" />);
    const pill = screen.getByRole("checkbox", { name: "Ada" }).closest("label");
    const reserve = pill?.querySelector("[data-text='Ada']");
    expect(reserve).not.toBeNull();
    expect(reserve).toHaveClass("inline-grid", "after:font-semibold");
  });
});

describe("MemberPills — single", () => {
  it("is a named radiogroup and emits the chosen member id", () => {
    const onChange = vi.fn();
    render(
      <MemberPills
        mode="single"
        members={MEMBERS}
        value="ada"
        onChange={onChange}
        groupLabel="Preview"
        testIdPrefix="preview"
      />
    );
    const group = screen.getByRole("radiogroup", { name: "Preview" });
    expect(within(group).getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByTestId("preview-ada")).toBeChecked();
    fireEvent.click(screen.getByTestId("preview-cleo"));
    expect(onChange).toHaveBeenCalledWith("cleo");
  });

  it("cannot pick an off member", () => {
    const onChange = vi.fn();
    render(
      <MemberPills
        mode="single"
        members={[MEMBERS[0], { ...MEMBERS[1], offLabel: "off" }]}
        value="ada"
        onChange={onChange}
        groupLabel="Preview"
      />
    );
    const off = screen.getByRole("radio", { name: "Ben (off)" });
    expect(off).toBeDisabled();
    fireEvent.click(off);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("checks nothing when value is null", () => {
    render(
      <MemberPills
        mode="single"
        members={MEMBERS}
        value={null}
        onChange={() => {}}
        groupLabel="Preview"
      />
    );
    for (const radio of screen.getAllByRole("radio")) expect(radio).not.toBeChecked();
  });

  it("single mode isolates groups", () => {
    render(
      <>
        <MemberPills
          mode="single"
          members={MEMBERS}
          value="ada"
          onChange={() => {}}
          groupLabel="A"
        />
        <MemberPills
          mode="single"
          members={MEMBERS}
          value="ben"
          onChange={() => {}}
          groupLabel="B"
        />
      </>
    );
    const nameOf = (label: string) =>
      (
        within(screen.getByRole("radiogroup", { name: label })).getAllByRole(
          "radio"
        )[0] as HTMLInputElement
      ).name;
    expect(nameOf("A")).not.toBe(nameOf("B"));
  });
});

describe("MemberPills — density", () => {
  it.each(["multi", "single"] as const)("meets kiosk density in %s mode", async (mode) => {
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");
    try {
      const { container } = render(
        mode === "single" ? (
          <MemberPills
            mode="single"
            members={MEMBERS}
            value="ada"
            onChange={() => {}}
            groupLabel="Who"
          />
        ) : (
          <MemberPills members={MEMBERS} value={["ada"]} onChange={() => {}} groupLabel="Who" />
        )
      );
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });
});
