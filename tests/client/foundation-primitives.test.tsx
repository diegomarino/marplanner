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
