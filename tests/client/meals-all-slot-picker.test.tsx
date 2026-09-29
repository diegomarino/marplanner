import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MealsManagement } from "@/admin/MealsManagement";
import { LanguageProvider } from "@/i18n";

/** FR-002 regression (client-observable only — the server test cannot see the
 * picker): a recipe with absent/empty `slots` MUST be offered in the entry-authoring
 * recipe picker for EVERY slot, not silently vanish once a slot other than its
 * (nonexistent) tag is selected.
 */
describe("MealsManagement — entry-authoring all-slot picker (FR-002)", () => {
  beforeEach(() => {
    const mockFetch = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.includes("/api/settings")) {
        return Promise.resolve(
          new Response(JSON.stringify({ locale: { language: "en" } }), { status: 200 })
        );
      }
      if (url.startsWith("/api/recipes")) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                id: "r1",
                name: "Untagged Recipe",
                ingredients: null,
                instructions: null,
                slots: null,
                createdAt: 0,
                updatedAt: 0,
              },
            ]),
            { status: 200 }
          )
        );
      }
      if (url.startsWith("/api/menu")) {
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("offers a recipe with absent slots in every slot's picker", async () => {
    render(
      <LanguageProvider>
        <MealsManagement />
      </LanguageProvider>
    );

    const slotSelect = await screen.findByTestId("meals-entry-slot-select");

    for (const slot of ["breakfast", "lunch", "snack", "dinner"]) {
      fireEvent.change(slotSelect, { target: { value: slot } });

      await waitFor(() => {
        const recipeSelect = screen.getByTestId("meals-entry-recipe-select");
        expect(within(recipeSelect).getByText("Untagged Recipe")).toBeInTheDocument();
      });
    }
  });
});
