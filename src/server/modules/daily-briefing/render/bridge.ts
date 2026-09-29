// ─────────────────────────────────────────────────────────────────────
// Render bridge ( spec Clarifications
// "generation time budget"). PORTED from v1
// `apps/api/src/lib/daily-briefing/render-bridge.ts`: a 30s cap on the
// render step (`Promise.race`), catastrophic failure or timeout returns a
// null result (never throws) that the caller persists as `render-failed`
// (D5) — the composition it builds mirrors v1's `buildPressedslipComposition`.
// ─────────────────────────────────────────────────────────────────────
import { render } from "pressedslip";
import type { Composition, Slot } from "pressedslip";
import { adaptBlockData } from "./adapter";
import { dailyBriefingRenderRegistry } from "./registry";
import { prepareDailyBriefingTheme } from "./theme";
import type { RenderEnvelope } from "./types";

const RENDER_TIMEOUT_MS = 30_000;

/** pressedslip's exact "Unknown block type: …" prefix (composeTree, `themes-*.mjs`) — the ONLY
 * signal available to tell a registry-miss apart from a genuine schema/render failure, since
 * `FailedBlock.reason` is a plain `{name, message}` pair, not a typed enum. Coupling to this
 * literal string is fragile but pragmatic: pressedslip exposes nothing more structured today. */
const REGISTRY_MISS_PREFIX = "Unknown block type:";

export interface RenderBridgeResult {
  /** PNG bytes (1-bit, receipt width); null when render caught a catastrophic failure/timeout. */
  bitmapPng: Uint8Array | null;
  /** Height in px; null when bitmapPng is null. */
  bitmapHeight: number | null;
  /** Render-layer failures (DAILY-BRIEFING-INV-07): a per-block adapter validation throw on a REGISTERED type's malformed data
   * (`buildSlots`), or pressedslip's own schema-validation/`render` throw for a block whose
   * type IS in the registry. This is the population D5's status derivation (`index.ts#
   * deriveOverallStatus`) actually reads — see `unrenderedBlocks` for the population it must NOT
   * read. Empty when `bitmapPng` is null (a catastrophic failure never partially completes).
   */
  failedRenderBlocks: string[];
  /** Block types with NO pressedslip render-def yet — a registry-miss (pressedslip's own
   * `composeTree` "Unknown block type" outcome, `registry.find(blockType)` returning nothing).
   * The render registry (`render/registry.ts`) registers all 21 block types, so this
   * population is empty on a real generation; it stays a live seam (not deleted) because a FUTURE
   * new block type added to the adapter without a matching render-def would land here again, not
   * in `failedRenderBlocks`. Persisted/reported for operational visibility but deliberately EXCLUDED
   * from status derivation: conflating this with `failedRenderBlocks` would report `partial`/
   * `render-failed` on every single generation, which is not a data-layer or genuine render
   * defect.
   */
  unrenderedBlocks: string[];
}

function buildComposition(envelope: RenderEnvelope, slots: Composition["slots"]): Composition {
  return {
    id: `daily-briefing-${envelope.memberId}-${envelope.date}`,
    version: 1,
    date: envelope.date,
    subject: { id: envelope.memberId, name: envelope.memberName },
    status: "ready",
    slots,
    failedBlocks: [],
    providerOutcomes: {},
    timing: { totalMs: 0, fetchPhaseMs: 0, renderPhaseMs: 0 },
    // threads the household language (resolved once, `index.ts
    // #renderAndPackBriefing`) through to every block's `ctx.composition.meta.language` — the
    // `Composition.meta` bag survives untouched into `RenderContext` (pressedslip's `composeTree`
    // assigns `ctx.composition = composition` verbatim; verified against the bundled pipeline).
    // `./labels.ts#labelsFromCtx` is the consuming side.
    meta: { language: envelope.language },
  };
}

/** Adapt every block of a RenderEnvelope into pressedslip Slots, isolating each block's OWN
 * adapter failure (DAILY-BRIEFING-INV-07 render-layer isolation) — a deliberate
 * departure from this file's prior all-or-nothing `minimumAdapter(envelope)` call (skeleton):
 * `adaptBlockData` (./adapter.ts) is unwrap-or-throw PER BLOCK TYPE by design, so mapping the
 * whole envelope through it in one `.map` meant ONE malformed block's data threw synchronously
 * and killed the ENTIRE composition — reported as a catastrophic `render-failed` even when every
 * OTHER block's data was perfectly fine. A block whose type has no registered pressedslip
 * render-def is deliberately NOT filtered out here (no `dailyBriefingRenderRegistry.has` guard):
 * pressedslip's own `composeTree` already reports an unregistered `blockType` as a `FailedBlock`
 * ("Unknown block type: …", `registry.find(blockType)` miss) WITHOUT throwing for the rest of the
 * tree — verified by reading pressedslip's bundled `composeTree` — so passing every block straight
 * through and letting `render`'s own per-slot isolation handle registry gaps avoids duplicating
 * that check here. `index` is assigned sequentially over the SURVIVING slots only (this function's
 * own return order), matching pressedslip's synthetic `${blockType}-${index}` id scheme.
 */
function buildSlots(envelope: RenderEnvelope): { slots: Slot[]; adapterFailures: string[] } {
  const slots: Slot[] = [];
  const adapterFailures: string[] = [];
  for (const block of envelope.blocks) {
    try {
      const data = adaptBlockData(block.type, block.data);
      slots.push({ index: slots.length, blockType: block.type, title: block.title, data });
    } catch (err) {
      adapterFailures.push(block.type);
      console.error("daily-briefing.render-bridge.adapter-failed", {
        blockType: block.type,
        error: String(err),
      });
    }
  }
  return { slots, adapterFailures };
}

async function doRender(envelope: RenderEnvelope): Promise<RenderBridgeResult> {
  const { slots, adapterFailures } = buildSlots(envelope);
  const composition = buildComposition(envelope, slots);

  const rendering = await render(composition, {
    registry: dailyBriefingRenderRegistry,
    theme: prepareDailyBriefingTheme(),
  });

  // Partition pressedslip's OWN per-slot failures: a
  // registry-miss ("Unknown block type: …" — no pressedslip render-def exists for this type YET)
  // is a coverage gap, not a defect, and goes to `unrenderedBlocks`; anything else (a schema
  // validation failure or a thrown `render` for a block whose type IS registered) is a genuine
  // failure and joins `buildSlots`' own `adapterFailures` in `failedRenderBlocks`. The two
  // populations pressedslip itself can emit are disjoint (one slot -> exactly one outcome), and
  // `adapterFailures` never overlaps either (a slot only reaches `render` at all once it has
  // already survived `adaptBlockData`).
  const unrenderedBlocks: string[] = [];
  const genuineFailures: string[] = [...adapterFailures];
  for (const failure of rendering.failedBlocks) {
    if (failure.reason.message.startsWith(REGISTRY_MISS_PREFIX)) {
      unrenderedBlocks.push(failure.blockType);
    } else {
      genuineFailures.push(failure.blockType);
    }
  }

  return {
    bitmapPng: rendering.bytes,
    bitmapHeight: rendering.height,
    failedRenderBlocks: genuineFailures,
    unrenderedBlocks,
  };
}

/** Render a Daily Briefing envelope to a receipt-width 1-bit PNG. Catastrophic
 * failure (an adapter throw, a render rejection) or exceeding the 30s cap
 * NEVER throws — it returns a null bitmap the caller persists as
 * `render-failed` (v1 study gotcha: catastrophic render must
 * never masquerade as `ready` with a missing raster).
 */
export async function renderBriefingBitmap(envelope: RenderEnvelope): Promise<RenderBridgeResult> {
  // (P2 fold): the timeout's timer must be cleared once the race settles EITHER way —
  // otherwise, when `doRender` wins, the losing timer sits referenced for the rest of the full
  // 30s interval for no reason (holds the event loop open, and leaves a stray pending timer any
  // fake-timer-based test would see). `clearTimeout` on an already-fired timer (the timeout-wins
  // direction) is a harmless no-op, so one unconditional `finally` covers both orders.
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      doRender(envelope),
      new Promise<RenderBridgeResult>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`render timeout after ${RENDER_TIMEOUT_MS}ms`)),
          RENDER_TIMEOUT_MS
        );
      }),
    ]);
  } catch (err) {
    // English, machine-actionable log (repo convention — no plugin telemetry seam is
    // load-bearing here; a console.error mirrors existing src/server error-path logging).
    console.error("daily-briefing.render-bridge.catastrophic", {
      memberId: envelope.memberId,
      date: envelope.date,
      error: String(err),
    });
    return { bitmapPng: null, bitmapHeight: null, failedRenderBlocks: [], unrenderedBlocks: [] };
  } finally {
    clearTimeout(timeoutHandle);
    // Honest limitation (timeout-wins direction only): `doRender` has no cancellation/abort seam
    // — pressedslip's underlying satori/resvg calls cannot be interrupted mid-flight. An orphaned
    // render therefore keeps running to completion in the background after this function has
    // already returned the timeout's null-bitmap result; its eventual settlement is simply
    // discarded (never awaited, never assigned) rather than pretend-cancelled. This is safe
    // because `doRender` only ever RETURNS a value — it has no side effects of its own (no DB
    // write, no state mutation) — so there is nothing an orphaned render could do after the fact
    // except compute a value nobody reads; the caller (`index.ts#renderAndPackBriefing` /
    // `generateBriefing`) is what performs every write, and only ever does so with THIS
    // function's own returned/resolved result, never a stray late one.
  }
}
