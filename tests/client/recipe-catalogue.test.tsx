import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RecipeCatalogue } from "@/meals/RecipeCatalogue";
import type { Recipe } from "../../src/shared";

const recipe: Recipe = {
  id: "recipe-1",
  name: "Steamed Hams",
  ingredients: ["patties"],
  instructions: "Grill.",
  slots: ["lunch", "dinner"],
  createdAt: 0,
  updatedAt: 0,
};

afterEach(cleanup);

describe("RecipeCatalogue", () => {
  it("adapts the v1 divided catalogue with icon search, slot badges, and icon actions", () => {
    const onSearch = vi.fn();
    render(
      <RecipeCatalogue recipes={[recipe]} onSearch={onSearch} onCreate={vi.fn()} onEdit={vi.fn()} />
    );
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "ham" } });
    expect(onSearch).toHaveBeenCalledWith("ham");
    const catalogue = screen.getByTestId("recipe-catalogue");
    expect(catalogue).toHaveClass("lg:border-l");
    expect(screen.getByTestId("recipe-search-icon")).toBeInTheDocument();
    expect(screen.getByTestId("recipe-slot-badge-lunch")).toHaveTextContent("Lunch");
    expect(screen.getByTestId("recipe-slot-badge-dinner")).toHaveTextContent("Dinner");
    expect(screen.getAllByTestId("recipe-slot-icon")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "New Recipe" })).toBeInTheDocument();
    expect(screen.getByTestId("recipe-card-recipe-1")).toHaveClass("py-3");
    expect(screen.queryByRole("button", { name: "Delete Recipe" })).not.toBeInTheDocument();
  });

  it("says once that a recipe with no stored slots suits every meal", () => {
    render(
      <RecipeCatalogue
        recipes={[{ ...recipe, slots: null }]}
        onSearch={vi.fn()}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
      />
    );

    expect(screen.getAllByText("All meals")).toHaveLength(1);
    expect(screen.queryByTestId("recipe-slot-badge-lunch")).not.toBeInTheDocument();
  });

  it("gives every meal slot its own colour", () => {
    render(
      <RecipeCatalogue
        recipes={[{ ...recipe, slots: ["breakfast", "lunch", "snack", "dinner"] }]}
        onSearch={vi.fn()}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
      />
    );

    const colours = (["breakfast", "lunch", "snack", "dinner"] as const).map((slot) => {
      const badge = screen.getByTestId(`recipe-slot-badge-${slot}`);
      expect(badge).toHaveClass(`text-meal-${slot}`);
      return badge.className;
    });
    expect(new Set(colours).size).toBe(4);
  });

  it("opens the editable recipe from the card's detail action, not from its title", () => {
    render(
      <RecipeCatalogue recipes={[recipe]} onSearch={vi.fn()} onCreate={vi.fn()} onEdit={vi.fn()} />
    );

    // The title is a heading, not a control.
    expect(screen.getByRole("heading", { name: "Steamed Hams" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Steamed Hams" })).not.toBeInTheDocument();

    const open = screen.getByRole("button", { name: "Details: Steamed Hams" });
    expect(open).toHaveAttribute("title", "Details");
    fireEvent.click(open);

    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByLabelText("Name")).toHaveValue("Steamed Hams");
    expect(dialog.getByLabelText("Instructions")).toHaveValue("Grill.");
    expect(dialog.getByRole("checkbox", { name: "Lunch" })).toBeChecked();
    expect(dialog.getByRole("checkbox", { name: "Breakfast" })).not.toBeChecked();
  });
});
