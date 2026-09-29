// PORTED from v1 `apps/api/src/blocks/drawing-prompt.tsx` — createElement
// form (tsconfig has no jsx; see message.ts for the general porting note).
import { createElement } from "react";
import { defineBlock, type BlockDefinition } from "pressedslip";
import { type ZodType, z } from "zod";

const schema: ZodType<{ prompt: string; requiresDrawingSpace: true }> = z.object({
  prompt: z.string(),
  requiresDrawingSpace: z.literal(true),
});
export type DrawingPromptData = z.infer<typeof schema>;

/** 300px ≈ 3.8cm on 80mm thermal paper — surface for a 4-7yo to actually draw.
 * See sp8b spec section "Block updates" for the original layout constraints.
 */
const DRAWING_SPACE_PX = 300;

export const drawingPromptBlock: BlockDefinition<DrawingPromptData> = defineBlock({
  type: "drawingPrompt",
  schema,
  render: ({ data }) =>
    createElement(
      "div",
      { style: { width: "100%", padding: 8, display: "flex", flexDirection: "column", gap: 8 } },
      createElement(
        "div",
        { style: { display: "flex", width: "100%", lineHeight: 1.4 } },
        data.prompt
      ),
      createElement(
        "div",
        {
          style: {
            display: "flex",
            width: "100%",
            height: DRAWING_SPACE_PX,
            border: "2px dashed black",
          },
        },
        createElement("div", { style: { display: "flex" } })
      )
    ),
  shell: { showTitle: true, separator: "thin", padding: "normal" },
});
