// PORTED from v1 `apps/api/src/blocks/word-search.ts`.
//
// pressedslip's built-in wordSearchBlock draws grid borders using
// `ctx.theme.wordSearchBorderColor`, falling back to `separatorColor` when
// unset. The Marplanner theme (render/theme.ts) sets `separatorColor` to
// "#b8b0a0" (warm gray) which is invisible after 1-bit thermal binarization
// (threshold 128; that gray's luminance is ~177, above threshold => white).
// This wrapper SUBCLASSES the builtin — spreads it and overrides only the
// grid border color seen by `render` so grid lines always print solid
// black, while every other rendering detail (cell sizing, word-list layout)
// stays pressedslip's own.
import { wordSearchBlock as pressedslipWordSearchBlock } from "pressedslip";
import type { BlockDefinition, WordSearchData } from "pressedslip";

export const wordSearchBlock: BlockDefinition<WordSearchData> = {
  ...pressedslipWordSearchBlock,
  render: ({ data, ctx }) =>
    pressedslipWordSearchBlock.render({
      data,
      ctx: {
        ...ctx,
        theme: {
          ...ctx.theme,
          separatorColor: "#000000",
          wordSearchBorderColor: "#000000",
        },
      },
    }),
};
