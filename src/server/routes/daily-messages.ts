import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  upsertMessage,
  getMessage,
  listMessages,
  deleteMessage,
  DailyMessageValidationError,
  DailyMessageNotFoundError,
} from "../modules/daily-messages/index";
import { MemberReferenceError } from "../modules/members/referential";
import type { DailyMessageUpsert } from "../../shared";

const ALLOWED_UPSERT_KEYS = new Set(["memberId", "date", "text"]);

/** Thin daily-messages route handlers — PUT /api/daily-messages (upsert), GET
 * /api/daily-messages (window list), DELETE /api/daily-messages (idempotent delete), and
 * GET /api/daily-messages/current (outbound single read).
 */
export async function dailyMessagesRoutes(app: FastifyInstance): Promise<void> {
  // PUT /api/daily-messages — create or replace the message for (memberId, date)
  app.put("/api/daily-messages", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return reply
        .code(400)
        .send({ error: "validation_error", message: "Request body must be an object" });
    }
    const unknownKeys = Object.keys(body).filter((key) => !ALLOWED_UPSERT_KEYS.has(key));
    if (unknownKeys.length > 0) {
      return reply.code(400).send({
        error: "validation_error",
        message: `Unsupported field(s) in daily message body: ${unknownKeys.join(", ")}`,
      });
    }
    const { memberId, date, text } = body as DailyMessageUpsert;
    try {
      const message = upsertMessage(memberId, date, text);
      return reply.code(200).send(message);
    } catch (err) {
      return handleDailyMessageError(err, reply);
    }
  });

  // GET /api/daily-messages/current?memberId=&date= — outbound single read (live, no snapshot)
  app.get("/api/daily-messages/current", async (request: FastifyRequest, reply: FastifyReply) => {
    const { memberId, date } = request.query as { memberId: string; date: string };
    try {
      const message = getMessage(memberId, date);
      return reply.code(200).send(message);
    } catch (err) {
      return handleDailyMessageError(err, reply);
    }
  });

  // GET /api/daily-messages?memberId=&from=&days= — window list, date-ascending over [from, from+days)
  app.get("/api/daily-messages", async (request: FastifyRequest, reply: FastifyReply) => {
    const { memberId, from, days } = request.query as Record<string, unknown>;
    if (typeof memberId !== "string" || typeof from !== "string" || typeof days !== "string") {
      return reply.code(400).send({
        error: "validation_error",
        message: "memberId, from, and days query parameters are required",
      });
    }
    try {
      const messages = listMessages(memberId, from, Number(days));
      return reply.code(200).send(messages);
    } catch (err) {
      return handleDailyMessageError(err, reply);
    }
  });

  // DELETE /api/daily-messages?memberId=&date= — idempotent delete (missing message or unknown member -> 204 no-op)
  app.delete("/api/daily-messages", async (request: FastifyRequest, reply: FastifyReply) => {
    const { memberId, date } = request.query as Record<string, unknown>;
    if (typeof memberId !== "string" || typeof date !== "string") {
      return reply.code(400).send({
        error: "validation_error",
        message: "memberId and date query parameters are required",
      });
    }
    try {
      deleteMessage(memberId, date);
      return reply.code(204).send();
    } catch (err) {
      return handleDailyMessageError(err, reply);
    }
  });
}

function handleDailyMessageError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof DailyMessageNotFoundError) {
    return reply.code(404).send({ error: "not_found", message: err.message });
  }
  if (err instanceof MemberReferenceError || err instanceof DailyMessageValidationError) {
    return reply.code(400).send({ error: "validation_error", message: err.message });
  }
  console.error("Unexpected error in daily-messages handler:", err);
  return reply.code(500).send({ error: "internal_error", message: "An unexpected error occurred" });
}
