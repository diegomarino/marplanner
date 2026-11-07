import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { RemindersBlock } from "@/daily-briefing/blockRenderers";
import { LanguageProvider } from "@/i18n";

afterEach(cleanup);

/** Image reminders on the on-screen briefing (#96): emoji items render as large Noto artwork in
 * the same list as text items, named by their description or, without one, by the emojis. */
it("renders text and image reminders side by side in one group, images large and named", () => {
  render(
    <LanguageProvider>
      <RemindersBlock
        data={{
          groups: [
            {
              items: [
                { id: "a", value: "Lleva la mochila" },
                { id: "b", value: "Ballet", emojis: ["🩰"] },
                { id: "c", value: "", emojis: ["🤸", "👟"] },
              ],
            },
          ],
        }}
      />
    </LanguageProvider>
  );

  const items = screen.getAllByRole("listitem");
  expect(items).toHaveLength(3);
  expect(items[0]).toHaveTextContent("Lleva la mochila");

  const ballet = within(items[1]!).getByRole("img", { name: "Ballet" });
  const sports = within(items[2]!).getByRole("img", { name: "🤸 👟" });
  for (const [group, count] of [
    [ballet, 1],
    [sports, 2],
  ] as const) {
    const artwork = group.querySelectorAll("img");
    expect(artwork).toHaveLength(count);
    for (const img of artwork) {
      expect(img).toHaveAttribute("width", "64");
      expect(img.getAttribute("src")).toMatch(/emoji_u/);
    }
  }
});
