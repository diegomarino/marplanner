// ─────────────────────────────────────────────────────────────────────
// Render envelope — the MINIMAL shape the render layer needs (
//). Deliberately NOT the full "Envelope
// v2" (schemaVersion 2, per-block language/params, failed-block records) —
// that full shape lands with the generation rework. This skeleton's
// adapter/bridge operate on exactly the fields pressedslip's composition
// needs: a stable identity pair (memberId/date) plus an ordered block list
// of {type, title, data}. constructs one of these FROM the real
// envelope v2 payload; this type is the render layer's own input contract,
// not a persisted shape.
// ─────────────────────────────────────────────────────────────────────

export interface RenderBlockInput {
  /** Dispatch key matching a registered pressedslip BlockDefinition + an adapter case. */
  type: string;
  /** Display title (envelope v2's "NN DISPLAY NAME" convention). */
  title: string;
  /** Block-specific payload; validated by the adapter before it reaches pressedslip. */
  data: unknown;
}

export interface RenderEnvelope {
  memberId: string;
  memberName: string;
  date: string;
  /** Household language for structural render-time copy (DAILY-BRIEFING-INV-06, P1
   * fold) — resolved once by `index.ts#renderAndPackBriefing` and threaded through
   * `bridge.ts#buildComposition` into `composition.meta.language`, read by label-consuming defs
   * via `./labels.ts#labelsFromCtx`. Optional (not every RenderEnvelope fixture cares about
   * structural labels); `./labels.ts#getLabels` defaults to the household's system-wide default
   * ("es") when absent. */
  language?: string;
  blocks: RenderBlockInput[];
}
