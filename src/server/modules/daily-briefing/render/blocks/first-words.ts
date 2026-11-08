// firstWords render-def: early-reader words printed as large as the paper allows, one word per
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
export const FIRST_WORDS_GLYPH_ADVANCE_EM = 0.6;
/** Ceiling for very short words (2-letter tricky words would otherwise reach ~440px). A 3-letter
 * CVC word on 80mm paper (~293px) still prints at full width. */
export const FIRST_WORDS_MAX_FONT_PX = 300;

const LINE_HEIGHT_EM = 1.2;
const MARK_GAP_EM = 0.04;
const DOT_EM = 0.13;
const DASH_THICKNESS_EM = 0.08;
const DASH_INSET_CELLS = 0.15;
const WORD_GAP_EM = 0.12;
const INK = "#000000";

interface FirstWordsWord {
  word: string;
  graphemes: string[];
  tricky: boolean;
}

const schema: ZodType<{ words: FirstWordsWord[] }> = z.object({
  words: z.array(
    z.object({ word: z.string(), graphemes: z.array(z.string()), tricky: z.boolean() })
  ),
});
export type FirstWordsRenderData = z.infer<typeof schema>;

export interface FirstWordsMark {
  kind: "dot" | "dash";
  width: number;
  height: number;
}

export interface FirstWordsLayout {
  fontSize: number;
  cellWidth: number;
  words: Array<{ graphemes: string[]; cells: number[]; marks: FirstWordsMark[] }>;
}

/** Largest font at which the longest word fits `contentWidth`, capped for very short words.
 * Integer maths (0.6 = 3/5) so the "fits, and one pixel more would not" boundary is exact. */
export function layoutFirstWords(words: FirstWordsWord[], contentWidth: number): FirstWordsLayout {
  const longest = Math.max(1, ...words.map((w) => w.word.length));
  const fitted = Math.floor((5 * contentWidth) / (3 * longest));
  const fontSize = Math.max(1, Math.min(FIRST_WORDS_MAX_FONT_PX, fitted));
  const cellWidth = fontSize * FIRST_WORDS_GLYPH_ADVANCE_EM;
  const dot = Math.max(6, Math.round(fontSize * DOT_EM));
  const dashThickness = Math.max(4, Math.round(fontSize * DASH_THICKNESS_EM));

  return {
    fontSize,
    cellWidth,
    words: words.map((w) => {
      const cells = w.graphemes.map((g) => g.length);
      const marks: FirstWordsMark[] = w.tricky
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

export const firstWordsBlock: BlockDefinition<FirstWordsRenderData> = defineBlock({
  type: "firstWords",
  schema,
  render: ({ data, ctx }) => {
    const layout = layoutFirstWords(data.words, ctx.contentWidth);
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
