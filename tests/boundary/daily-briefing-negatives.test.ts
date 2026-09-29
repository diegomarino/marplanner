import { readFileSync } from "node:fs";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { evaluateAutoPrintTrigger } from "../../src/server/modules/daily-briefing/trigger";
import { seedMember } from "../helpers/daily-briefing-seed";
import { useIsolatedDb } from "../helpers/db";

/** docs/features/daily-briefing.md (FR-010) — six negative proofs the story's
 * per-file tasks don't already cover in one place: the read-purity fence, a schemaVersion-1
 * (010-era) row's backward-read coherence (analyze C1), the corpus-language 400, the OpenAPI
 * closed-schema convention, FR-022's settings-never-mutate-briefings guarantee at the DB level,
 * and the trigger's no-binding -> no-enqueue gate.
 */
describe("daily-briefing negatives (T015, FR-010)", () => {
  useIsolatedDb();

  let app: FastifyInstance;
  let deviceKey: string;
  let memberId: string;

  beforeEach(async () => {
    const now = Date.now();
    const db = getDb();
    deviceKey = `mpk-${now}-${Math.random().toString(36).slice(2)}`;
    memberId = `member-${now}`;

    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`device-${now}`, hashKey(deviceKey), now);
    db.prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, 'child', 'active', ?, ?)"
    ).run(memberId, "Ada", now, now);

    const { buildApp } = await import("../../src/server/app.ts");
    app = await buildApp();
  });

  afterEach(async () => {
    await app?.close();
  });

  function auth() {
    return { mp_device_key: deviceKey };
  }

  function countBriefingRows(memberId: string, date: string): number {
    const row = getDb()
      .prepare("SELECT COUNT(*) AS n FROM daily_briefing WHERE member_id = ? AND date = ?")
      .get(memberId, date) as { n: number };
    return row.n;
  }

  // ── (1) Read purity fence — GET creates NO daily_briefing row (FR-010: reads never generate) ──

  it("(1) GET for an ungenerated member/date creates no daily_briefing row", async () => {
    const date = "2026-09-08";
    expect(countBriefingRows(memberId, date)).toBe(0);

    const res = await app.inject({
      method: "GET",
      url: `/api/daily-briefing/${memberId}/${date}`,
      cookies: auth(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ generated: false });
    expect(countBriefingRows(memberId, date)).toBe(0);
  });

  // ── (2) Backward-read of a schemaVersion-1 (010-era) payload row (analyze C1) ────────────────

  it("(2) GET still reads a pre-019 schemaVersion-1 row coherently, untouched by the v2 registry", async () => {
    const date = "2026-05-01";
    const now = Date.now();
    // The exact 010-era envelope shape (src/shared/dailyBriefing.ts's own `BriefingPayload`/
    // `BlockType` doc comments): four merged domains, ORDERED calendar -> reminders -> chores ->
    // meals, schemaVersion 1. Inserted directly — this row predates /the render/registry
    // columns entirely, exercising exactly what drizzle/0017's `INSERT INTO daily_briefing_new
    // SELECT...` backfill (no render columns) + drizzle/0018's additive `unrendered_blocks`
    // column leave behind for a row that was NEVER regenerated post-migration: only the six
    // original 0011 columns are written here, every 0017/0018 column is left to its schema
    // default (failed_render_blocks='[]', unrendered_blocks='[]', raster/png/last_print_* NULL).
    const legacyPayload = {
      schemaVersion: 1,
      member: { id: memberId, displayName: "Ada" },
      date,
      blocks: [
        { type: "calendar", scope: "shared", status: "ok", data: { bullets: ["Soccer practice"] } },
        {
          type: "reminders",
          scope: "member",
          status: "ok",
          data: { groups: [{ items: [{ value: "Pack bag" }] }] },
        },
        { type: "chores", scope: "member", status: "ok", data: { items: ["Make bed"] } },
        { type: "meals", scope: "shared", status: "ok", data: { lunch: "Soup" } },
      ],
    };
    getDb()
      .prepare(
        `INSERT INTO daily_briefing (id, member_id, date, status, payload, created_at, updated_at)
         VALUES ('briefing-v1-legacy', ?, ?, 'ready', ?, ?, ?)`
      )
      .run(memberId, date, JSON.stringify(legacyPayload), now, now);

    const res = await app.inject({
      method: "GET",
      url: `/api/daily-briefing/${memberId}/${date}`,
      cookies: auth(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      generated: true;
      briefing: { id: string; status: string; payload: unknown };
      printedStatus: string;
    };
    expect(body.generated).toBe(true);
    expect(body.briefing.id).toBe("briefing-v1-legacy");
    expect(body.briefing.status).toBe("ready");
    // The v1 payload reads back BYTE-IDENTICAL — `readBriefing` is a pure `JSON.parse`, never a
    // rewrite/migration-on-read (src/shared/dailyBriefing.ts INV-01 doc comment).
    expect(body.briefing.payload).toEqual(legacyPayload);
    // No print record was ever enqueued for this member/date — the read-time derivation resolves
    // to "none" rather than throwing on the legacy row's absent render/raster columns.
    expect(body.printedStatus).toBe("none");

    // Still exactly the one row — the read never wrote a second, "migrated" copy.
    expect(countBriefingRows(memberId, date)).toBe(1);
  });

  // ── (3) corpus-language 400 ──────────────────────────────────────────────────────────────────

  it("(3) PUT block-settings with a language unavailable for the type 400s corpus_language_unavailable", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/daily-briefing/block-settings/${memberId}/message`,
      cookies: auth(),
      payload: { params: { language: "en" } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "corpus_language_unavailable" });

    // The rejected write persisted NOTHING for this member+block.
    const row = getDb()
      .prepare(
        "SELECT * FROM daily_briefing_member_block_settings WHERE member_id = ? AND block_type = ?"
      )
      .get(memberId, "message");
    expect(row).toBeUndefined();
  });

  // ── (4) OpenAPI closed-schema walk ───────────────────────────────────────────────────────────

  describe("(4) contracts/openapi.yaml — every object schema is closed (additionalProperties: false)", () => {
    const contractPath = path.resolve(process.cwd(), "docs/api/briefing-render/openapi.yaml");
    const doc = loadYaml(readFileSync(contractPath, "utf8")) as Record<string, unknown>;

    it("the contract file actually has schemas to scan (sanity — a vacuous scan proves nothing)", () => {
      const schemas =
        (doc as { components?: { schemas?: Record<string, unknown> } }).components?.schemas ?? {};
      expect(Object.keys(schemas).length).toBeGreaterThan(0);
    });

    it("every OBJECT-typed schema anywhere in the contract (named or inline) is closed", () => {
      // Recursive walk over the WHOLE parsed document — an inline path-level request/response
      // body schema (never registered under components.schemas) must not slip through unchecked
      // just because it isn't a top-level named schema (the 017 / 018 precedent, mirrored
      // verbatim from tests/boundary/printing-negatives.test.ts). A future route addition to
      // THIS file is covered automatically, since the walk re-parses the YAML at test-run time —
      // the walk does NOT follow `$ref` pointers into sibling contracts (e.g. this file's own
      // `Briefing` reference into 010's openapi.yaml), so a schema that lives only on the other
      // side of a `$ref` is out of this walk's scope, same as (b) in printing-negatives.test.ts.
      let checked = 0;
      function walk(node: unknown, nodePath: string): void {
        if (Array.isArray(node)) {
          node.forEach((child, i) => walk(child, `${nodePath}[${i}]`));
          return;
        }
        if (node && typeof node === "object") {
          const record = node as Record<string, unknown>;
          if (record.type === "object" || record.properties !== undefined) {
            checked += 1;
            expect(record.additionalProperties, nodePath).toBe(false);
          }
          for (const [key, value] of Object.entries(record)) {
            walk(value, `${nodePath}.${key}`);
          }
        }
      }
      walk(doc, "$");
      expect(checked).toBeGreaterThan(0); // sanity: something was actually checked
    });
  });

  // ── (5) settings writes never mutate briefings (FR-022, DB-level byte-identity) ──────────────

  it("(5) settings/block-order/member-block-settings writes leave a generated briefing row BYTE-IDENTICAL", async () => {
    const date = "2026-09-08";
    const now = Date.now();
    getDb()
      .prepare(
        `INSERT INTO daily_briefing
          (id, member_id, date, status, payload, failed_render_blocks, raster_bits, raster_height,
           png, last_print_state, last_print_at, last_print_generation, created_at, updated_at)
         VALUES ('briefing-fence-2', ?, ?, 'ready', '{"schemaVersion":2,"blocks":[]}', '[]', ?, 3,
                 ?, NULL, NULL, NULL, ?, ?)`
      )
      .run(memberId, date, Buffer.from([1, 2, 3]), Buffer.from([9, 9]), now, now);

    const before = getDb()
      .prepare("SELECT * FROM daily_briefing WHERE id = 'briefing-fence-2'")
      .get();

    const settingsRes = await app.inject({
      method: "PUT",
      url: "/api/daily-briefing/settings",
      cookies: auth(),
      payload: { generationTime: "10:15", autoPrintTrigger: "morning_complete" },
    });
    expect(settingsRes.statusCode).toBe(200);
    const blockOrderRes = await app.inject({
      method: "PUT",
      url: "/api/daily-briefing/block-order",
      cookies: auth(),
      payload: [{ type: "message" }],
    });
    expect(blockOrderRes.statusCode).toBe(200);
    const blockSettingsRes = await app.inject({
      method: "PUT",
      url: `/api/daily-briefing/block-settings/${memberId}/dadJoke`,
      cookies: auth(),
      payload: { enabled: false, weekdays: ["mon"] },
    });
    expect(blockSettingsRes.statusCode).toBe(200);

    const after = getDb()
      .prepare("SELECT * FROM daily_briefing WHERE id = 'briefing-fence-2'")
      .get();
    expect(after).toEqual(before);
  });

  // ── (6) No trigger binding -> no enqueue ─────────────────────────────────────────────────────

  it("(6) with autoPrintTrigger unbound and morning complete, the trigger evaluation enqueues nothing", () => {
    const triggerMemberId = "member-t015-no-binding";
    const NOW = Date.UTC(2026, 7, 13, 10, 0, 0); // Thursday
    seedMember(triggerMemberId);
    // Deliberately NO updateSettings({ autoPrintTrigger:... }) call — the binding stays unset
    // (null), the FR-018 gate this test targets.

    const db = getDb();
    const nowTs = Date.now();
    const routineId = `routine-${triggerMemberId}`;
    const choreId = `chore-${triggerMemberId}`;
    db.prepare(
      "INSERT INTO routines (id, day_period_id, name, active, created_at, updated_at) VALUES (?, 'morning', 'Morning Routine', 1, ?, ?)"
    ).run(routineId, nowTs, nowTs);
    db.prepare(
      "INSERT INTO chores (id, routine_id, name, sort_order, active, created_at, updated_at) VALUES (?, ?, 'Make bed', 0, 1, ?, ?)"
    ).run(choreId, routineId, nowTs, nowTs);
    db.prepare(
      "INSERT INTO routine_assignments (id, routine_id, member_id, weekdays, active, created_at, updated_at) VALUES (?, ?, ?, '[\"thu\"]', 1, ?, ?)"
    ).run(`assign-${triggerMemberId}`, routineId, triggerMemberId, nowTs, nowTs);
    db.prepare(
      "INSERT INTO chore_completions (id, chore_id, member_id, date, completed_at) VALUES (?, ?, ?, '2026-08-13', ?)"
    ).run(`${choreId}-completion`, choreId, triggerMemberId, nowTs);
    // No raster row seeded either (mutation-hardening precedent, tests/integration/
    // daily-briefing-trigger.test.ts's "trigger binding absent" test): a raster row seeded here
    // would let a mutation that reorders/removes the binding gate slip through undetected, since
    // "raster present" alone already forces 0 jobs. Asserting the raster-missing log NEVER fires
    // is what actually proves the binding gate short-circuits BEFORE the raster check is reached
    // — without it, this test is vacuous: `hasPrintableRaster` alone already forces 0 jobs
    // whether or not the binding gate exists at all.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    evaluateAutoPrintTrigger(NOW);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();

    const jobCount = db
      .prepare("SELECT COUNT(*) AS n FROM print_jobs WHERE output_ref = ?")
      .get(`daily-briefing:${triggerMemberId}:2026-08-13`) as { n: number };
    expect(jobCount.n).toBe(0);
  });
});
