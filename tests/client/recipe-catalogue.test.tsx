import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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
    expect(screen.getByRole("button", { name: "Edit" })).toHaveAttribute("title", "Edit");
    expect(screen.getByTestId("recipe-card-recipe-1")).toHaveClass("py-3");
    expect(screen.queryByRole("button", { name: "Delete Recipe" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Steamed Hams" }));
    expect(screen.getByText("Grill.")).toBeInTheDocument();
  });
});
