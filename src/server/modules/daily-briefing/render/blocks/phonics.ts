// phonics render-def: early-reader words printed in large letters (up to ~20mm), one word per
// line, with "sound buttons" underneath — a dot under each single-letter grapheme and a dash
// under each multi-letter grapheme (digraph/trigraph). Tricky words print without marks.
//
// Sizing relies on the theme's display face (JetBrains Mono Bold) being monospaced: every glyph
// advances exactly 600/1000 em, so a word of N letters is N × 0.6 × fontSize wide and each
// grapheme spans a known number of cells. createElement form (tsconfig has no jsx).
import { createElement, type ReactElement } from "react";
import { applyTextStyle, defineBlock, type BlockDefinition } from "pressedslip";
import { type ZodType, z } from "zod";

/** Advance width of every JetBrains Mono glyph, in em (hmtx 600 / unitsPerEm 1000). */
export const PHONICS_GLYPH_ADVANCE_EM = 0.6;
/** Font ceiling: 160px is ~20mm at 203dpi. On 80mm paper a 5-letter word fits at 176px, so every
 * word of up to five letters (99% of the corpus) prints at this same size and only longer words
 * shrink to fit. Without it a 3-letter word would fill the width at ~293px (~37mm). */
export const PHONICS_MAX_FONT_PX = 160;

const LINE_HEIGHT_EM = 1.2;
const MARK_GAP_EM = 0.04;
const DOT_EM = 0.13;
const DASH_THICKNESS_EM = 0.08;
const DASH_INSET_CELLS = 0.15;
const WORD_GAP_EM = 0.12;
const INK = "#000000";

interface PhonicsWord {
  word: string;
  graphemes: string[];
  tricky: boolean;
}

const schema: ZodType<{ words: PhonicsWord[] }> = z.object({
  words: z.array(
    z.object({ word: z.string(), graphemes: z.array(z.string()), tricky: z.boolean() })
  ),
});
export type PhonicsRenderData = z.infer<typeof schema>;

export interface PhonicsMark {
  kind: "dot" | "dash";
  width: number;
  height: number;
}

export interface PhonicsLayout {
  fontSize: number;
  cellWidth: number;
  words: Array<{ graphemes: string[]; cells: number[]; marks: PhonicsMark[] }>;
}

/** Largest font at which the longest word fits `contentWidth`, capped for very short words.
 * Integer maths (0.6 = 3/5) so the "fits, and one pixel more would not" boundary is exact. */
export function layoutPhonics(words: PhonicsWord[], contentWidth: number): PhonicsLayout {
  const longest = Math.max(1, ...words.map((w) => w.word.length));
  const fitted = Math.floor((5 * contentWidth) / (3 * longest));
  const fontSize = Math.max(1, Math.min(PHONICS_MAX_FONT_PX, fitted));
  const cellWidth = fontSize * PHONICS_GLYPH_ADVANCE_EM;
  const dot = Math.max(6, Math.round(fontSize * DOT_EM));
  const dashThickness = Math.max(4, Math.round(fontSize * DASH_THICKNESS_EM));

  return {
    fontSize,
    cellWidth,
    words: words.map((w) => {
      const cells = w.graphemes.map((g) => g.length);
      const marks: PhonicsMark[] = w.tricky
        ? []
        : cells.map((n) =>
            n === 1
              ? { kind: "dot", width: dot, height: dot }
              : {
                  kind: "dash",
                  width: Math.round(cellWidth * (n - 2 * DASH_INSET_CELLS)),
                  height: dashThickness,
                }
          );
      return { graphemes: w.graphemes, cells, marks };
    }),
  };
}

export const phonicsBlock: BlockDefinition<PhonicsRenderData> = defineBlock({
  type: "phonics",
  schema,
  render: ({ data, ctx }) => {
    const layout = layoutPhonics(data.words, ctx.contentWidth);
    const { fontSize, cellWidth } = layout;
    const letterStyle = {
      ...applyTextStyle(ctx.theme.textStyles.display, ctx.fontRoles),
      fontSize,
      lineHeight: LINE_HEIGHT_EM,
      color: INK,
      whiteSpace: "pre" as const,
      display: "flex",
      justifyContent: "center",
    };

    const wordRows: ReactElement[] = layout.words.map((word, wi) =>
      createElement(
        "div",
        {
          key: `w${wi}`,
          style: { display: "flex", flexDirection: "row", justifyContent: "center" },
        },
        ...word.graphemes.map((grapheme, gi) => {
          const mark = word.marks[gi];
          return createElement(
            "div",
            {
              key: `g${gi}`,
              style: {
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                width: word.cells[gi] * cellWidth,
              },
            },
            createElement("div", { style: letterStyle }, grapheme),
            mark
              ? createElement("div", {
                  style: {
                    marginTop: Math.round(fontSize * MARK_GAP_EM),
                    width: mark.width,
                    height: mark.height,
                    backgroundColor: INK,
                    borderRadius: mark.kind === "dot" ? mark.width / 2 : mark.height / 2,
                  },
                })
              : null
          );
        })
      )
    );

    return createElement(
      "div",
      {
        style: {
          width: "100%",
          display: "flex",
          flexDirection: "column",
          gap: Math.round(fontSize * WORD_GAP_EM),
          paddingBottom: Math.round(fontSize * WORD_GAP_EM),
        },
      },
      ...wordRows
    );
  },
  shell: { showTitle: true, separator: "thin", padding: "normal" },
});
