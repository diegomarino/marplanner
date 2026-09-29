import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MealEntryDialog } from "@/meals/MealEntryDialog";
import { HouseholdSettingsProvider } from "@/lib/householdSettings";
import { LanguageProvider } from "@/i18n";
import type { Recipe } from "../../src/shared";

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
  });
});
