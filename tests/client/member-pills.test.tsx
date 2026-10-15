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

  it("names an inactive member with its marker and draws it dashed", () => {
    render(
      <MemberPills
        members={[{ ...MEMBERS[0], inactiveLabel: "inactive" }]}
        value={[]}
        onChange={() => {}}
        groupLabel="Who"
      />
    );
    const box = screen.getByRole("checkbox", { name: "Ada (inactive)" });
    expect(box.closest("label")).toHaveClass("border-dashed");
  });

  it("wears the member's colour only while selected", () => {
    const { rerender } = render(
      <MemberPills members={MEMBERS} value={[]} onChange={() => {}} groupLabel="Who" />
    );
    const pill = () => screen.getByRole("checkbox", { name: "Ada" }).closest("label");
    expect(pill()).not.toHaveAttribute("style");
    rerender(
      <MemberPills members={MEMBERS} value={["ada"]} onChange={() => {}} groupLabel="Who" />
    );
    expect(pill()?.getAttribute("style")).toContain("--color-member-blue-500");
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
