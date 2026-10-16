import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MealsManagement } from "@/admin/MealsManagement";
import { LanguageProvider } from "@/i18n";

/** FR-002 regression (client-observable only — the server test cannot see the
 * picker): a recipe with absent/empty `slots` MUST be offered in the plan card's
 * recurring-entry recipe picker for EVERY slot, not silently vanish once a slot other
 * than its (nonexistent) tag is selected.
 */
describe("MealsManagement — recurring-entry all-slot picker (FR-002)", () => {
  beforeEach(() => {
    const mockFetch = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.includes("/api/settings")) {
        return Promise.resolve(
          new Response(JSON.stringify({ locale: { timezone: "UTC", language: "en" } }), {
            status: 200,
          })
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
      if (/\/api\/meal-plans\/[^/]+\/entries$/.test(url)) {
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      }
      if (url.startsWith("/api/meal-plans")) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              { id: "p1", name: "Weeknights", active: true, createdAt: 0, updatedAt: 0 },
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

    fireEvent.click(await screen.findByTestId("meals-plan-add-recurring"));
    const slotSelect = screen.getByTestId("meals-recurring-slot-select");

    for (const slot of ["breakfast", "lunch", "snack", "dinner"]) {
      fireEvent.change(slotSelect, { target: { value: slot } });

      await waitFor(() => {
        const recipeSelect = screen.getByTestId("meals-recurring-recipe-select");
        expect(within(recipeSelect).getByText("Untagged Recipe")).toBeInTheDocument();
      });
    }
  });
});
