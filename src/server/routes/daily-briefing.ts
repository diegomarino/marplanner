import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  DailyBriefingValidationError,
  generateBriefing,
  listOptIns,
  readBriefing,
  readBriefingPng,
  setOptIn,
} from "../modules/daily-briefing/index";
import { DAILY_BRIEFING_JOB_ID } from "../modules/daily-briefing/job";
import {
  CorpusLanguageUnavailableError,
  readAllSettings,
  updateSettings,
  writeBlockOrder,
  writeMemberBlockSettings,
} from "../modules/daily-briefing/settings";
import { setMemberSchedule } from "../modules/daily-briefing/schedule";
import { isStrictCalendarDate, runJobNow } from "../host-api";
import type { Briefing, GenerateAllResponse } from "../../shared";

const ALLOWED_GENERATE_KEYS = new Set(["memberId", "date"]);
const ALLOWED_GENERATE_ALL_KEYS = new Set(["date"]);
const ALLOWED_OPT_IN_KEYS = new Set(["enabled"]);
const ALLOWED_SETTINGS_KEYS = new Set(["generationTime", "autoPrintTrigger"]);
const ALLOWED_BLOCK_SETTINGS_KEYS = new Set(["enabled", "weekdays", "params"]);
const ALLOWED_SCHEDULE_KEYS = new Set(["weekdays"]);

/** Thin HTTP boundary for the assembly seam's generate and pure-read routes. */
export async function dailyBriefingRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/daily-briefing/generate", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return reply
        .code(400)
        .send({ error: "validation_error", message: "Request body must be an object" });
    }

    const unknownKeys = Object.keys(body).filter((key) => !ALLOWED_GENERATE_KEYS.has(key));
    if (unknownKeys.length > 0) {
      return reply.code(400).send({
        error: "validation_error",
        message: `Unsupported field(s) in daily briefing generate body: ${unknownKeys.join(", ")}`,
      });
    }

    const { memberId, date } = body as { memberId?: unknown; date?: unknown };
    if (
      typeof memberId !== "string" ||
      (date !== undefined && date !== null && typeof date !== "string")
    ) {
      return reply.code(400).send({
        error: "validation_error",
        message: "memberId is required and date must be a string",
      });
    }

    try {
      return reply.code(200).send(await generateBriefing(memberId, date ?? undefined));
    } catch (err) {
      return handleDailyBriefingError(err, reply);
    }
  });

  app.post(
    "/api/daily-briefing/generate-all",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body === undefined ? {} : request.body;
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return reply
          .code(400)
          .send({ error: "validation_error", message: "Request body must be an object" });
      }
      const unknownKeys = Object.keys(body).filter((key) => !ALLOWED_GENERATE_ALL_KEYS.has(key));
      if (unknownKeys.length > 0) {
        return reply.code(400).send({
          error: "validation_error",
          message: `Unsupported field(s) in daily briefing generate-all body: ${unknownKeys.join(", ")}`,
        });
      }
      const { date } = body as { date?: unknown };
      if (date !== undefined && date !== null && typeof date !== "string") {
        return reply.code(400).send({
          error: "validation_error",
          message: "date must be a string",
        });
      }
      // Validate at the HTTP boundary before the plugin enumerates its own opt-in
      // rows, so zero candidates cannot accidentally turn an invalid date into a
      // successful empty generation.
      if (typeof date === "string" && !isStrictCalendarDate(date)) {
        return reply.code(400).send({
          error: "validation_error",
          message: `Invalid date "${date}"`,
        });
      }

      try {
        // Re-pointed through the scheduler's shared in-flight guard
        // (US2, ADR-014): the manual call and the scheduled/
        // catch-up wall-clock fire funnel through the SAME job id, so a
        // collision with either one is honestly reported instead of racing
        // a second generation. `runJobNow` never REJECTS (scheduler
        // containment, `executeGuarded`), but a throw from the action
        // — e.g. a candidate whose validation fails between enumeration and
        // generation — IS surfaced to this manual caller as a typed
        // `{status:"failed", error}` result (follow-up), handled the
        // same way `handleDailyBriefingError` already handles every other
        // action-thrown error below: a `DailyBriefingValidationError` maps
        // to 400; other failures map to the opaque 500 `internal_error`.
        const result = await runJobNow(DAILY_BRIEFING_JOB_ID, { date: date ?? undefined });
        if (result.status === "already_running") {
          return reply.code(200).send({ status: "already_running" } satisfies GenerateAllResponse);
        }
        if (result.status === "failed") {
          return handleDailyBriefingError(result.error, reply);
        }
        const generated = result.result;
        if (!Array.isArray(generated)) {
          // Defensive fallback only — `result.status === "completed"` at this point means the
          // action resolved without throwing (a throw is now caught by the "failed" branch
          // above), so `generated` really should be a `Briefing[]` here. Never blindly cast.
          return reply
            .code(500)
            .send({ error: "internal_error", message: "An unexpected error occurred" });
        }
        return reply.code(200).send({
          status: "completed",
          count: generated.length,
          generated: (generated as Briefing[]).map((briefing) => ({
            memberId: briefing.memberId,
            status: briefing.status,
          })),
        } satisfies GenerateAllResponse);
      } catch (err) {
        return handleDailyBriefingError(err, reply);
      }
    }
  );

  app.get("/api/daily-briefing/opt-in", async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      return reply.code(200).send(listOptIns());
    } catch (err) {
      return handleDailyBriefingError(err, reply);
    }
  });

  app.get(
    "/api/daily-briefing/:memberId/:date",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { memberId, date } = request.params as { memberId: string; date: string };
      try {
        return reply.code(200).send(readBriefing(memberId, date));
      } catch (err) {
        return handleDailyBriefingError(err, reply);
      }
    }
  );

  // ── Admin preview (FR-022) ───────────────────────────────────────────────────
  app.get(
    "/api/daily-briefing/:memberId/:date/preview.png",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { memberId, date } = request.params as { memberId: string; date: string };
      try {
        const result = readBriefingPng(memberId, date);
        if (!result.found) {
          return reply
            .code(404)
            .send({ error: "not_found", message: "No briefing for this member/date" });
        }
        if (!result.png) {
          return reply.code(409).send({
            error: "printable_raster_missing",
            message: "This briefing has no stored printable raster",
          });
        }
        return reply.code(200).header("content-type", "image/png").send(result.png);
      } catch (err) {
        return handleDailyBriefingError(err, reply);
      }
    }
  );

  app.put(
    "/api/daily-briefing/opt-in/:memberId",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return reply
          .code(400)
          .send({ error: "validation_error", message: "Request body must be an object" });
      }
      const unknownKeys = Object.keys(body).filter((key) => !ALLOWED_OPT_IN_KEYS.has(key));
      if (unknownKeys.length > 0) {
        return reply.code(400).send({
          error: "validation_error",
          message: `Unsupported field(s) in daily briefing opt-in body: ${unknownKeys.join(", ")}`,
        });
      }
      const { enabled } = body as { enabled?: unknown };
      if (typeof enabled !== "boolean") {
        return reply
          .code(400)
          .send({ error: "validation_error", message: "enabled must be a boolean" });
      }

      const { memberId } = request.params as { memberId: string };
      try {
        return reply.code(200).send(setOptIn(memberId, enabled));
      } catch (err) {
        return handleDailyBriefingError(err, reply);
      }
    }
  );

  // ── Settings layer ( contracts/openapi.planned.yaml) ────────────

  app.get("/api/daily-briefing/settings", async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      return reply.code(200).send(readAllSettings());
    } catch (err) {
      return handleDailyBriefingError(err, reply);
    }
  });

  app.put("/api/daily-briefing/settings", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return reply
        .code(400)
        .send({ error: "validation_error", message: "Request body must be an object" });
    }
    const unknownKeys = Object.keys(body).filter((key) => !ALLOWED_SETTINGS_KEYS.has(key));
    if (unknownKeys.length > 0) {
      return reply.code(400).send({
        error: "validation_error",
        message: `Unsupported field(s) in daily briefing settings body: ${unknownKeys.join(", ")}`,
      });
    }
    const { generationTime, autoPrintTrigger } = body as {
      generationTime?: unknown;
      autoPrintTrigger?: unknown;
    };
    try {
      return reply.code(200).send(updateSettings({ generationTime, autoPrintTrigger }));
    } catch (err) {
      return handleDailyBriefingError(err, reply);
    }
  });

  app.put(
    "/api/daily-briefing/block-order",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return reply.code(200).send({ blockOrder: writeBlockOrder(request.body) });
      } catch (err) {
        return handleDailyBriefingError(err, reply);
      }
    }
  );

  app.put(
    "/api/daily-briefing/block-settings/:memberId/:blockType",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return reply
          .code(400)
          .send({ error: "validation_error", message: "Request body must be an object" });
      }
      const unknownKeys = Object.keys(body).filter((key) => !ALLOWED_BLOCK_SETTINGS_KEYS.has(key));
      if (unknownKeys.length > 0) {
        return reply.code(400).send({
          error: "validation_error",
          message: `Unsupported field(s) in daily briefing block-settings body: ${unknownKeys.join(", ")}`,
        });
      }
      const { enabled, weekdays, params } = body as {
        enabled?: unknown;
        weekdays?: unknown;
        params?: unknown;
      };
      const { memberId, blockType } = request.params as { memberId: string; blockType: string };
      try {
        return reply
          .code(200)
          .send(writeMemberBlockSettings(memberId, blockType, { enabled, weekdays, params }));
      } catch (err) {
        return handleDailyBriefingError(err, reply);
      }
    }
  );

  app.put(
    "/api/daily-briefing/schedule/:memberId",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return reply
          .code(400)
          .send({ error: "validation_error", message: "Request body must be an object" });
      }
      const unknownKeys = Object.keys(body).filter((key) => !ALLOWED_SCHEDULE_KEYS.has(key));
      if (unknownKeys.length > 0) {
        return reply.code(400).send({
          error: "validation_error",
          message: `Unsupported field(s) in daily briefing schedule body: ${unknownKeys.join(", ")}`,
        });
      }
      const { weekdays } = body as { weekdays?: unknown };
      const { memberId } = request.params as { memberId: string };
      try {
        return reply.code(200).send(setMemberSchedule(memberId, weekdays));
      } catch (err) {
        return handleDailyBriefingError(err, reply);
      }
    }
  );
}

function handleDailyBriefingError(err: unknown, reply: FastifyReply): FastifyReply {
  // Checked BEFORE the base class below — CorpusLanguageUnavailableError extends
  // DailyBriefingValidationError, so the subclass check must come first (FR-009's contract-named
  // "400 corpus_language_unavailable" error code).
  if (err instanceof CorpusLanguageUnavailableError) {
    return reply.code(400).send({ error: "corpus_language_unavailable", message: err.message });
  }
  if (err instanceof DailyBriefingValidationError) {
    return reply.code(400).send({ error: "validation_error", message: err.message });
  }
  return reply.code(500).send({ error: "internal_error", message: "An unexpected error occurred" });
}
