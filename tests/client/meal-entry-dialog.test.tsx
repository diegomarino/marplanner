import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MealEntryDialog } from "@/meals/MealEntryDialog";
import { HouseholdSettingsProvider } from "@/lib/householdSettings";
import { LanguageProvider } from "@/i18n";
import type { MealPlan, Recipe } from "../../src/shared";

const recipes: Recipe[] = [
  {
    id: "recipe-1",
    name: "Pizza",
    ingredients: null,
    instructions: null,
    slots: ["dinner"],
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "recipe-all",
    name: "Fruit",
    ingredients: null,
    instructions: null,
    slots: null,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "recipe-breakfast",
    name: "Toast",
    ingredients: null,
    instructions: null,
    slots: ["breakfast"],
    createdAt: 0,
    updatedAt: 0,
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("MealEntryDialog", () => {
  it("keeps submit disabled with localized guidance until recipe or note content is present", () => {
    render(
      <MealEntryDialog
        open
        target={{ date: "2026-09-25", slot: "dinner" }}
        recipes={recipes}
        onClose={vi.fn()}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Add Entry" })).toBeDisabled();
    expect(screen.getByText("Select a recipe or enter a note.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Note" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), { target: { value: "Soup" } });
    expect(screen.getByRole("button", { name: "Add Entry" })).toBeEnabled();
  });

  it("creates a one-off recipe entry for the selected date and slot", async () => {
    const onCreate = vi.fn().mockResolvedValue(true);
    render(
      <MealEntryDialog
        open
        target={{ date: "2026-09-25", slot: "dinner" }}
        recipes={recipes}
        onClose={vi.fn()}
        onCreate={onCreate}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Recipe" }), {
      target: { value: "recipe-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Entry" }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({
        kind: "oneoff",
        date: "2026-09-25",
        slot: "dinner",
        recipeId: "recipe-1",
      })
    );
  });

  it("prepopulates note edits, filters slots, and does not make date or slot editable", () => {
    const onEdit = vi.fn();
    render(
      <MealEntryDialog
        open
        target={{
          date: "2026-09-25",
          slot: "dinner",
          item: {
            entryId: "entry-1",
            slot: "dinner",
            label: "Takeout",
            isTombstone: false,
            source: "oneoff",
            planId: null,
            recipeId: null,
            note: "Takeout",
          },
        }}
        recipes={recipes}
        onClose={vi.fn()}
        onCreate={vi.fn()}
        onEdit={onEdit}
        onDelete={vi.fn()}
      />
    );
    expect(screen.getByDisplayValue("Takeout")).toBeInTheDocument();
    expect(screen.queryByLabelText("Date")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Slot")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Recipe" }));
    expect(screen.getByRole("option", { name: "Pizza" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Fruit" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Toast" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Note" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onEdit).toHaveBeenCalledWith("entry-1", { note: "Takeout" });
  });

  it("localizes note and delete accessible names from the household language", async () => {
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
          <MealEntryDialog
            open
            target={{
              date: "2026-09-25",
              slot: "dinner",
              item: {
                entryId: "entry-1",
                slot: "dinner",
                label: "Takeout",
                isTombstone: false,
                source: "oneoff",
                planId: null,
                recipeId: "recipe-1",
                note: null,
              },
            }}
            recipes={recipes}
            onClose={vi.fn()}
            onCreate={vi.fn()}
            onEdit={vi.fn()}
            onDelete={vi.fn()}
          />
        </LanguageProvider>
      </HouseholdSettingsProvider>
    );

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Receta" })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("radio", { name: "Nota" }));
    expect(screen.getByRole("textbox", { name: "Nota" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Eliminar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cerrar" })).toBeInTheDocument();
  });

  const ACTIVE_PLAN: MealPlan = {
    id: "p1",
    name: "Weeknights",
    active: true,
    createdAt: 0,
    updatedAt: 0,
  };
  const INACTIVE_PLAN: MealPlan = {
    id: "p2",
    name: "Summer",
    active: false,
    createdAt: 0,
    updatedAt: 0,
  };

  function renderCreate(
    plans: MealPlan[] | undefined,
    onCreate = vi.fn().mockResolvedValue(true),
    date = "2026-09-25"
  ) {
    render(
      <MealEntryDialog
        open
        target={{ date, slot: "dinner" }}
        recipes={recipes}
        plans={plans}
        onClose={vi.fn()}
        onCreate={onCreate}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    return onCreate;
  }

  it("shows no Repeat choice without plans (family board unchanged)", () => {
    renderCreate(undefined);
    expect(screen.queryByRole("radiogroup", { name: "Repeat" })).not.toBeInTheDocument();
  });

  it("creates a recurring entry in the chosen active plan for the date's weekday", async () => {
    const onCreate = renderCreate([ACTIVE_PLAN, INACTIVE_PLAN]);
    const repeat = screen.getByRole("radiogroup", { name: "Repeat" });
    expect(within(repeat).getByRole("radio", { name: "Only this date" })).toBeChecked();
    fireEvent.click(within(repeat).getByRole("radio", { name: "Every Friday" }));
    // Only active plans are offered; the single active one is preselected.
    const planSelect = screen.getByRole("combobox", { name: "Meal Plan" });
    expect(planSelect).toHaveValue("p1");
    expect(within(planSelect).queryByText("Summer")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Note" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), {
      target: { value: "Pizza night" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Entry" }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({
        kind: "recurring",
        mealPlanId: "p1",
        weekday: "fri",
        slot: "dinner",
        note: "Pizza night",
      })
    );
  });

  it("derives the weekday from the date itself, Sunday included", async () => {
    const onCreate = renderCreate([ACTIVE_PLAN], undefined, "2026-09-27");
    fireEvent.click(screen.getByRole("radio", { name: "Every Sunday" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Recipe" }), {
      target: { value: "recipe-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Entry" }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "recurring", weekday: "sun", recipeId: "recipe-1" })
      )
    );
  });

  it("disables weekly repeat with a hint when no plan is active", () => {
    renderCreate([INACTIVE_PLAN]);
    expect(screen.getByRole("radio", { name: "Every Friday" })).toBeDisabled();
    expect(
      screen.getByText("Activate a meal plan to repeat this meal every week.")
    ).toBeInTheDocument();
  });

  it("does not offer Repeat when editing an entry", () => {
    render(
      <MealEntryDialog
        open
        target={{
          date: "2026-09-25",
          slot: "dinner",
          item: {
            entryId: "e1",
            slot: "dinner",
            label: "Soup",
            isTombstone: false,
            source: "recurring",
            planId: "plan-1",
            recipeId: null,
            note: "Soup",
          },
        }}
        recipes={recipes}
        plans={[ACTIVE_PLAN]}
        onClose={vi.fn()}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    expect(screen.queryByRole("radiogroup", { name: "Repeat" })).not.toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("This changes every matching week.");
  });
});
