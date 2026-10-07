import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { emojiToCodepoint, NotoEmoji } from "@/chores/noto-emoji";

afterEach(cleanup);

describe("emojiToCodepoint", () => {
  it("converts a single-codepoint emoji to its lowercase hex codepoint", () => {
    expect(emojiToCodepoint("🌅")).toBe("1f305");
  });

  it("strips the FE0F variation selector", () => {
    expect(emojiToCodepoint("🛏️")).toBe("1f6cf");
  });

  it("joins multi-codepoint sequences with underscores", () => {
    expect(emojiToCodepoint("👨‍👩‍👧")).toBe("1f468_200d_1f469_200d_1f467");
  });
});

describe("NotoEmoji", () => {
  it("renders an img sourced from the url map for a vendored emoji", () => {
    const { container } = render(
      <NotoEmoji emoji="🌅" urlMap={{ "1f305": "/noto/tasks/emoji_u1f305.svg" }} />
    );
    expect(container.querySelector("img")).toHaveAttribute("src", "/noto/tasks/emoji_u1f305.svg");
  });

  it("falls back to the literal Unicode glyph when the emoji is not vendored", () => {
    const { container } = render(<NotoEmoji emoji="📋" urlMap={{}} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("📋")).toBeInTheDocument();
  });
});
