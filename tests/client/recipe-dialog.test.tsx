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
});
