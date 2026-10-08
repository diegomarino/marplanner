import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../src/server/db/client";
import {
  RASTER_BYTES_PER_ROW,
  RASTER_WIDTH_DOTS,
} from "../../src/server/modules/daily-briefing/render/raster";
import { useIsolatedDb } from "../helpers/db";
import { seedMember } from "../helpers/daily-briefing-seed";
import { __setPrintingPluginActiveForTests } from "../../src/server/modules/printing/index";

/** — (render-and-pack degrade), P2-3a (Printing-inactive gate), and the * data-model invariant (raster_bits/raster_height/png all-NULL-or-all-set together) all exercise
 * the SAME code path (`generateBriefing`'s render+store step) under different injected
 * conditions, so they share one file and one mocking setup.
 * `dailyBriefingRenderRegistry.has` is mocked to always return `true` — the ONLY way to drive
 * `generateBriefing`'s render step at all from a normal 010-gathered block (calendar/reminders/
 * chores/meals/weather), since none of those types is actually registered in the real registry
 * yet (lands the real ones). This does NOT touch the renderable-blocks GATE itself (still
 * real production code, still `isPrintingPluginActive && renderableBlocks.length > 0` inside
 * index.ts) — it only makes the registry consider "calendar"/etc renderable for this test, so the
 * gate's OWN condition is satisfiable without waiting for /.
 */
vi.mock("../../src/server/modules/daily-briefing/render/registry", () => ({
  dailyBriefingRenderRegistry: {
    has: () => true,
    find: () => undefined,
    list: () => [],
    size: 0,
  },
}));

const { renderBriefingBitmapMock } = vi.hoisted(() => ({ renderBriefingBitmapMock: vi.fn() }));

vi.mock("../../src/server/modules/daily-briefing/render/index", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/server/modules/daily-briefing/render/index")>();
  return {
    ...actual,
    renderBriefingBitmap: renderBriefingBitmapMock,
  };
});

import { generateBriefing } from "../../src/server/modules/daily-briefing/index";

function buildValidPng(): Uint8Array {
  const png = new PNG({ width: RASTER_WIDTH_DOTS, height: 1 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 0;
    png.data[i + 1] = 0;
    png.data[i + 2] = 0;
    png.data[i + 3] = 255;
  }
  return new Uint8Array(PNG.sync.write(png));
}

function buildBadWidthPng(): Uint8Array {
  const png = new PNG({ width: 100, height: 10 });
  return new Uint8Array(PNG.sync.write(png));
}

function rasterColumns(memberId: string, date: string) {
  return getDb()
    .prepare(
      "SELECT raster_bits, raster_height, png, failed_render_blocks, status, payload FROM daily_briefing WHERE member_id = ? AND date = ?"
    )
    .get(memberId, date) as
    | {
        raster_bits: Buffer | null;
        raster_height: number | null;
        png: Buffer | null;
        failed_render_blocks: string;
        status: string;
        payload: string;
      }
    | undefined;
}

describe("daily-briefing generateBriefing — render-outcome persistence (review fold P1-3/P2-3a/P2-5)", () => {
  useIsolatedDb();

  const memberId = "member-degrade-1";
  const date = "2026-09-08";

  beforeEach(() => {
    // Freeze only the business clock so Calendar gathering cannot age out of its rolling window.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${date}T12:00:00Z`));
    seedMember(memberId);
    // gatherBlocks only PUSHES a block when its read returns non-empty data (see `gather` in
    // index.ts) — with zero seeded domain content, `blocks` would stay empty and
    // `selectRenderableBlocks` would have nothing to check the (mocked) registry against
    // regardless of what `.has` returns. One minimal all-day "calendar" (shared-scope) event
    // gives generateBriefing a single non-empty, `status: "ok"` block to drive the mocked
    // registry's always-true `.has` through the render gate.
    const now = Date.UTC(2026, 8, 1, 0, 0, 0);
    getDb()
      .prepare(
        `INSERT INTO calendar_events
          (id, source, title, all_day, start_date, end_date, exdates, created_at, updated_at)
         VALUES (?, 'local', 'Test Event', 1, ?, ?, '[]', ?, ?)`
      )
      .run("event-degrade-1", date, "2026-09-09", now, now);
    renderBriefingBitmapMock.mockReset();
  });

  afterEach(() => {
    __setPrintingPluginActiveForTests(undefined);
    vi.useRealTimers();
  });

  it("P1-3: a structurally invalid render (bad width) degrades to render-failed, never propagates, data stays intact", async () => {
    renderBriefingBitmapMock.mockResolvedValueOnce({
      bitmapPng: buildBadWidthPng(),
      bitmapHeight: 10,
      failedRenderBlocks: [],
      unrenderedBlocks: [],
    });

    const briefing = await generateBriefing(memberId, date);

    // Never throws (renderAndPackBriefing's own try/catch) — reaching this line at
    // all is part of the proof. Status reflects the degrade; the DATA layer's own content is
    // completely unaffected (this is a RENDER-layer failure, not a data-layer one).
    expect(briefing.status).toBe("render-failed");
    //: generateBriefing now always emits envelope v2 (full 21-block registry).
    expect(briefing.payload.schemaVersion).toBe(2);
    expect(briefing.payload.member.id).toBe(memberId);

    // data-model invariant: raster_bits/raster_height/png are all-NULL together on the
    // degrade path — never a partial write.
    const row = rasterColumns(memberId, date);
    expect(row?.status).toBe("render-failed");
    expect(row?.raster_bits).toBeNull();
    expect(row?.raster_height).toBeNull();
    expect(row?.png).toBeNull();
  });

  it("P2-3a: with the Printing plugin inactive, generation stores NO raster and status derives from data alone", async () => {
    __setPrintingPluginActiveForTests(false);

    const briefing = await generateBriefing(memberId, date);

    // Render is never even ATTEMPTED — the mock must not have been called.
    expect(renderBriefingBitmapMock).not.toHaveBeenCalled();
    // No renderable content was gathered either way, so the plain data-layer status is "ready"
    // (010's deriveStatus: empty/all-ok blocks -> "ready") — never 'render-failed', since a
    // render was never attempted (render-failed only applies when Printing is
    // active AND a render was actually tried).
    expect(briefing.status).toBe("ready");

    const row = rasterColumns(memberId, date);
    expect(row?.status).toBe("ready");
    expect(row?.raster_bits).toBeNull();
    expect(row?.raster_height).toBeNull();
    expect(row?.png).toBeNull();
    expect(row?.failed_render_blocks).toBe("[]");
  });

  it("P2-5: a SUCCESSFUL render leaves raster_bits/raster_height/png all SET together", async () => {
    renderBriefingBitmapMock.mockResolvedValueOnce({
      bitmapPng: buildValidPng(),
      bitmapHeight: 1,
      failedRenderBlocks: [],
      unrenderedBlocks: [],
    });

    const briefing = await generateBriefing(memberId, date);

    expect(briefing.status).toBe("ready");
    const row = rasterColumns(memberId, date);
    expect(row?.raster_bits).not.toBeNull();
    expect(row?.raster_height).toBe(1);
    expect(row?.png).not.toBeNull();
    expect(row?.raster_bits?.length).toBe(RASTER_BYTES_PER_ROW * 1);
  });
});
