// PORTED from v1 `apps/api/src/blocks/message.tsx`. v1's file used JSX
// (`<div>...</div>`) — this repo's server tsconfig (tsconfig.server.json)
// does not enable `jsx`/include `.tsx` under src/server, so the same
// element is built with `React.createElement` directly; the rendered
// output is identical (JSX is sugar for this same call).
//
// DAILY-MESSAGES-AC-07 fold: "Text stored verbatim;
// emoji/wrapping handled at render" — the generator (`modules/daily-briefing/blocks/message.ts`)
// freezes the snapshot's text RAW; THIS render-def is where emoji stripping belongs (print-time
// glyph safety — the thermal printer's font has no emoji glyphs). An emoji-only message strips
// down to an empty string, which still renders (a blank message body) — the block itself still
// exists in the printed briefing, per AC-07's point that an existing message always yields a
// block, regardless of what render-time sanitization does to its content.
import { createElement } from "react";
import { defineBlock, type BlockDefinition } from "pressedslip";
import { type ZodType, z } from "zod";

const schema: ZodType<{ text: string }> = z.object({ text: z.string() });
export type MessageData = z.infer<typeof schema>;

/** Strip pictographic emoji + variation selectors for glyph-safe printing (v1 parity:
 * `stripEmojis` from `@marplanner/shared`, no v2 equivalent exists yet — a local,
 * self-contained port of the same behavior, now applied at RENDER time per AC-07). */
function stripEmojis(s: string): string {
  return s
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/️/g, "")
    .trim();
}

export const messageBlock: BlockDefinition<MessageData> = defineBlock({
  type: "message",
  schema,
  render: ({ data }) =>
    createElement("div", { style: { width: "100%", padding: 8 } }, stripEmojis(data.text)),
  shell: { showTitle: true, separator: "thin", padding: "normal" },
});
