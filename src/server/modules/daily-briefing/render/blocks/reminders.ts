// PORTED from v1 `apps/api/src/blocks/reminders.tsx` — createElement form
// (tsconfig has no jsx; see message.ts for the general porting note).
// Reminders shares listBlock's group/item shape (same shape as the adapter's "reminders" case,
// render/adapter.ts) but implements its own render so it can prepend
// `ctx.theme.listItemBullet` to each item — pressedslip's own listBlock has no bullet-prefix
// option — and so one group can mix text items with `images` items (emoji reminders for
// pre-readers). An image item is drawn by pressedslip's built-in `imageBlock` render, unchanged:
// its only layout is a vertical column, so the emojis stack top to bottom. The adapter hands it
// PNGs (render/emoji-images.ts) so they are Floyd–Steinberg dithered for the 1-bit printer.
import { createElement } from "react";
import { defineBlock, imageBlock, type BlockDefinition } from "pressedslip";
import { z, type ZodType } from "zod";

/** Printed size of each reminder emoji: 224 dots, about 28 mm on the 576-dot (80 mm) slip, so a
 * pre-reader can make out the artwork's details once it is dithered to 1 bit. */
export const REMINDER_EMOJI_PX = 224;

export type RemindersData = {
  groups: {
    title?: string | undefined;
    separator?: string | undefined;
    items: {
      id?: string | undefined;
      value: string;
      /** PNG data URIs, in display order, for an `images` reminder (adapter-resolved). */
      images?: { src: string; alt?: string | undefined }[] | undefined;
    }[];
  }[];
};

const remindersSchema = z.object({
  groups: z
    .array(
      z.object({
        title: z.string().optional(),
        separator: z.string().optional(),
        items: z.array(
          z.object({
            id: z.string().optional(),
            value: z.string(),
            images: z
              .array(z.object({ src: z.string(), alt: z.string().optional() }))
              .min(1)
              .max(12)
              .optional(),
          })
        ),
      })
    )
    .min(1),
});

export const remindersBlock: BlockDefinition<RemindersData> = defineBlock({
  type: "reminders",
  schema: remindersSchema as unknown as ZodType<RemindersData>,
  render: ({ data, ctx }) => {
    const bullet = ctx.theme.listItemBullet;
    return createElement(
      "div",
      { style: { width: "100%", padding: 8, display: "flex", flexDirection: "column", gap: 8 } },
      data.groups.map((g, gi) =>
        createElement(
          "div",
          { key: gi, style: { display: "flex", flexDirection: "column", gap: 4 } },
          g.title ? createElement("div", { style: { fontWeight: 700 } }, g.title) : null,
          g.items.map((item, ii) =>
            item.images
              ? createElement(
                  "div",
                  { key: ii, style: { display: "flex", width: "100%" } },
                  imageBlock.render({
                    data: {
                      layout: "column",
                      fit: "none",
                      dither: "floyd-steinberg",
                      maxHeight: REMINDER_EMOJI_PX,
                      images: item.images.map((image) => ({
                        src: image.src,
                        alt: image.alt,
                        width: REMINDER_EMOJI_PX,
                        height: REMINDER_EMOJI_PX,
                      })),
                    },
                    ctx,
                  })
                )
              : createElement("div", { key: ii }, `${bullet} ${item.value}`)
          )
        )
      )
    );
  },
  shell: { showTitle: true, separator: "thin", padding: "compact" },
});
