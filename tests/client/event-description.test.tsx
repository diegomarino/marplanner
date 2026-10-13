import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EventDescription } from "@/calendar/EventDescription";

afterEach(cleanup);

describe("EventDescription", () => {
  it("keeps plain text as text and links a bare web address without its trailing full stop", () => {
    const { container } = render(
      <EventDescription text={"Round 10\nMore: https://example.test/matches. See you <there>"} />
    );

    const link = screen.getByRole("link", { name: "https://example.test/matches" });
    expect(link).toHaveAttribute("href", "https://example.test/matches");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(container).toHaveTextContent("Round 10 More: https://example.test/matches. See you");
  });

  it("rebuilds basic HTML from the allowlist", () => {
    const { container } = render(
      <EventDescription
        text={
          '<p>Bring <b>boots</b> and <em>a coat</em></p><ul><li>Map</li></ul><a href="https://example.test/x">Details</a>'
        }
      />
    );

    expect(container.querySelector("strong")).toHaveTextContent("boots");
    expect(container.querySelector("em")).toHaveTextContent("a coat");
    expect(screen.getByRole("listitem")).toHaveTextContent("Map");
    expect(screen.getByRole("link", { name: "Details" })).toHaveAttribute(
      "href",
      "https://example.test/x"
    );
  });

  it("drops scripts, styles, handlers, embedded frames and non-web link targets", () => {
    const { container } = render(
      <EventDescription
        text={
          '<p onclick="steal()" style="position:fixed">Hello</p><script>steal()</script>' +
          '<style>p{display:none}</style><iframe src="https://example.test"></iframe>' +
          '<img src="x" onerror="steal()"><a href="javascript:steal()">Click</a>' +
          '<div class="x"><span>kept text</span></div>'
        }
      />
    );

    expect(
      container.querySelectorAll("script, style, iframe, img, [onclick], [style]")
    ).toHaveLength(0);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(container).toHaveTextContent("HelloClickkept text");
    expect(container).not.toHaveTextContent("steal");
  });
});
