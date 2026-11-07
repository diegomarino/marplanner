import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { adaptBlockData } from "../../src/server/modules/daily-briefing/render/adapter";
import { REMINDER_EMOJI_PX } from "../../src/server/modules/daily-briefing/render/blocks/reminders";
import { renderBriefingBitmap } from "../../src/server/modules/daily-briefing/render/index";

/** Image reminders on the printed briefing (#96): one reminders group mixes text items with
 * `images` items; each emoji becomes a dithered PNG of its Noto artwork, stacked vertically by
 * pressedslip's built-in image block. */

const MIXED_GROUP = {
  groups: [
    {
      items: [
        { value: "Lleva la mochila" },
        { value: "Ballet", emojis: ["🩰"] },
        { value: "", emojis: ["🤸", "👟"] },
        { value: "Cepíllate los dientes" },
      ],
    },
  ],
};

function envelope(data: unknown) {
  return {
    memberId: "member-1",
    memberName: "Lucía",
    date: "2026-11-09",
    language: "es",
    blocks: [{ type: "reminders", title: "02 RECORDATORIOS", data }],
  };
}

function decode(png: Uint8Array): PNG {
  return PNG.sync.read(Buffer.from(png));
}

/** Rows (top to bottom) that hold at least one black pixel. */
function inkedRows(png: PNG): boolean[] {
  const rows: boolean[] = [];
  for (let y = 0; y < png.height; y++) {
    let inked = false;
    for (let x = 0; x < png.width && !inked; x++) {
      inked = png.data[(y * png.width + x) * 4] === 0;
    }
    rows.push(inked);
  }
  return rows;
}

describe("daily-briefing reminders block — image reminders", () => {
  it("adapts a mixed group: text items unchanged, image items to one PNG per emoji in order", () => {
    const adapted = adaptBlockData("reminders", MIXED_GROUP) as {
      groups: { items: { value: string; images?: { src: string; alt?: string }[] }[] }[];
    };
    const summary = adapted.groups[0]!.items.map((item) => ({
      value: item.value,
      images: item.images?.map((image) => ({
        alt: image.alt,
        src: `${image.src.slice(0, "data:image/png;base64,".length)}…`,
      })),
    }));
    expect(summary).toMatchInlineSnapshot(`
      [
        {
          "images": undefined,
          "value": "Lleva la mochila",
        },
        {
          "images": [
            {
              "alt": "Ballet",
              "src": "data:image/png;base64,…",
            },
          ],
          "value": "Ballet",
        },
        {
          "images": [
            {
              "alt": "🤸",
              "src": "data:image/png;base64,…",
            },
            {
              "alt": "👟",
              "src": "data:image/png;base64,…",
            },
          ],
          "value": "",
        },
        {
          "images": undefined,
          "value": "Cepíllate los dientes",
        },
      ]
    `);
  });

  it("skips an emoji the app no longer ships and falls back to text when none is left", () => {
    const adapted = adaptBlockData("reminders", {
      groups: [{ items: [{ value: "Unicornio", emojis: ["🦄"] }] }],
    }) as { groups: { items: { value: string; images?: unknown }[] }[] };
    expect(adapted.groups[0]!.items[0]).toEqual({ value: "Unicornio" });
  });

  it("renders the mixed group without failures, stacking each emoji vertically and dithered", async () => {
    const textOnly = await renderBriefingBitmap(
      envelope({
        groups: [{ items: [{ value: "Lleva la mochila" }, { value: "Cepíllate los dientes" }] }],
      })
    );
    const mixed = await renderBriefingBitmap(envelope(MIXED_GROUP));

    expect(mixed.failedRenderBlocks).toEqual([]);
    expect(mixed.unrenderedBlocks).toEqual([]);
    expect(mixed.bitmapPng).not.toBeNull();

    // Three emojis in one column add at least three printed emoji heights to the slip.
    expect(mixed.bitmapHeight! - textOnly.bitmapHeight!).toBeGreaterThanOrEqual(
      3 * REMINDER_EMOJI_PX
    );

    // Dithered artwork leaves ink across most of each emoji's rows (a plain 1-bit threshold of
    // the colour SVG left the pink ballet shoes almost blank).
    const textRows = inkedRows(decode(textOnly.bitmapPng!)).filter(Boolean).length;
    const mixedRows = inkedRows(decode(mixed.bitmapPng!)).filter(Boolean).length;
    expect(mixedRows - textRows).toBeGreaterThan(3 * REMINDER_EMOJI_PX * 0.6);
  });
});
