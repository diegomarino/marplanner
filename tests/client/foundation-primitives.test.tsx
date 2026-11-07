import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CheckboxField } from "@/components/CheckboxField";
import { RadioField } from "@/components/RadioField";
import { Field } from "@/components/Field";
import { ErrorNotice } from "@/components/ErrorNotice";
import { StatusToggle } from "@/components/StatusToggle";
import { WeekdayPicker, type WeekdayLabels } from "@/components/WeekdayPicker";

const DAYS: WeekdayLabels = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("B0 foundation primitives", () => {
  it("renders the full card composition with visible title, description, action and footer", () => {
    render(
      <Card data-testid="card">
        <CardHeader>
          <CardTitle>Foundation</CardTitle>
          <CardDescription>Metadata</CardDescription>
          <CardAction>
            <Button>Act</Button>
          </CardAction>
        </CardHeader>
        <CardContent>Body</CardContent>
        <CardFooter>Footer</CardFooter>
      </Card>
    );
    expect(screen.getByTestId("card")).toHaveTextContent("FoundationMetadataActBodyFooter");
    expect(screen.getByRole("button", { name: "Act" })).toBeEnabled();
  });

  it("wires a field label, hint and error to its real control", () => {
    render(
      <Field id="household-name" label="Household name" hint="Required" error="Too short">
        <input type="text" />
      </Field>
    );
    const control = screen.getByRole("textbox", { name: "Household name" });
    expect(control).toHaveAttribute("aria-invalid", "true");
    expect(control).toHaveAttribute("aria-describedby", "household-name-hint household-name-error");
    expect(screen.getByRole("alert")).toHaveTextContent("Too short");
    expect(screen.getByText("Required")).toHaveAttribute("id", "household-name-hint");
  });

  it("renders no error live region when clear and supports polite notice when present", () => {
    const { rerender } = render(<ErrorNotice message={null} />);
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(<ErrorNotice message="Saved with warning" politeness="polite" />);
    expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "polite");
  });

  it("passes checkbox and radio changes through native labels while respecting disabled controls", () => {
    const onCheckbox = vi.fn();
    const onRadio = vi.fn();
    render(
      <>
        <CheckboxField checked={false} onChange={onCheckbox} label="Include" />
        <RadioField name="choice" value="A" checked={false} onChange={onRadio} label="Option A" />
        <RadioField
          name="choice"
          value="B"
          checked={true}
          onChange={onRadio}
          label="Option B"
          disabled
        />
      </>
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Include" }));
    fireEvent.click(screen.getByRole("radio", { name: "Option A" }));
    expect(onCheckbox).toHaveBeenCalledWith(true);
    expect(onRadio).toHaveBeenCalledWith("A");
    expect(screen.getByRole("radio", { name: "Option B" })).toBeDisabled();
  });

  it("keeps status name invariant, exposes pressed/busy state and blocks repeat press", () => {
    const onPress = vi.fn();
    const { rerender } = render(
      <StatusToggle pressed={false} label="Activate" accessibleName="Schedule" onPress={onPress} />
    );
    const control = screen.getByRole("button", { name: "Schedule" });
    expect(control).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(control);
    expect(onPress).toHaveBeenCalledTimes(1);
    rerender(
      <StatusToggle pressed label="Deactivate" accessibleName="Schedule" busy onPress={onPress} />
    );
    expect(control).toHaveAttribute("aria-pressed", "true");
    expect(control).toHaveAttribute("aria-busy", "true");
    fireEvent.click(control);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("uses canonical weekday order for multi selections and preserves the group name", () => {
    const onChange = vi.fn();
    render(
      <WeekdayPicker
        labels={DAYS}
        groupLabel="Weekdays"
        value={["wed", "mon"]}
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Tuesday" }));
    expect(onChange).toHaveBeenCalledWith(["mon", "tue", "wed"]);
    expect(screen.getByRole("group", { name: "Weekdays" })).toBeInTheDocument();
  });
});

it("scales the localized built-in dialog close in both densities and closes the portal", async () => {
  const { Dialog, DialogContent, DialogTitle, DialogDescription } =
    await import("@/components/ui/dialog");
  const { injectDensityStyles } = await import("./helpers/densityStyles");
  const { assertKioskDensityCompliant } = await import("./helpers/density");
  const uninject = await injectDensityStyles({ extraCandidates: ["text-control"] });
  try {
    const onOpenChange = vi.fn();
    render(
      <Dialog defaultOpen onOpenChange={onOpenChange}>
        <DialogContent closeLabel="Cerrar">
          <DialogTitle>Details</DialogTitle>
          <DialogDescription>Details description</DialogDescription>
        </DialogContent>
      </Dialog>
    );
    const close = screen.getByRole("button", { name: "Cerrar" });
    // Pin the GLYPH size, not just the box: `Button` renders an icon without an explicit size
    // at 16px, so the hit area would meet the kiosk minimum while the glyph shrank.
    expect(
      close.querySelector("svg")?.getAttribute("class") ?? "",
      "the close glyph must carry an explicit size- class or Button shrinks it to 16px"
    ).toMatch(/\bsize-6\b/);
    expect(getComputedStyle(close).fontSize).toBe("var(--control-font-size)");
    expect(getComputedStyle(close).height).toBe("var(--control-height)");
    expect(getComputedStyle(close).getPropertyValue("--control-height").trim()).toBe("36px");
    document.documentElement.setAttribute("data-density", "kiosk");
    assertKioskDensityCompliant(document.body);
    fireEvent.click(close);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  } finally {
    uninject();
    document.documentElement.removeAttribute("data-density");
  }
});

it("renders every interactive primitive in the density census and exposes new omissions", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { Input, Textarea } = await import("@/ui");
  const { injectDensityStyles } = await import("./helpers/densityStyles");
  const { assertKioskDensityCompliant, DensityViolationError } = await import("./helpers/density");
  const census = {
    "button.tsx": "foundation-primitives.test.tsx",
    "input.tsx": "foundation-primitives.test.tsx",
    "textarea.tsx": "foundation-primitives.test.tsx",
    "dialog.tsx": "foundation-primitives.test.tsx",
    "select.tsx": "select-item-density.test.tsx",
    "card.tsx": "Noninteractive layout; covered by card composition above",
    "label.tsx": "Noninteractive caption; native label association belongs to Field",
  };
  expect(
    readdirSync("src/client/components/ui")
      .filter((file) => file.endsWith(".tsx"))
      .sort()
  ).toEqual(Object.keys(census).sort());
  expect(readFileSync("tests/client/select-item-density.test.tsx", "utf8")).toContain(
    "assertKioskDensityCompliant"
  );
  const uninject = await injectDensityStyles();
  try {
    render(
      <>
        <Button>Act</Button>
        <Input aria-label="Name" />
        <Textarea aria-label="Notes" />
      </>
    );
    document.documentElement.setAttribute("data-density", "kiosk");
    assertKioskDensityCompliant(document.body);
    const notes = screen.getByRole("textbox", { name: "Notes" });
    notes.style.minHeight = "10px";
    notes.style.height = "10px";
    notes.style.fontSize = "8px";
    expect(() => assertKioskDensityCompliant(document.body)).toThrow(DensityViolationError);
    notes.removeAttribute("style");
    document.documentElement.removeAttribute("data-density");
    expect(getComputedStyle(notes).getPropertyValue("--control-height").trim()).toBe("36px");
    expect(getComputedStyle(notes).getPropertyValue("--control-font-size").trim()).toBe("14px");
  } finally {
    uninject();
    document.documentElement.removeAttribute("data-density");
  }
});
