import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MealsManagement } from "@/admin/MealsManagement";
import { LanguageProvider } from "@/i18n";

/** Regression (verify-pr finding on): recipe edit must be able to CLEAR
 * `instructions`. Coalescing the cleared textarea draft to `undefined` (the
 * `x.trim || undefined` idiom, correct on CREATE where an absent key means
 * "not set") drops the `instructions` key from the PATCH body entirely on
 * EDIT. The server's partial-PATCH handler treats a missing key as
 * "unchanged" (`if (instructions !== undefined)`,
 * src/server/modules/meals/index.ts), so once a recipe has instructions they
 * become permanently unclearable through this form. The fix sends the empty
 * string, which the server's `normalizeInstructions` turns into `null`
 * (absent) — this test asserts the wire payload, not just the UI state, so
 * it fails under the `|| undefined` bug and passes once the PATCH body
 * carries `instructions: ""`.
 * `name`/`ingredients`/`slots` are asserted in the same PATCH (repo lesson:
 * verify each editable field's change-detection independently) — those were
 * already sent unconditionally, so they double as a no-regression check.
 */
describe("MealsManagement — recipe edit clears fields correctly (verify-pr #446)", () => {
  let patchBody: Record<string, unknown> | undefined;

  beforeEach(() => {
    patchBody = undefined;
    const mockFetch = vi.fn((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      if (url.includes("/api/settings")) {
        return Promise.resolve(
          new Response(JSON.stringify({ locale: { language: "en" } }), { status: 200 })
        );
      }
      if (url.startsWith("/api/menu")) {
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      }
      if (/\/api\/recipes\/[^/]+$/.test(url) && init?.method === "PATCH") {
        patchBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "r1",
              name: "Lentejas",
              ingredients: null,
              instructions: null,
              slots: null,
              createdAt: 0,
              updatedAt: 1,
            }),
            { status: 200 }
          )
        );
      }
      if (url.startsWith("/api/recipes")) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                id: "r1",
                name: "Lentejas",
                ingredients: ["Lentils", "Water"],
                instructions: "Boil the lentils.",
                slots: ["lunch", "dinner"],
                createdAt: 0,
                updatedAt: 0,
              },
            ]),
            { status: 200 }
          )
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("PATCHes instructions: '' (never omitted) and ingredients: [] when both are cleared", async () => {
    render(
      <LanguageProvider>
        <MealsManagement />
      </LanguageProvider>
    );

    fireEvent.click(await screen.findByRole("tab", { name: "Recipes" }));
    const editButton = await screen.findByRole("button", { name: "Edit" });
    fireEvent.click(editButton);

    const nameField = await screen.findByTestId("meals-recipe-edit-name");
    const ingredientsField = screen.getByTestId("meals-recipe-edit-ingredients");
    const instructionsField = screen.getByTestId("meals-recipe-edit-instructions");

    expect(nameField).toHaveValue("Lentejas");
    expect(ingredientsField).toHaveValue("Lentils\nWater");
    expect(instructionsField).toHaveValue("Boil the lentils.");

    fireEvent.change(ingredientsField, { target: { value: "" } });
    fireEvent.change(instructionsField, { target: { value: "" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(patchBody).toBeDefined();
    });

    expect(patchBody).toEqual({
      name: "Lentejas",
      ingredients: [],
      instructions: "",
      slots: ["lunch", "dinner"],
    });
  });
});
