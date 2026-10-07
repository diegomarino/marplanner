/** "message" domain block (the sibling for non-corpus domains,
 * "The 21 block types", FR-013). PORTED from v1
 * `apps/api/src/lib/daily-briefing/blocks/message.ts` (`dailyMessages` table read) — v1 read the
 * table directly; v2's equivalent domain (`src/server/modules/daily-messages/index.ts`,
 * `getMessage(memberId, date)`) is a PLUGIN module, so Rule B (ADR-039 §2b′,
 * `eslint.config.mjs`'s daily-briefing import-boundary zone) requires this cross-plugin read to
 * go through `src/server/host-api/index.ts` (which exports `getMessage` /
 * `DailyMessageNotFoundError`). Production generation wires `ctx.readDailyMessage` from
 * `../index.ts`'s `readDailyMessagePort` (maps not-found → null; other errors propagate).
 * The injectable port remains so unit tests can supply a fake without the host barrel.
 * DAILY-MESSAGES-AC-07 fold: "Text stored verbatim; emoji/wrapping handled at
 * render" assigns emoji handling to the RENDER layer, not generation — the GENERATOR must freeze
 * the snapshot's text RAW (no stripping here), and `null` means ONLY "no message row exists for
 * (memberId, date)", never "the message, once sanitized, turned out empty". An emoji-only message
 * therefore still yields a block (`generate` never null-outs a message that exists); the emoji
 * strip for glyph-safe printing lives in the message RENDER-DEF
 * (`render/blocks/message.ts`, wired through `render/registry.ts`), which is the pressedslip
 * render step, i.e. print time — never the generation-time snapshot this block produces.
 */

export interface MessageBlockContext {
  memberId: string;
  date: string;
  /** Production: `readDailyMessagePort` via host-api `getMessage`; tests may inject a fake. */
  readDailyMessage?: (memberId: string, date: string) => { text: string } | null;
}

export interface MessageBlockData {
  text: string;
}

export const messageBlock = {
  type: "message" as const,
  scope: "member" as const,
  source:
    "src/server/modules/daily-messages getMessage (host-api barrel; production wires via index.readDailyMessagePort)",
  async generate(ctx: MessageBlockContext): Promise<MessageBlockData | null> {
    if (!ctx.readDailyMessage) return null;
    const message = ctx.readDailyMessage(ctx.memberId, ctx.date);
    // AC-07: null means ONLY "no message row" — the text itself is frozen verbatim, never
    // sanitized/stripped here (that is the render-def's job, at print time).
    if (!message) return null;
    return { text: message.text };
  },
};
