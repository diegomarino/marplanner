// PORTED from v1 `apps/api/src/blocks/word-of-day.tsx` — createElement form
// (tsconfig has no jsx; see message.ts for the general porting note).
import { createElement } from "react";
import { applyTextStyle, defineBlock, type BlockDefinition } from "pressedslip";
import { type ZodType, z } from "zod";

const schema: ZodType<{
  word: string;
  type: string;
  definition: string;
  example?: string | null;
  pronunciation?: string;
}> = z.object({
  word: z.string(),
  type: z.string(),
  definition: z.string(),
  example: z.string().nullable().optional(),
  pronunciation: z.string().optional(),
});
export type WordOfDayData = z.infer<typeof schema>;

const IPA_ASCII: Record<string, string> = {
  ɑ: "a",
  æ: "a",
  ʌ: "u",
  ə: "e",
  ɛ: "e",
  ɜ: "er",
  ɚ: "er",
  ɝ: "er",
  ɪ: "i",
  i: "i",
  ʊ: "u",
  u: "u",
  ɔ: "o",
  ɒ: "o",
  θ: "th",
  ð: "th",
  ʃ: "sh",
  ʒ: "zh",
  ŋ: "ng",
  ː: "",
};

function asciiPronunciation(input: string): string {
  let out = "";
  let stress = false;
  for (const ch of input) {
    if (ch === "ˈ" || ch === "ˌ") {
      if (out.length > 0 && !out.endsWith("/") && !out.endsWith("-")) out += "-";
      stress = true;
      continue;
    }
    if (ch === "." || ch === "·" || ch === " " || ch === "-") {
      if (!out.endsWith("/") && !out.endsWith("-")) out += "-";
      stress = false;
      continue;
    }

    const mapped = IPA_ASCII[ch] ?? ch;
    out += stress ? mapped.toUpperCase() : mapped;
  }

  return out.replace(/-+\//g, "/").replace(/\/-+/g, "/").replace(/-+/g, "-");
}

/** Per ADR-0026 § Application (v1):
 * word → display
 * type → label
 * definition → body (cascade — no explicit applyTextStyle)
 * example → emphasis (when present)
 * pronunciation → extras.pronunciation (when present)
 */
export const wordOfDayBlock: BlockDefinition<WordOfDayData> = defineBlock({
  type: "wordOfDay",
  schema,
  render: ({ data, ctx }) => {
    const t = ctx.theme.textStyles;
    const hasExample = data.example !== null && data.example !== undefined && data.example !== "";
    const pronunciation = data.pronunciation ?? "";
    const hasPronunciation = pronunciation !== "";
    return createElement(
      "div",
      { style: { width: "100%", padding: 8, display: "flex", flexDirection: "column", gap: 6 } },
      createElement("div", { style: applyTextStyle(t.display, ctx.fontRoles) }, data.word),
      createElement(
        "div",
        { style: { ...applyTextStyle(t.label, ctx.fontRoles), alignSelf: "flex-end" } },
        data.type
      ),
      createElement("div", null, data.definition),
      hasExample
        ? createElement("div", { style: applyTextStyle(t.emphasis, ctx.fontRoles) }, data.example)
        : null,
      hasPronunciation
        ? createElement(
            "div",
            {
              style: {
                ...applyTextStyle(t.extras?.pronunciation ?? {}, ctx.fontRoles),
                alignSelf: "flex-end",
              },
            },
            asciiPronunciation(pronunciation)
          )
        : null
    );
  },
  shell: { showTitle: true, separator: "thin", padding: "normal" },
});
