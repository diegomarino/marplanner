/** Field spec (FR-005 — Wiring).
 * Proves the label↔input↔error association Field exists to own: the label's `htmlFor` and the
 * control's `id` match, `aria-describedby` covers hint and error together, and `aria-invalid`
 * tracks error presence — none of which a call site has to compute itself.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Field } from "@/components/Field";
import { Input } from "@/components/ui/input";
import { assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-density");
});

describe("Field", () => {
  it("associates the label with the wrapped control via matching htmlFor/id", () => {
    render(
      <Field label="Display Name">
        <Input data-testid="name-input" />
      </Field>
    );
    const input = screen.getByTestId("name-input");
    const label = screen.getByText("Display Name");
    expect(label.tagName.toLowerCase()).toBe("label");
    expect(label).toHaveAttribute("for", input.id);
    expect(input.id).toBeTruthy();
  });

  it("wires the hint into aria-describedby when there is no error", () => {
    render(
      <Field label="Display Name" hint="Shown on the chores board.">
        <Input data-testid="name-input" />
      </Field>
    );
    const input = screen.getByTestId("name-input");
    const hint = screen.getByText("Shown on the chores board.");
    expect(input).toHaveAttribute("aria-describedby", hint.id);
    expect(input).not.toHaveAttribute("aria-invalid", "true");
  });

  it("sets aria-invalid and includes the error id in aria-describedby when an error is present", () => {
    render(
      <Field label="Display Name" hint="Shown on the chores board." error="Name is required.">
        <Input data-testid="name-input" />
      </Field>
    );
    const input = screen.getByTestId("name-input");
    const alert = screen.getByRole("alert");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input.getAttribute("aria-describedby")).toContain(alert.id);
    expect(alert).toHaveTextContent("Name is required.");
  });

  it("deliberate negative — no error means no aria-invalid and no rendered alert", () => {
    render(
      <Field label="Display Name">
        <Input data-testid="name-input" />
      </Field>
    );
    expect(screen.getByTestId("name-input")).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("deliberate negative — two Fields never collide on the same generated id (M5)", () => {
    render(
      <>
        <Field label="First Name">
          <Input data-testid="first-name-input" />
        </Field>
        <Field label="Last Name">
          <Input data-testid="last-name-input" />
        </Field>
      </>
    );
    const firstId = screen.getByTestId("first-name-input").id;
    const lastId = screen.getByTestId("last-name-input").id;
    expect(firstId).toBeTruthy();
    expect(lastId).toBeTruthy();
    expect(firstId).not.toBe(lastId);
  });

  it("meets kiosk density for the wrapped control", async () => {
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");
    try {
      const { container } = render(
        <Field label="Display Name">
          <Input data-testid="name-input" />
        </Field>
      );
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });
});
