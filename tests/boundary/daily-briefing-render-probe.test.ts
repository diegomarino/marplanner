import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PNG } from "pngjs";

/** Hoisted override seam (mirrors `tests/integration/daily-briefing-render-degrade.test.ts`'s own
 * `vi.hoisted` + `vi.mock` shape) — every test but the "genuine catastrophic failure" one below
 * leaves `renderOverride.current` `null`, in which case the mock calls straight through to
 * pressedslip's REAL `render`; only that one test arms an override to force a genuinely
 * thrown/rejected `render`, proving `renderBriefingBitmap`'s outer catch still degrades to a
 * null bitmap for a failure that ISN'T a per-block adapter error .
 */
const { renderOverride } = vi.hoisted(() => ({
  renderOverride: { current: null as (() => Promise<never>) | null },
}));
vi.mock("pressedslip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("pressedslip")>();
  return {
    ...actual,
    render: (...args: Parameters<typeof actual.render>) =>
      renderOverride.current ? renderOverride.current() : actual.render(...args),
  };
});

/** (coverage-gap task) registered pressedslip render-defs for all 21 block types
 * (render/registry.ts) — this file's "registry-miss" test (below) originally used "dadJoke" as a
 * type the ADAPTER knows but the REGISTRY doesn't, which is no longer true post-. Rather than
 * delete the proof that a registry-miss is correctly partitioned into `unrenderedBlocks` (never
 * `failedRenderBlocks`), this scoped override lets exactly ONE test simulate a registry-miss for a
 * named type while every other test in this file (all `excludeTypes: []` by default) sees the REAL,
 * fully-populated registry unchanged.
 */
const { registryOverride } = vi.hoisted(() => ({
  registryOverride: { excludeTypes: [] as string[] },
}));
vi.mock("../../src/server/modules/daily-briefing/render/registry", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/server/modules/daily-briefing/render/registry")
    >();
  const real = actual.dailyBriefingRenderRegistry;
  return {
    ...actual,
    dailyBriefingRenderRegistry: {
      has: (type: string) => !registryOverride.excludeTypes.includes(type) && real.has(type),
      find: (type: string) =>
        registryOverride.excludeTypes.includes(type) ? undefined : real.find(type),
      list: () => real.list().filter((b) => !registryOverride.excludeTypes.includes(b.type)),
      get size() {
        return real.list().filter((b) => !registryOverride.excludeTypes.includes(b.type)).length;
      },
    },
  };
});

import { renderBriefingBitmap } from "../../src/server/modules/daily-briefing/render/bridge";
import {
  pngToPackedRaster,
  RASTER_BYTES_PER_ROW,
  RASTER_WIDTH_DOTS,
  RasterWidthError,
} from "../../src/server/modules/daily-briefing/render/raster";
import { loadFont } from "../../src/server/modules/daily-briefing/render/theme";
import type { RenderEnvelope } from "../../src/server/modules/daily-briefing/render/types";

/** docs/features/daily-briefing.md — the D2 PROBE (Constitution
 * XIV): "pngjs's decoded buffer layout for 1-bit-depth PNGs... assert this with an executed probe
 * against a pressedslip-produced PNG before writing the converter". This test IS that probe,
 * executed against a REAL render (not a synthetic/hand-built PNG) — a fixture envelope with one
 * `message` block, rendered through the real pressedslip pipeline (adapter -> registry -> theme ->
 * render), then decoded directly with `PNG.sync.read`.
 */
describe("daily-briefing render — D2 probe (pngjs decode layout)", () => {
  const fixtureEnvelope: RenderEnvelope = {
    memberId: "probe-member",
    memberName: "Probe Member",
    date: "2026-09-08",
    blocks: [{ type: "message", title: "MESSAGE", data: { text: "hello daily briefing" } }],
  };

  it("empirically confirms pngjs normalizes pressedslip's 1-bit PNG to opaque 8-bit RGBA with only {0,255} channel values", async () => {
    const rendered = await renderBriefingBitmap(fixtureEnvelope);
    expect(rendered.bitmapPng).not.toBeNull();
    expect(rendered.failedRenderBlocks).toEqual([]);

    const png = PNG.sync.read(Buffer.from(rendered.bitmapPng as Uint8Array));

    // The empirical finding this probe records: pngjs's decoded `data` buffer is ALWAYS 8-bit
    // RGBA (width * height * 4 bytes), even though the source PNG is 1-bit — pngjs re-expands it
    // on decode rather than exposing the packed 1-bit rows directly.
    expect(png.width).toBe(RASTER_WIDTH_DOTS);
    expect(png.data.length).toBe(png.width * png.height * 4);

    // Fully opaque throughout (pressedslip's 1-bit render never produces partial alpha).
    const alphaValues = new Set<number>();
    for (let i = 3; i < png.data.length; i += 4) alphaValues.add(png.data[i]);
    expect([...alphaValues]).toEqual([255]);

    // R/G/B channels take ONLY the two values 0 (black) or 255 (white) — the source's 1-bit
    // threshold already collapsed the image; pngjs does not reintroduce intermediate grays.
    const channelValues = new Set<number>();
    for (let i = 0; i < png.data.length; i += 4) {
      channelValues.add(png.data[i]);
      channelValues.add(png.data[i + 1]);
      channelValues.add(png.data[i + 2]);
    }
    expect([...channelValues].sort((a, b) => a - b)).toEqual([0, 255]);
  });

  it("packs a real rendering into exactly RASTER_BYTES_PER_ROW bytes/row, height from the PNG", async () => {
    const rendered = await renderBriefingBitmap(fixtureEnvelope);
    const packed = pngToPackedRaster(rendered.bitmapPng as Uint8Array);

    expect(packed.height).toBe(rendered.bitmapHeight);
    expect(packed.bits.length).toBe(RASTER_BYTES_PER_ROW * packed.height);
    expect(RASTER_BYTES_PER_ROW).toBe(72);

    // At least one bit is set — the rendered "hello daily briefing" text produced real ink.
    const anyBlack = packed.bits.some((byte) => byte !== 0);
    expect(anyBlack).toBe(true);
  });

  it("rejects a PNG whose width isn't exactly RASTER_WIDTH_DOTS — never silently rescales", () => {
    const narrowPng = new PNG({ width: 100, height: 10 });
    const buf = PNG.sync.write(narrowPng);
    expect(() => pngToPackedRaster(new Uint8Array(buf))).toThrow(RasterWidthError);
  });

  /** a golden, hand-constructed byte pattern — proves BOTH the MSB-first bit
   * order AND the luma<128=black polarity, neither of which the "real render produced some ink"
   * assertion above can distinguish (a flipped bit order or an inverted polarity would still
   * produce "some ink", just at the wrong positions).
   * Row 0: pixels x=0..7 BLACK, x=8..575 WHITE -> byte 0 must be every bit set (0xff, MSB-first
   * over a fully-black byte-span), every remaining byte 0x00.
   * Row 1: alternating WHITE/BLACK starting at x=0 (even=white, odd=black) for the whole row ->
   * every byte covers 8 consecutive pixels starting at a multiple of 8 (always even), so the
   * pattern within each byte is white,black,white,black,... — MSB-first that is bits
   * 7,5,3,1 (the ODD x positions) set: 0b01010101 = 0x55, identical for all 72 bytes.
   */
  it("packs a hand-built golden pattern into the EXACT expected bytes (MSB-first order + luma polarity)", () => {
    const height = 2;
    const png = new PNG({ width: RASTER_WIDTH_DOTS, height });
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < RASTER_WIDTH_DOTS; x++) {
        const idx = (y * RASTER_WIDTH_DOTS + x) * 4;
        const isBlack = y === 0 ? x < 8 : x % 2 === 1;
        const value = isBlack ? 0 : 255;
        png.data[idx] = value;
        png.data[idx + 1] = value;
        png.data[idx + 2] = value;
        png.data[idx + 3] = 255;
      }
    }
    const pngBytes = new Uint8Array(PNG.sync.write(png));

    const packed = pngToPackedRaster(pngBytes);
    expect(packed.height).toBe(height);
    expect(packed.bits.length).toBe(RASTER_BYTES_PER_ROW * height);

    const row0 = packed.bits.slice(0, RASTER_BYTES_PER_ROW);
    const expectedRow0 = new Uint8Array(RASTER_BYTES_PER_ROW);
    expectedRow0[0] = 0xff;
    expect(Array.from(row0)).toEqual(Array.from(expectedRow0));

    const row1 = packed.bits.slice(RASTER_BYTES_PER_ROW, RASTER_BYTES_PER_ROW * 2);
    const expectedRow1 = new Uint8Array(RASTER_BYTES_PER_ROW).fill(0x55);
    expect(Array.from(row1)).toEqual(Array.from(expectedRow1));
  });
});

/** Superseded by (DAILY-BRIEFING-INV-07 render-layer isolation, review-fold handoff
 * note): the bridge no longer treats one block's adapter failure as catastrophic for the WHOLE
 * render. `render/bridge.ts#buildSlots` now catches `adaptBlockData` PER BLOCK — a bad block is
 * dropped from the composition and recorded, while the render itself still proceeds (and
 * succeeds) for every surviving block. The ORIGINAL P2-4a proof (a single bad block making
 * `renderBriefingBitmap` degrade to a null bitmap) no longer reflects reality — that assertion
 * described the skeleton's `minimumAdapter(envelope)` all-or-nothing `.map`, since
 * replaced.
 * adds a further split: an adapter-level failure (a type `adaptBlockData`
 * itself doesn't recognize, or a KNOWN type's malformed data) is GENUINE and lands in
 * `failedRenderBlocks`; a type the ADAPTER knows but the pressedslip REGISTRY doesn't (a
 * registry-miss — no render-def yet) is a coverage gap and lands in the separate
 * `unrenderedBlocks`, excluded from `deriveOverallStatus`'s status math (`index.ts`).
 */
describe("daily-briefing render bridge — per-block adapter isolation (T009)", () => {
  it("an adapter-level failure (unknown to adaptBlockData) is GENUINE: it lands in failedRenderBlocks, the render still succeeds", async () => {
    const envelope: RenderEnvelope = {
      memberId: "probe-member",
      memberName: "Probe Member",
      date: "2026-09-08",
      blocks: [
        { type: "this-type-does-not-exist", title: "X", data: {} },
        { type: "message", title: "MESSAGE", data: { text: "survives the bad sibling" } },
      ],
    };
    const result = await renderBriefingBitmap(envelope);
    expect(result.bitmapPng).not.toBeNull();
    expect(result.failedRenderBlocks).toEqual(["this-type-does-not-exist"]);
    expect(result.unrenderedBlocks).toEqual([]);
  });

  it("a registry-miss (adapter knows the type, pressedslip's registry does not) is UNRENDERED, never genuine", async () => {
    // "dadJoke" IS a real pressedslip render-def since — simulate a registry-miss for it via
    // the scoped `registryOverride` (see the mock's doc comment above) so this partition proof
    // stays independent of how complete the real registry happens to be.
    registryOverride.excludeTypes = ["dadJoke"];
    try {
      const envelope: RenderEnvelope = {
        memberId: "probe-member",
        memberName: "Probe Member",
        date: "2026-09-08",
        blocks: [
          // "dadJoke" is a KNOWN adapter case (render/adapter.ts); the override above makes the
          // REGISTRY report it as absent — pressedslip's own composeTree reports it as "Unknown
          // block type", a registry-miss.
          { type: "dadJoke", title: "03 DAD JOKE", data: { text: "why did the chicken..." } },
          {
            type: "message",
            title: "MESSAGE",
            data: { text: "survives the registry-miss sibling" },
          },
        ],
      };
      const result = await renderBriefingBitmap(envelope);
      expect(result.bitmapPng).not.toBeNull();
      expect(result.failedRenderBlocks).toEqual([]);
      expect(result.unrenderedBlocks).toEqual(["dadJoke"]);
    } finally {
      registryOverride.excludeTypes = [];
    }
  });

  it("still degrades to a null bitmap for a GENUINE catastrophic failure (render() itself throws)", async () => {
    renderOverride.current = () => Promise.reject(new Error("boom"));
    try {
      const envelope: RenderEnvelope = {
        memberId: "probe-member",
        memberName: "Probe Member",
        date: "2026-09-08",
        blocks: [{ type: "message", title: "MESSAGE", data: { text: "hello" } }],
      };
      const result = await renderBriefingBitmap(envelope);
      expect(result).toEqual({
        bitmapPng: null,
        bitmapHeight: null,
        failedRenderBlocks: [],
        unrenderedBlocks: [],
      });
    } finally {
      renderOverride.current = null;
    }
  });
});

/** (P2 fold): the 30s race's timeout timer must not outlive a render that settles
 * first. Only `setTimeout`/`clearTimeout` are faked — Promise microtasks and pressedslip's real
 * async render work (satori/resvg) are untouched by fake timers, so the render itself still
 * completes normally; this isolates exactly the timer-handle leak the fold is about.
 */
describe("daily-briefing render bridge — timeout timer cleanup (Codex #698)", () => {
  it("clears the race's timeout timer once the render settles first (render wins)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const envelope: RenderEnvelope = {
        memberId: "probe-member",
        memberName: "Probe Member",
        date: "2026-09-08",
        blocks: [{ type: "message", title: "MESSAGE", data: { text: "timer cleanup probe" } }],
      };
      const result = await renderBriefingBitmap(envelope);
      expect(result.bitmapPng).not.toBeNull();
      // The render resolved well under the 30s cap — its OWN timeout timer (the losing side of
      // the race) must already be cleared, not left pending for the rest of the interval.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** docs/features/daily-briefing.md — "fonts-from-disk load in vitest env" probe
 * (trap-sweep row): a missing/unreadable font file must throw a diagnostic error, not let
 * `fs.readFileSync`'s raw ENOENT escape unadorned (ports v1 `prepare.ts#loadFont`'s throw-path
 * discipline into an executable test — v1 shipped the behavior without a dedicated test for it).
 */
describe("daily-briefing render theme — font load-from-disk throw path", () => {
  it("throws a diagnostic error naming the missing file and directory", () => {
    const fontsDir = path.resolve(
      __dirname,
      "../../src/server/modules/daily-briefing/render/fonts/jetbrains-mono"
    );
    expect(() => loadFont(fontsDir, "NoSuchFont-Regular.ttf", "NoSuchFont", 400, "normal")).toThrow(
      /failed to load font NoSuchFont-Regular\.ttf/
    );
  });

  it("successfully loads a real shipped font file", () => {
    const fontsDir = path.resolve(
      __dirname,
      "../../src/server/modules/daily-briefing/render/fonts/jetbrains-mono"
    );
    const font = loadFont(fontsDir, "JetBrainsMono-Regular.ttf", "JetBrainsMono", 400, "normal");
    expect(font.name).toBe("JetBrainsMono");
    expect(font.weight).toBe(400);
    expect(font.style).toBe("normal");
    expect(font.data.byteLength).toBeGreaterThan(1000);
  });
});
