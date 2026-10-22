import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RecipeDialog } from "@/meals/RecipeDialog";
import { HouseholdSettingsProvider } from "@/lib/householdSettings";
import { LanguageProvider } from "@/i18n";

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("RecipeDialog", () => {
  it("normalizes the form at the UI seam and preserves values after a failed save", async () => {
    const onSave = vi.fn().mockResolvedValue(false);
    render(<RecipeDialog open mode="create" recipe={null} onClose={vi.fn()} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: " Steamed Hams " } });
    fireEvent.change(screen.getByLabelText("Ingredients"), {
      target: { value: "patties\n\nbuns" },
    });
    fireEvent.change(screen.getByLabelText("Instructions"), {
      target: { value: "Grill and assemble." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        name: "Steamed Hams",
        slots: undefined,
        ingredients: ["patties", "buns"],
        instructions: "Grill and assemble.",
      })
    );
    expect(screen.getByLabelText("Name")).toHaveValue(" Steamed Hams ");
  });
});

it("sends an explicit empty slots patch when an edited recipe is made valid for every slot", async () => {
  const onSave = vi.fn().mockResolvedValue(true);
  render(
    <RecipeDialog
      open
      mode="edit"
      recipe={{
        id: "recipe-1",
        name: "Soup",
        ingredients: null,
        instructions: null,
        slots: ["dinner"],
        createdAt: 0,
        updatedAt: 0,
      }}
      onClose={vi.fn()}
      onSave={onSave}
    />
  );

  fireEvent.click(screen.getByRole("checkbox", { name: "Dinner" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() =>
    expect(onSave).toHaveBeenCalledWith({
      name: "Soup",
      slots: [],
      ingredients: [],
      instructions: "",
    })
  );
});

it("localizes recipe field accessibility names from the household language", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ locale: { timezone: "UTC", weekStartDay: 1, language: "es" } })
        )
      )
    )
  );
  render(
    <HouseholdSettingsProvider>
      <LanguageProvider>
        <RecipeDialog open mode="create" recipe={null} onClose={vi.fn()} onSave={vi.fn()} />
      </LanguageProvider>
    </HouseholdSettingsProvider>
  );

  await waitFor(() => expect(screen.getByLabelText("Ingredientes")).toBeInTheDocument());
  expect(screen.getByLabelText("Instrucciones")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Cerrar" })).toBeInTheDocument();
});

it("grows a long field to its content and closes on request", async () => {
  const scrollHeight = vi
    .spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get")
    .mockReturnValue(240);
  const onClose = vi.fn();
  try {
    render(
      <RecipeDialog
        open
        mode="edit"
        recipe={{
          id: "recipe-2",
          name: "Stew",
          ingredients: ["a", "b", "c"],
          instructions: "Simmer for hours.",
          slots: null,
          createdAt: 0,
          updatedAt: 0,
        }}
        onClose={onClose}
        onSave={vi.fn()}
      />
    );
    // Height follows the content; the cap and the inner scroll are CSS on the field.
    expect(screen.getByLabelText("Ingredients")).toHaveStyle({ height: "242px" });
    expect(screen.getByLabelText("Instructions")).toHaveStyle({ height: "242px" });

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  } finally {
    scrollHeight.mockRestore();
  }
});

it("explains a missing name on the Name field, keeps the draft and saves once it is filled", async () => {
  const onSave = vi.fn().mockResolvedValue(true);
  const onClose = vi.fn();
  render(<RecipeDialog open mode="create" recipe={null} onClose={onClose} onSave={onSave} />);
  fireEvent.change(screen.getByLabelText("Ingredients"), { target: { value: "patties" } });
  fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Grill." } });

  for (const blank of ["", "   "]) {
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: blank } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const name = screen.getByLabelText("Name");
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription("Give the recipe a name before saving.");
  }
  expect(onSave).not.toHaveBeenCalled();
  expect(screen.queryByText("Failed to load meals data.")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Ingredients")).toHaveValue("patties");

  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Steamed Hams" } });
  expect(screen.getByLabelText("Name")).not.toHaveAttribute("aria-invalid");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: "Steamed Hams" }));
});

it("reports a failed save as a save failure, not a loading failure", async () => {
  const onSave = vi.fn().mockResolvedValue(false);
  render(<RecipeDialog open mode="create" recipe={null} onClose={vi.fn()} onSave={onSave} />);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Soup" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText(/The recipe could not be saved/)).toBeInTheDocument();
  expect(screen.queryByText("Failed to load meals data.")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Name")).toHaveValue("Soup");
});
